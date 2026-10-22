/**
 * T-391 S3 - the item APPLY. docs/tasks/391-production-master-data-load.md, R2, R4, R8, R16, tests 16-20a.
 *
 * Executes the item planner's writes through the domain functions as a named actor (createItem and setItemPurchaseUnit
 * both run the `approve_item` gate), inserts a v1_master_links row for every created or matched record, and writes ONE
 * `master_data_load` audit row per apply. Everything happens in ONE transaction: the org lock first, then the plan (so a
 * second concurrent apply waits, then sees the first one's links and writes nothing), then the writes. A dry run is the
 * same transaction rolled back. Anything held refuses the whole apply before the first write.
 */
import { authorize, type Actor } from '@shareat/auth';
import { apRepo, auditLogRepo, customersRepo, employmentRepo, itemsRepo, masterLinksRepo, organizationsRepo, storesRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { decimal } from '@shareat/core/money';
import { sql as dsql } from 'drizzle-orm';
import {
  createCustomer,
  createEmployment,
  createItem,
  createPerson,
  createSupplier,
  editSupplier,
  setCustomerStatus,
  setItemPurchaseUnit,
  setSupplierCounterpartyStore,
  upsertStorePosition,
} from '@shareat/domain';
import { planParties, type ExistingParty, type PartiesSnapshot, type PartyEntity } from '../../packages/etl/src/master-data/parties-plan';
import { assertRunTarget, selectTargetStores, type StoreMapRow } from '../../packages/etl/src/master-data/store-map';
import { planStaff, type PlannedEmployment, type StaffSnapshot } from '../../packages/etl/src/master-data/staff-plan';
import { planItems, type ExistingItem, type ExistingLink, type ItemsSnapshot, type Row } from '../../packages/etl/src/master-data/items-plan';

export interface ApplyItemsInput {
  snapshot: ItemsSnapshot;
  snapshotSha: string;
  map: readonly StoreMapRow[];
  orgId: string;
  orgCode: string;
  storeCodes?: readonly string[];
  answers: Record<string, Row[]>;
  actor?: Actor;
  apply: boolean;
}
export interface ApplyItemsResult {
  dryRun: boolean;
  created: number;
  linked: number;
  held: number;
}

/** The plan still has rows held for Ian (also when it turned held while this apply waited for the org lock). */
export class HeldError extends Error {
  constructor(
    readonly held: number,
    readonly entity: string = 'items',
    message?: string,
  ) {
    super(message ?? `${entity}: ${held} row(s) are held for Ian. Answer the sheets and run again; nothing was written for ${entity}.`);
  }
}

/** Thrown inside the transaction to roll a dry run back; carries the counts out. */
class DryRunRollback extends Error {
  constructor(readonly result: unknown) {
    super('dry run: rolled back');
  }
}

/** R8: the load never writes as nobody, and never as a person of another organisation than --org (R6, I1). */
function requireActor(fn: string, input: { actor?: Actor; orgId: string }): Actor {
  const { actor } = input;
  if (!actor) throw new Error(`${fn}: an actor is required (--actor <person uuid>). The load never writes as nobody (R8).`);
  if (actor.orgId !== input.orgId) throw new Error(`${fn}: the actor belongs to another organisation than --org. Refused (R6, I1).`);
  return actor;
}

/** One step in its own transaction; a dry run is the same writes, then rolled back (R2). */
async function inOwnTransaction<R>(input: { orgId: string; apply: boolean }, body: (tx: Tx) => Promise<R>): Promise<R> {
  try {
    return await withOrgPrincipal(input.orgId, async (tx) => {
      const result = await body(tx);
      if (!input.apply) throw new DryRunRollback(result);
      return result;
    });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result as R;
    throw e;
  }
}

/** What v2 already holds, in the planner's shape. */
export async function loadItemState(tx: Tx, orgId: string): Promise<{ existing: ExistingItem[]; links: ExistingLink[] }> {
  const rows = await itemsRepo.listItems(tx, orgId, { includeInactive: true });
  const existing = rows.map((i) => ({
    id: i.id,
    name: i.name,
    status: i.status as 'active' | 'inactive' | 'merged',
    baseUnit: i.baseUnit,
    kind: i.kind,
    purchaseUnit: i.purchaseUnit,
    purchaseFactor: i.purchaseFactor,
    // ItemRow does not declare merged_into_id, but listItems selects the whole row, so it is there at runtime
    mergedIntoId: (i as { mergedIntoId?: string | null }).mergedIntoId ?? null,
  }));
  const links = (await masterLinksRepo.linksFor(tx, orgId, 'item')).map((l) => ({
    entity: l.entity as string,
    v1StoreId: l.v1StoreId,
    v1Id: l.v1Id,
    v2Id: l.v2Id,
    v1Unit: l.v1Unit,
    factorToBase: l.factorToBase,
  }));
  return { existing, links };
}

/** The items step inside a transaction the caller owns (R2: a dry run shares one transaction across steps). */
async function itemsBody(tx: Tx, input: ApplyItemsInput, actor: Actor): Promise<ApplyItemsResult> {
  const orgRowCode = (await organizationsRepo.identityOf(tx, input.orgId))?.code ?? '';
  assertRunTarget(input.map, { orgCode: input.orgCode, orgRowCode });
  await authorize(tx, actor, 'approve_item', {}); // refused before the queue: a caller who may not write never waits

  // R16: one apply at a time per org. Taken BEFORE the plan is read, so a waiter plans over the winner's links.
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext('master-data:' || ${input.orgId}::text))`);

  const { existing, links } = await loadItemState(tx, input.orgId);
  const plan = planItems({
    snapshot: input.snapshot,
    map: input.map,
    orgCode: input.orgCode,
    storeCodes: input.storeCodes,
    existing,
    links,
    answers: input.answers,
  });
  if (plan.held > 0) {
    throw new HeldError(plan.held, 'items');
  }

  let created = 0;
  let linked = 0;
  const link = async (itemId: string, l: { v1StoreId: string; v1Id: string; v1Unit: string; factorToBase: number }) => {
    await masterLinksRepo.insertLink(tx, {
      orgId: input.orgId,
      entity: 'item',
      v1StoreId: l.v1StoreId,
      v1Id: l.v1Id,
      v2Id: itemId,
      v1Unit: l.v1Unit,
      factorToBase: decimal(String(l.factorToBase), '14,6'),
      createdBy: actor.personId,
    });
    linked++;
  };
  for (const w of plan.writes) {
    if (w.op === 'create') {
      const { id } = await createItem(tx, actor, { name: w.name, kind: w.kind as never, baseUnit: w.baseUnit as never });
      if (w.purchase) {
        await setItemPurchaseUnit(tx, actor, { itemId: id, purchaseUnit: w.purchase.unit as never, purchaseFactor: String(w.purchase.factor), source: 'etl' });
      }
      created++;
      for (const l of w.links) await link(id, l);
    } else {
      for (const l of w.links) await link(w.itemId, l);
    }
  }

  const stores = selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes }).map((r) => r.storeCode);
  await auditLogRepo.append(tx, input.orgId, {
    actorPersonId: actor.personId,
    action: 'master_data.items_load',
    storeId: null,
    entityId: input.orgId,
    before: null,
    after: { snapshotSha: input.snapshotSha, stores, created, linked, held: plan.held },
    source: 'etl',
  });

  return { dryRun: !input.apply, created, linked, held: plan.held };
}

export async function applyItems(input: ApplyItemsInput): Promise<ApplyItemsResult> {
  const actor = requireActor('applyItems', input);
  return inOwnTransaction(input, (tx) => itemsBody(tx, input, actor));
}


// ---------------------------------------------------------------------------------------------------------------
// T-391 S4 - suppliers and customers. The same transaction shape as applyItems: the actor gate first, the org lock,
// the plan inside the lock, the domain writes, ONE master_data_load audit row, a dry run is the same thing rolled back.
// ---------------------------------------------------------------------------------------------------------------

export interface ApplyPartiesInput extends Omit<ApplyItemsInput, 'snapshot'> {
  snapshot: PartiesSnapshot;
}

/** What v2 already holds of one party entity, in the planner's shape (the columns drift compares included). */
export async function loadPartyState(
  tx: Tx,
  orgId: string,
  entity: PartyEntity,
): Promise<{ existing: ExistingParty[]; links: Array<{ entity: string; v1StoreId: string; v1Id: string; v2Id: string }> }> {
  const existing: ExistingParty[] =
    entity === 'supplier'
      ? (await apRepo.listSuppliers(tx, orgId, { includeInactive: true })).map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          contactNo: r.contactNo,
          address: r.address,
          email: r.email,
          representativeName: r.representativeName,
        }))
      : (await customersRepo.listCustomers(tx, orgId)).map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          contactNo: r.contactNo,
          address: r.address,
        }));
  const links = (await masterLinksRepo.linksFor(tx, orgId, entity)).map((l) => ({
    entity: l.entity as string,
    v1StoreId: l.v1StoreId,
    v1Id: l.v1Id,
    v2Id: l.v2Id,
  }));
  return { existing, links };
}

async function partiesBody(tx: Tx, entity: PartyEntity, input: ApplyPartiesInput, actor: Actor): Promise<ApplyItemsResult> {
  const fn = entity === 'supplier' ? 'applySuppliers' : 'applyCustomers';
  const orgRowCode = (await organizationsRepo.identityOf(tx, input.orgId))?.code ?? '';
  assertRunTarget(input.map, { orgCode: input.orgCode, orgRowCode });
  // refused before the queue: suppliers need approve_supplier, customers manage_chart_of_accounts (R8)
  await authorize(tx, actor, entity === 'supplier' ? 'approve_supplier' : 'manage_chart_of_accounts', {});
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext('master-data:' || ${input.orgId}::text))`);

  const sup = await loadPartyState(tx, input.orgId, 'supplier');
  const cus = await loadPartyState(tx, input.orgId, 'customer');
  const plan = planParties({
    snapshot: input.snapshot,
    map: input.map,
    orgCode: input.orgCode,
    storeCodes: input.storeCodes,
    existingSuppliers: sup.existing,
    existingCustomers: cus.existing,
    links: [...sup.links, ...cus.links],
    answers: input.answers,
  });
  if (plan.held > 0) throw new HeldError(plan.held, entity === 'supplier' ? 'suppliers' : 'customers');

  // `held` is a whole-run count BY DESIGN: a held customer refuses the suppliers apply too.
  // a store link goes through the store map: store_code -> this org's stores.code (P5)
  const storeIdOf = new Map((await storesRepo.listForOrg(tx, input.orgId)).map((s) => [s.code, s.id]));
  const v2StoreFor = (v1StoreId: string | null): string | null => {
    if (!v1StoreId) return null;
    const row = input.map.find((r) => r.v1StoreId === v1StoreId && r.role === 'own' && r.orgCode === input.orgCode);
    const id = row ? storeIdOf.get(row.storeCode) : undefined;
    if (!id) throw new Error(`${fn}: v1 store ${v1StoreId} has no store in org ${input.orgCode}. Refused.`);
    return id;
  };

  let created = 0;
  let linked = 0;
  const link = async (v2Id: string, l: { v1StoreId: string; v1Id: string }) => {
    await masterLinksRepo.insertLink(tx, {
      orgId: input.orgId,
      entity,
      v1StoreId: l.v1StoreId,
      v1Id: l.v1Id,
      v2Id,
      v1Unit: null,
      factorToBase: null,
      createdBy: actor.personId,
    });
    linked++;
  };

  for (const w of plan.writes) {
    if (w.entity !== entity) continue;
    if (w.op === 'link') {
      for (const l of w.links) await link(w.v2Id, l);
      continue;
    }
    if (w.entity === 'supplier') {
      const { id } = await createSupplier(tx, actor, {
        name: w.name,
        address: w.address,
        contactNo: w.contactNo,
        email: w.email,
        representativeName: w.representativeName,
        tin: w.tin,
        vatStatus: w.vatStatus,
        classification: w.classification,
        issuesOfficialReceipt: w.issuesOfficialReceipt,
        creditTermsDays: w.creditTermsDays,
        bankName: w.bankName,
        bankAccountName: w.bankAccountName,
        bankAccountNumber: w.bankAccountNumber,
      });
      const storeId = v2StoreFor(w.counterpartyV1StoreId);
      if (storeId) await setSupplierCounterpartyStore(tx, actor, { supplierId: id, storeId, source: 'etl' });
      if (w.status === 'inactive') await editSupplier(tx, actor, { supplierId: id, status: 'inactive', source: 'etl' });
      created++;
      for (const l of w.links) await link(id, l);
    } else {
      const storeId = v2StoreFor(w.counterpartyV1StoreId);
      const { id } = await createCustomer(tx, actor, {
        name: w.name,
        address: w.address,
        contactNo: w.contactNo,
        customerGroup: w.group,
        counterpartyStoreId: storeId,
      });
      if (w.status === 'inactive') await setCustomerStatus(tx, actor, { customerId: id, status: 'inactive', source: 'etl' });
      created++;
      for (const l of w.links) await link(id, l);
    }
  }

  const stores = selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes }).map((r) => r.storeCode);
  await auditLogRepo.append(tx, input.orgId, {
    actorPersonId: actor.personId,
    action: entity === 'supplier' ? 'master_data.suppliers_load' : 'master_data.customers_load',
    storeId: null,
    entityId: input.orgId,
    before: null,
    after: { snapshotSha: input.snapshotSha, stores, created, linked, held: plan.held },
    source: 'etl',
  });

  return { dryRun: !input.apply, created, linked, held: plan.held };
}

async function applyParties(entity: PartyEntity, input: ApplyPartiesInput): Promise<ApplyItemsResult> {
  const actor = requireActor(entity === 'supplier' ? 'applySuppliers' : 'applyCustomers', input);
  return inOwnTransaction(input, (tx) => partiesBody(tx, entity, input, actor));
}

export const applySuppliers = (input: ApplyPartiesInput): Promise<ApplyItemsResult> => applyParties('supplier', input);
export const applyCustomers = (input: ApplyPartiesInput): Promise<ApplyItemsResult> => applyParties('customer', input);

// ---------------------------------------------------------------------------------------------------------------
// T-391 S5 - positions and staff. The same transaction shape: org lock, the plan inside the lock, the domain writes, ONE
// master_data_load audit row, a dry run is the same thing rolled back. Nothing here grants access: a person is hired
// through createEmployment and holds exactly the hire baseline (S2, I9).
// ---------------------------------------------------------------------------------------------------------------

export interface ApplyStaffInput extends Omit<ApplyItemsInput, 'snapshot'> {
  snapshot: StaffSnapshot;
}

/** What v2 already holds that the staff planner reads. */
export async function loadStaffState(tx: Tx, orgId: string) {
  const links = [
    ...(await masterLinksRepo.linksFor(tx, orgId, 'person')),
    ...(await masterLinksRepo.linksFor(tx, orgId, 'employment')),
  ].map((l) => ({ entity: l.entity as string, v1StoreId: l.v1StoreId, v1Id: l.v1Id, v2Id: l.v2Id }));
  return {
    existingPositions: await employmentRepo.listOrgPositions(tx, orgId),
    existingPersons: await employmentRepo.listOrgPersons(tx, orgId),
    links,
  };
}

async function planStaffIn(tx: Tx, input: ApplyStaffInput) {
  const state = await loadStaffState(tx, input.orgId);
  return planStaff({
    snapshot: input.snapshot,
    map: input.map,
    orgCode: input.orgCode,
    storeCodes: input.storeCodes,
    ...state,
    answers: input.answers,
  });
}

/**
 * store_code -> v2 store id for the stores in scope that exist in the org. A map store with no v2 store is not an error
 * until a write needs it (`storeFor`), so an items-only org still runs the whole load with nothing to hire.
 */
async function scopeStoreIds(tx: Tx, input: ApplyStaffInput): Promise<Map<string, string>> {
  const byCode = new Map((await storesRepo.listForOrg(tx, input.orgId)).map((s) => [s.code, s.id]));
  const out = new Map<string, string>();
  for (const r of selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes })) {
    const id = byCode.get(r.storeCode);
    if (id) out.set(r.storeCode, id);
  }
  return out;
}

function storeFor(stores: ReadonlyMap<string, string>, code: string, orgCode: string): string {
  const id = stores.get(code);
  if (!id) throw new Error(`Store ${code} is in stores.csv but not in org ${orgCode}. Refused.`);
  return id;
}

/** enrol_staff at EVERY store in scope, before anything is written (R8). */
/**
 * A load with no v1 staff record in scope has nothing to hire and no position to create, so it asks nothing of the staff
 * capabilities: an items-and-parties-only run by someone with no store scope is not refused for staff it does not touch.
 */
function hasStaffInScope(input: ApplyStaffInput): boolean {
  const scope = new Set(selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes }).map((r) => r.v1StoreId));
  return (input.snapshot.staff ?? []).some((x) => scope.has(x.store));
}

async function authorizeAtEveryStore(tx: Tx, actor: Actor, capability: 'manage_store_settings' | 'enrol_staff', stores: ReadonlyMap<string, string>, input: ApplyStaffInput): Promise<void> {
  if (!hasStaffInScope(input)) return;
  for (const storeId of stores.values()) await authorize(tx, actor, capability, { storeId });
}

async function authorizeEnrolAtEveryStore(tx: Tx, actor: Actor, stores: ReadonlyMap<string, string>, input: ApplyStaffInput): Promise<void> {
  await authorizeAtEveryStore(tx, actor, 'enrol_staff', stores, input);
}

async function positionsBody(tx: Tx, input: ApplyStaffInput, actor: Actor): Promise<ApplyItemsResult> {
  const orgRowCode = (await organizationsRepo.identityOf(tx, input.orgId))?.code ?? '';
  assertRunTarget(input.map, { orgCode: input.orgCode, orgRowCode });
  const stores = await scopeStoreIds(tx, input);
  await authorizeAtEveryStore(tx, actor, 'manage_store_settings', stores, input);
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext('master-data:' || ${input.orgId}::text))`);

  const plan = await planStaffIn(tx, input);
  if (plan.held > 0) throw new HeldError(plan.held, 'positions');

  let created = 0;
  for (const w of plan.writes) {
    if (w.entity !== 'position') continue;
    await upsertStorePosition(tx, actor, { storeId: storeFor(stores, w.storeCode, input.orgCode), name: w.name }); // manage_store_settings at that store
    created++;
  }
  await auditLogRepo.append(tx, input.orgId, {
    actorPersonId: actor.personId,
    action: 'master_data.positions_load',
    storeId: null,
    entityId: input.orgId,
    before: null,
    after: { snapshotSha: input.snapshotSha, stores: [...stores.keys()], created, linked: 0, held: plan.held },
    source: 'etl',
  });
  return { dryRun: !input.apply, created, linked: 0, held: plan.held };
}

async function staffBody(tx: Tx, input: ApplyStaffInput, actor: Actor): Promise<ApplyItemsResult> {
  const orgRowCode = (await organizationsRepo.identityOf(tx, input.orgId))?.code ?? '';
  assertRunTarget(input.map, { orgCode: input.orgCode, orgRowCode });
  const stores = await scopeStoreIds(tx, input);
  await authorizeEnrolAtEveryStore(tx, actor, stores, input); // refused before the queue and before the first write
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext('master-data:' || ${input.orgId}::text))`);

  const plan = await planStaffIn(tx, input);
  if (plan.held > 0) throw new HeldError(plan.held, 'staff');

  const positions = await employmentRepo.listOrgPositions(tx, input.orgId);
  const positionId = (storeCode: string, name: string): string => {
    const k = name.trim().toLowerCase();
    const hit =
      positions.find((p) => p.storeCode === storeCode && p.name.trim().toLowerCase() === k) ??
      positions.find((p) => p.storeCode === null && p.name.trim().toLowerCase() === k);
    if (!hit) throw new Error(`Position "${name}" does not exist at ${storeCode}. Apply the positions step first (--only positions).`);
    return hit.id;
  };

  let linked = 0;
  const link = async (entity: 'person' | 'employment', l: { v1StoreId: string; v1Id: string }, v2Id: string): Promise<void> => {
    await masterLinksRepo.insertLink(tx, {
      orgId: input.orgId,
      entity,
      v1StoreId: l.v1StoreId,
      v1Id: l.v1Id,
      v2Id,
      v1Unit: null,
      factorToBase: null,
      createdBy: actor.personId,
    });
    linked++;
  };

  // persons first, then their employments; v2 numbers every hire itself (T-464: no staff code is carried over from v1)
  const people: Array<{ personId: string; employments: PlannedEmployment[] }> = [];
  for (const w of plan.writes) {
    if (w.entity !== 'person') continue;
    let personId: string;
    if (w.op === 'create') {
      const first = w.employments[0]!;
      personId = (await createPerson(tx, actor, { storeId: storeFor(stores, first.storeCode, input.orgCode), displayName: w.fullName })).id;
    } else {
      personId = w.personId;
    }
    for (const l of w.personLinks) await link('person', l, personId);
    people.push({ personId, employments: w.employments });
  }
  let created = 0;
  {
    for (const p of people) {
      for (const e of p.employments) {
        const ids = e.positions.map((n) => positionId(e.storeCode, n));
        const emp = await createEmployment(tx, actor, {
          storeId: storeFor(stores, e.storeCode, input.orgCode),
          personId: p.personId,
          employmentStatus: e.employmentStatus as never,
          startedOn: e.startedOn,
          ...(ids.length > 0 ? { positionIds: ids, primaryPositionId: positionId(e.storeCode, e.primaryPosition!) } : {}),
          source: 'etl',
        });
        created++;
        await link('employment', { v1StoreId: e.v1StoreId, v1Id: e.v1StaffId }, emp.id);
      }
    }
  }

  await auditLogRepo.append(tx, input.orgId, {
    actorPersonId: actor.personId,
    action: 'master_data.staff_load',
    storeId: null,
    entityId: input.orgId,
    before: null,
    after: { snapshotSha: input.snapshotSha, stores: [...stores.keys()], created, linked, held: plan.held },
    source: 'etl',
  });
  return { dryRun: !input.apply, created, linked, held: plan.held };
}

export async function applyPositions(input: ApplyStaffInput): Promise<ApplyItemsResult> {
  const actor = requireActor('applyPositions', input);
  return inOwnTransaction(input, (tx) => positionsBody(tx, input, actor));
}
export async function applyStaff(input: ApplyStaffInput): Promise<ApplyItemsResult> {
  const actor = requireActor('applyStaff', input);
  return inOwnTransaction(input, (tx) => staffBody(tx, input, actor));
}

// ---------------------------------------------------------------------------------------------------------------
// The whole load in R3 order (positions, items, suppliers, customers, staff). Every entity in scope is authorized UP
// FRONT, so a caller who may not write one of them is refused before the first row of any is written (a manager may
// apply suppliers but not customers; staff need enrol_staff at EVERY store in scope). A dry run shares ONE outer
// transaction across the entities (R2), so staff see the positions the same run planned, and everything is rolled back.
// ---------------------------------------------------------------------------------------------------------------

export type MasterDataEntity = 'positions' | 'items' | 'suppliers' | 'customers' | 'staff';
const ENTITY_ORDER: readonly MasterDataEntity[] = ['positions', 'items', 'suppliers', 'customers', 'staff'];
const ENTITY_CAPABILITY = {
  items: 'approve_item',
  suppliers: 'approve_supplier',
  customers: 'manage_chart_of_accounts',
} as const;

export interface ApplyMasterDataInput extends Omit<ApplyItemsInput, 'snapshot'> {
  snapshot: ItemsSnapshot & PartiesSnapshot & StaffSnapshot;
  only?: readonly string[];
}

export async function applyMasterData(input: ApplyMasterDataInput): Promise<Partial<Record<MasterDataEntity, ApplyItemsResult>>> {
  const actor = requireActor('applyMasterData', input);
  for (const n of input.only ?? []) {
    if (!(ENTITY_ORDER as readonly string[]).includes(n)) {
      throw new Error(`applyMasterData: unknown entity "${n}" in only. Allowed: ${ENTITY_ORDER.join(', ')}.`);
    }
  }
  const wanted = input.only ? ENTITY_ORDER.filter((x) => input.only!.includes(x)) : [...ENTITY_ORDER];
  await withOrgPrincipal(input.orgId, async (tx) => {
    for (const x of wanted) {
      if (x === 'positions') await authorizeAtEveryStore(tx, actor, 'manage_store_settings', await scopeStoreIds(tx, input), input);
      else if (x === 'staff') await authorizeEnrolAtEveryStore(tx, actor, await scopeStoreIds(tx, input), input);
      else await authorize(tx, actor, ENTITY_CAPABILITY[x], {});
    }
  });
  const step = (tx: Tx, x: MasterDataEntity): Promise<ApplyItemsResult> =>
    x === 'positions'
      ? positionsBody(tx, input, actor)
      : x === 'items'
        ? itemsBody(tx, input, actor)
        : x === 'suppliers'
          ? partiesBody(tx, 'supplier', input, actor)
          : x === 'customers'
            ? partiesBody(tx, 'customer', input, actor)
            : staffBody(tx, input, actor);

  const out: Partial<Record<MasterDataEntity, ApplyItemsResult>> = {};
  if (!input.apply) {
    try {
      await withOrgPrincipal(input.orgId, async (tx) => {
        for (const x of wanted) out[x] = await step(tx, x);
        throw new DryRunRollback(out);
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    return out;
  }
  // --apply: one transaction per entity (R3); a failure leaves that entity untouched and stops the run
  for (const x of wanted) {
    try {
      out[x] =
        x === 'positions'
          ? await applyPositions(input)
          : x === 'items'
            ? await applyItems(input)
            : x === 'suppliers'
              ? await applySuppliers(input)
              : x === 'customers'
                ? await applyCustomers(input)
                : await applyStaff(input);
    } catch (e) {
      const done = Object.entries(out);
      if (done.length > 0 && e instanceof HeldError) {
        const counts = done.map(([n, r]) => `${n}: created ${r.created}, linked ${r.linked}`).join('; ');
        throw new HeldError(
          e.held,
          x,
          `applyMasterData: ${x} is held (${e.held} row(s) for Ian). Already committed: ${counts}. Answer the sheets and rerun to finish; nothing of ${x} was written.`,
        );
      }
      if (done.length > 0 && e instanceof Error) {
        // S14b: earlier entities are already committed; say so, so a late refusal is never read as "nothing happened"
        const counts = done.map(([n, r]) => `${n}: created ${r.created}, linked ${r.linked}`).join('; ');
        e.message = `Already committed: ${counts}. ${x} was refused: ${e.message}. Fix it, then rerun to finish: committed entities write nothing twice.`;
      }
      throw e;
    }
  }
  return out;
}

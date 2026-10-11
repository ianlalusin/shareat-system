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
import { apRepo, auditLogRepo, customersRepo, itemsRepo, masterLinksRepo, organizationsRepo, storesRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { decimal } from '@shareat/core/money';
import { sql as dsql } from 'drizzle-orm';
import { createCustomer, createItem, createSupplier, editSupplier, setCustomerStatus, setItemPurchaseUnit, setSupplierCounterpartyStore } from '@shareat/domain';
import { planParties, type ExistingParty, type PartiesSnapshot, type PartyEntity } from '../../packages/etl/src/master-data/parties-plan';
import { assertRunTarget, selectTargetStores, type StoreMapRow } from '../../packages/etl/src/master-data/store-map';
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
  constructor(readonly held: number, message?: string) {
    super(message ?? `applyItems: ${held} row(s) are held for Ian. Answer the sheets and run again; nothing was written.`);
  }
}

/** Thrown inside the transaction to roll a dry run back; carries the counts out. */
class DryRunRollback extends Error {
  constructor(readonly result: ApplyItemsResult) {
    super('dry run: rolled back');
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

export async function applyItems(input: ApplyItemsInput): Promise<ApplyItemsResult> {
  const { actor } = input;
  if (!actor) throw new Error('applyItems: an actor is required (--actor <person uuid>). The load never writes as nobody (R8).');
  if (actor.orgId !== input.orgId) {
    throw new Error(`applyItems: the actor belongs to another organisation than --org. Refused (R6, I1).`);
  }

  const body = async (tx: Tx): Promise<ApplyItemsResult> => {
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
      throw new HeldError(plan.held);
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
      action: 'master_data_load',
      entity: 'items',
      entityId: input.orgId,
      before: null,
      after: { snapshotSha: input.snapshotSha, stores, created, linked, held: plan.held },
      source: 'etl',
    });

    const result = { dryRun: !input.apply, created, linked, held: plan.held };
    if (!input.apply) throw new DryRunRollback(result); // R2: the same writes, then rolled back
    return result;
  };

  try {
    return await withOrgPrincipal(input.orgId, body);
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  }
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

async function applyParties(entity: PartyEntity, input: ApplyPartiesInput): Promise<ApplyItemsResult> {
  const fn = entity === 'supplier' ? 'applySuppliers' : 'applyCustomers';
  const { actor } = input;
  if (!actor) throw new Error(`${fn}: an actor is required (--actor <person uuid>). The load never writes as nobody (R8).`);
  if (actor.orgId !== input.orgId) {
    throw new Error(`${fn}: the actor belongs to another organisation than --org. Refused (R6, I1).`);
  }

  const body = async (tx: Tx): Promise<ApplyItemsResult> => {
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
    // `held` is a whole-run count BY DESIGN: a held customer refuses the suppliers apply too.
    if (plan.held > 0) throw new HeldError(plan.held);

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
      action: 'master_data_load',
      entity: entity === 'supplier' ? 'suppliers' : 'customers',
      entityId: input.orgId,
      before: null,
      after: { snapshotSha: input.snapshotSha, stores, created, linked, held: plan.held },
      source: 'etl',
    });

    const result = { dryRun: !input.apply, created, linked, held: plan.held };
    if (!input.apply) throw new DryRunRollback(result);
    return result;
  };

  try {
    return await withOrgPrincipal(input.orgId, body);
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  }
}

export const applySuppliers = (input: ApplyPartiesInput): Promise<ApplyItemsResult> => applyParties('supplier', input);
export const applyCustomers = (input: ApplyPartiesInput): Promise<ApplyItemsResult> => applyParties('customer', input);

// ---------------------------------------------------------------------------------------------------------------
// The whole load in R3 order. Every entity in scope is authorized UP FRONT, so a caller who may not write one of them
// is refused before the first row of any is written (a manager may apply suppliers but not customers).
// ---------------------------------------------------------------------------------------------------------------

export type MasterDataEntity = 'items' | 'suppliers' | 'customers';
const ENTITY_CAPABILITY: Record<MasterDataEntity, 'approve_item' | 'approve_supplier' | 'manage_chart_of_accounts'> = {
  items: 'approve_item',
  suppliers: 'approve_supplier',
  customers: 'manage_chart_of_accounts',
};

export interface ApplyMasterDataInput extends Omit<ApplyItemsInput, 'snapshot'> {
  snapshot: ItemsSnapshot & PartiesSnapshot;
  only?: readonly string[];
}

export async function applyMasterData(input: ApplyMasterDataInput): Promise<Partial<Record<MasterDataEntity, ApplyItemsResult>>> {
  const { actor } = input;
  if (!actor) throw new Error('applyMasterData: an actor is required (--actor <person uuid>). The load never writes as nobody (R8).');
  if (actor.orgId !== input.orgId) throw new Error('applyMasterData: the actor belongs to another organisation than --org. Refused (R6, I1).');
  const order: MasterDataEntity[] = ['items', 'suppliers', 'customers'];
  for (const n of input.only ?? []) {
    if (!(order as string[]).includes(n)) throw new Error(`applyMasterData: unknown entity "${n}" in only. Allowed: ${order.join(', ')}.`);
  }
  const wanted = input.only ? order.filter((x) => input.only!.includes(x)) : order;
  await withOrgPrincipal(input.orgId, async (tx) => {
    for (const x of wanted) await authorize(tx, actor, ENTITY_CAPABILITY[x], {});
  });
  const out: Partial<Record<MasterDataEntity, ApplyItemsResult>> = {};
  for (const x of wanted) {
    try {
      out[x] = x === 'items' ? await applyItems(input) : x === 'suppliers' ? await applySuppliers(input) : await applyCustomers(input);
    } catch (e) {
      if (e instanceof HeldError && Object.keys(out).length > 0) {
        const done = Object.entries(out).map(([n, r]) => `${n}: created ${r.created}, linked ${r.linked}`).join('; ');
        throw new HeldError(
          e.held,
          `applyMasterData: ${x} is held (${e.held} row(s) for Ian). Already committed: ${done}. Answer the sheets and rerun to finish; nothing of ${x} was written.`,
        );
      }
      throw e;
    }
  }
  return out;
}

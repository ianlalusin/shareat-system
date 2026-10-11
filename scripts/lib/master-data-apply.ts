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
import { auditLogRepo, itemsRepo, masterLinksRepo, organizationsRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { decimal } from '@shareat/core/money';
import { sql as dsql } from 'drizzle-orm';
import { createItem, setItemPurchaseUnit } from '@shareat/domain';
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
  constructor(readonly held: number) {
    super(`applyItems: ${held} row(s) are held for Ian. Answer the sheets and run again; nothing was written.`);
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


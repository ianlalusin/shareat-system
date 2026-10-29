/**
 * T-391 S6 - the per-store READINESS report. docs/tasks/391-production-master-data-load.md, S6/S8 (row 303, q12). READ-ONLY.
 * The caller's transaction is already open under withOrgPrincipal; this never opens its own, writes no row and no audit row.
 */
import { authorize, canAt, type Actor } from '@shareat/auth';
import { storeReadinessRepo, storesRepo, type Tx } from '@shareat/db';
import { assertClosedStoresExcluded, selectTargetStores, type StoreMapRow } from '../../packages/etl/src/master-data/store-map';

export type ReadinessReason = 'no_pos_link' | 'no_cash_account' | 'no_encoder' | 'no_verifier' | 'encoder_is_verifier';
export interface ReadinessPerson {
  personId: string;
  displayName: string;
}
export interface StoreReadiness {
  storeCode: string;
  storeId: string;
  ready: boolean;
  reasons: ReadinessReason[];
  posLinked: boolean;
  cashAccount: boolean;
  encoders: ReadinessPerson[];
  verifiers: ReadinessPerson[];
  loaded: { items: number; suppliers: number; customers: number; staff: number; positions: number };
  planned?: { staff: number };
}
export interface ReadinessInput {
  orgId: string;
  orgCode: string;
  map: readonly StoreMapRow[];
  storeCodes?: readonly string[];
  snapshot?: { staff?: { store: string; isActive?: boolean; employmentStatus?: string }[] };
}

const ENCODER_CAPABILITIES = ['create_expense', 'receive_delivery'] as const;
const ENDED = new Set(['resigned', 'terminated', 'inactive']);
const byName = (a: ReadinessPerson, b: ReadinessPerson): number => a.displayName.localeCompare(b.displayName) || a.personId.localeCompare(b.personId);

export async function readiness(tx: Tx, actor: Actor, input: ReadinessInput): Promise<{ orgId: string; stores: StoreReadiness[] }> {
  assertClosedStoresExcluded(input.map); // T-454: before any database read
  let targets: StoreMapRow[];
  try {
    targets = [...selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes })];
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} Refused: the report covers one organisation's stores of the store map.`);
  }
  if (input.storeCodes && input.storeCodes.length > 0) {
    const order = input.storeCodes.map((c) => c.trim());
    targets.sort((a, b) => order.indexOf(a.storeCode) - order.indexOf(b.storeCode));
  }
  const ids = new Map((await storesRepo.listForOrg(tx, input.orgId)).map((s) => [s.code, s.id]));
  const scoped = targets.map((t) => {
    const storeId = ids.get(t.storeCode);
    if (!storeId) throw new Error(`Store ${t.storeCode} is in stores.csv but not in org ${input.orgCode}. Refused.`);
    return { row: t, storeId };
  });
  for (const s of scoped) await authorize(tx, actor, 'manage_store_settings', { storeId: s.storeId }); // every store in scope, before any report data (employees, links, counts) is read; only the map and the store ids are read above

  const stores: StoreReadiness[] = [];
  for (const { row, storeId } of scoped) {
    const facts = await storeReadinessRepo.storeFacts(tx, input.orgId, storeId);
    const links = await storeReadinessRepo.linkCountsForV1Store(tx, input.orgId, row.v1StoreId);
    const encoders: ReadinessPerson[] = []; // an open employee for whom authorize() would pass BOTH capabilities at this store (canAt shares its decision)
    for (const p of facts.employees) {
      let both = true;
      for (const c of ENCODER_CAPABILITIES) both = both && (await canAt(tx, p.personId, c, storeId));
      if (both) encoders.push(p);
    }
    encoders.sort(byName);
    const verifiers = [...facts.managers].sort(byName);
    const reasons: ReadinessReason[] = [];
    if (!facts.posLinked) reasons.push('no_pos_link');
    if (!facts.cashAccount) reasons.push('no_cash_account');
    if (encoders.length === 0) reasons.push('no_encoder');
    if (verifiers.length === 0) reasons.push('no_verifier');
    if (encoders.length > 0 && verifiers.length > 0 && !encoders.some((e) => verifiers.some((v) => v.personId !== e.personId))) reasons.push('encoder_is_verifier');
    const out: StoreReadiness = {
      storeCode: row.storeCode,
      storeId,
      ready: reasons.length === 0,
      reasons,
      posLinked: facts.posLinked,
      cashAccount: facts.cashAccount,
      encoders,
      verifiers,
      loaded: { items: links.item ?? 0, suppliers: links.supplier ?? 0, customers: links.customer ?? 0, staff: facts.openEmployments, positions: links.position ?? 0 },
    };
    if (input.snapshot) {
      out.planned = {
        staff: (input.snapshot.staff ?? []).filter((x) => x.store === row.v1StoreId && x.isActive !== false && !ENDED.has(String(x.employmentStatus ?? '').toLowerCase())).length,
      };
    }
    stores.push(out);
  }
  return { orgId: input.orgId, stores };
}

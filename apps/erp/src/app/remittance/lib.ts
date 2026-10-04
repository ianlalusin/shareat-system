/**
 * Server-only helpers for the remittance screens. T-143, bible row 157.
 *
 * ⭐ Every figure here is DERIVED. `endDayReports` asks the ledger what the cashier actually holds
 * on each date — it does not sum document types, so a document type nobody has invented yet is
 * already counted.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { eq } from 'drizzle-orm';
import { moneyAccountsRepo, remittanceRepo, schema, storesRepo, type EndDayReport } from '@shareat/db';
import { listFindings, remittanceStateOf } from '@shareat/domain';
import { authorize, AuthorizationError, heldCapabilities, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface DayRow extends EndDayReport {
  state: 'nothing_owed' | 'unremitted' | 'partially_remitted' | 'remitted';
}

/**
 * T-366 S3 audit round 3 finding 4 — which store to land on when the URL names none.
 * `listStores` (above) is every store in the ORG, unfiltered, ordered by name; picking its first
 * entry put a manager scoped only to store B onto store A's empty screen. This picks, in order:
 * the first candidate the viewer holds `accept_remittance` at (can act), else the first they are
 * merely scoped to (is scoped — they should still land on their own store's read-only view), else
 * `undefined` so the caller falls back to the org's first store (nothing better to prefer — an
 * org-wide admin with no explicit scope row, or an org with no scope rows at all).
 */
export async function defaultStoreFor(actor: Actor, candidateStoreIds: string[]): Promise<string | undefined> {
  if (candidateStoreIds.length === 0) return undefined;
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    if (held.has('accept_remittance')) {
      for (const storeId of candidateStoreIds) {
        try {
          await authorize(tx, actor, 'accept_remittance', { storeId });
          return storeId;
        } catch (err) {
          if (err instanceof AuthorizationError) continue;
          throw err;
        }
      }
    }
    const scoped = await tx
      .select({ storeId: schema.personStoreScope.storeId })
      .from(schema.personStoreScope)
      .where(eq(schema.personStoreScope.personId, actor.personId));
    const scopedIds = new Set(scoped.map((r) => r.storeId));
    return candidateStoreIds.find((id) => scopedIds.has(id));
  });
}

export async function endDays(orgId: string, storeId: string, upTo: string): Promise<DayRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await remittanceRepo.endDayReports(tx, orgId, { storeId, upTo });
    return rows.map((r) => ({ ...r, state: remittanceStateOf(r) }));
  });
}

/** The cashier accounts money can be handed over FROM, with what each holds. */
export async function cashierAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {
      storeId,
      custodian: 'cashier',
    });
    return Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
      })),
    );
  });
}

/** Where it lands. ⚠️ Office only — a remittance runs cashier → office, never the other way. */
export async function officeAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) =>
    moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId, custodian: 'office' }),
  );
}

export async function recentRemittances(orgId: string, storeId?: string) {
  return withOrgPrincipal(orgId, (tx) => remittanceRepo.listRemittances(tx, orgId, storeId));
}

/** ⭐ The list that must not hide (Ian, bible row 147). */
export async function openVariances(orgId: string, storeId?: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await remittanceRepo.listVariances(tx, orgId, 'open', storeId);
    // T-366 S2 / R5: a charge is credited to the cashier account the handover came from. With one
    // account nothing needs choosing; with several the screen asks, so each row carries its own.
    // `storeId` comes from `listVariances`' own join now (T-366 S3 audit finding 5, round 2) — one
    // query, not a getById per row.
    return Promise.all(
      rows.map(async (v) => ({
        ...v,
        fromAccounts: await remittanceRepo.fromAccountsFor(tx, v.remittanceId),
      })),
    );
  });
}

/** T-366 S3 audit round 3 finding 1 — the org-wide count, so the page can say how many more sit
 *  at other stores without listing them (bible row 147). */
export async function openVarianceCountForOrg(orgId: string): Promise<number> {
  return withOrgPrincipal(orgId, (tx) => remittanceRepo.countOpenVariances(tx, orgId));
}

export const STATE_LABEL: Record<string, string> = {
  nothing_owed: 'Nothing owed',
  unremitted: 'Not remitted',
  partially_remitted: 'Partly remitted',
  remitted: 'Remitted',
};

export function today(): string {
  return toBusinessDate();
}

// -------------------------------------------------------------------------------------
// T-152 — the cash-custody policy, and the findings that watch it
// -------------------------------------------------------------------------------------

/** The three T-152 kinds. ⚠️ A store-scoped finding is matched to this store, but an **org-wide**
 *  one (`storeId === null`) is always kept — filtering strictly by store would silently drop it.
 *
 *  ⛔ **T-187 (2026-09-20) FALSIFIED THIS COMMENT'S EXAMPLE, FROM ANOTHER FILE, WITH NO LINE OF THE
 *  CHANGE LANDING HERE.** It used to read *"which `serviceChargeFloatAgeing` always is"*. That
 *  detector was regrouped per store and **now never emits `storeId: null`**, so the null branch is
 *  dead for this kind. The filter is still correct; the example was the part that rotted.
 *
 *  ⚠️ **And a user-visible change rode along, recorded here because it appears in no diff:** this
 *  finding used to show on **every** store's remittance page and now shows only on its own. That is
 *  the point of the regroup, not a regression — but nobody chose it on this screen.
 *
 *  ⭐ Keep the null branch. It is live for any future org-wide kind, and bible row 204 is why the
 *  example is now stated as history rather than as a fact this comment has to maintain. */
const CASH_CUSTODY_KINDS = new Set([
  'unremittedCeilingBreached',
  'remittanceOverdue',
  'serviceChargeFloatAgeing',
]);

/**
 * ⭐ **Flagged means COUNTED, not coloured** (bible row 147).
 *
 * ⚠️ **These are derived on every read**, like every other finding — there is no stored count to
 * go stale. Row 146 records what a cached derived status cost v1: an admin "recompute" button for
 * days stuck on `partially_remitted`.
 */
export async function cashCustodyFindings(orgId: string, storeId: string) {
  const period = today().slice(0, 7);
  return withOrgPrincipal(orgId, async (tx) => {
    const feed = await listFindings(tx, orgId, { period });
    return feed.findings.filter(
      (f) => CASH_CUSTODY_KINDS.has(f.kind) && (f.storeId === null || f.storeId === storeId),
    );
  });
}

export async function storeCashPolicy(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, (tx) => storesRepo.cashPolicy(tx, orgId, storeId));
}

export const CADENCE_LABEL: Record<string, string> = {
  daily: 'Daily',
  every_3_days: 'Every 3 days',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

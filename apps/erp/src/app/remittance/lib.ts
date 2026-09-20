/**
 * Server-only helpers for the remittance screens. T-143, bible row 157.
 *
 * ⭐ Every figure here is DERIVED. `endDayReports` asks the ledger what the cashier actually holds
 * on each date — it does not sum document types, so a document type nobody has invented yet is
 * already counted.
 */
import { moneyAccountsRepo, remittanceRepo, storesRepo, type EndDayReport } from '@shareat/db';
import { listFindings, remittanceStateOf } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface DayRow extends EndDayReport {
  state: 'nothing_owed' | 'unremitted' | 'partially_remitted' | 'remitted';
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
export async function openVariances(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => remittanceRepo.listVariances(tx, orgId, 'open'));
}

export const STATE_LABEL: Record<string, string> = {
  nothing_owed: 'Nothing owed',
  unremitted: 'Not remitted',
  partially_remitted: 'Partly remitted',
  remitted: 'Remitted',
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
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

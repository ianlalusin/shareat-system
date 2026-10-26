/**
 * Server-only helpers for `/payroll`. T-189.
 *
 * ⭐ Everything here is DERIVED on read. A preview computes from `attendance_days` and the rate in
 * force on each day; nothing is cached. ⛔ v1 caches a period and carries `PAYROLL_SNAPSHOT_VERSION`
 * with it — *"forget to bump it and every store keeps being served pay computed by the OLD rules:
 * no error, no visual difference, wrong money."* That cache exists to dodge 375 billed Firestore
 * reads per page load. **Postgres does not have that problem, so the landmine is not ported.**
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { payrollRepo, type PayRunRow, type PayslipRow } from '@shareat/db';
import { derivePeriods, previewPayRun, type PayPeriod, type PayRunPreview } from '@shareat/domain';
import { authorize, type Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../expenses/lib';
import { heldStoresFor } from '../../lib/held-stores';
import { errorMessage } from '@/lib/constraint-messages';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal, listActingPersons } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';
export type { PayRunRow, PayslipRow, PayRunPreview, PayPeriod };
export { derivePeriods, payoutDateFor } from '@shareat/domain';

/** ⚠️ Returns the error rather than throwing: a bad period should render a message, not a 500. */
export async function preview(
  orgId: string,
  actor: { orgId: string; personId: string },
  input: { storeId: string; periodStart: string; periodEnd: string },
): Promise<{ preview: PayRunPreview | null; error: string | null }> {
  try {
    const p = await withOrgPrincipal(orgId, (tx) => previewPayRun(tx, actor, input));
    return { preview: p, error: null };
  } catch (err) {
    return { preview: null, error: errorMessage(err) };
  }
}

/**
 * T-435 / bible row 353 — the stores `actor` may run payroll for (retired ones only where the actor holds a scope row, so a
 * closed branch's final pay stays reachable). NO admin bypass: `authorize` needs a scope row even for an admin.
 */
export async function payrollStoresFor(actor: Actor) {
  return withOrgPrincipal(actor.orgId, (tx) => heldStoresFor(tx, actor, ['run_payroll'], { includeRetired: true }));
}

// ⛔ Every reader below takes the FULL Actor and authorizes `run_payroll` at the store it reads (T-435, bible §15.11: the page
//    filter is one layer, this is the other). A by-id reader authorizes on the ROW's own store, never on one the caller names.
export async function runsFor(actor: Actor, storeId: string): Promise<PayRunRow[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    return payrollRepo.listPayRuns(tx, actor.orgId, { storeId });
  });
}

export async function slipsFor(actor: Actor, runId: string): Promise<PayslipRow[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const run = await payrollRepo.getPayRun(tx, actor.orgId, runId);
    if (!run) return [];
    await authorize(tx, actor, 'run_payroll', { storeId: run.storeId });
    return payrollRepo.listPayslips(tx, runId);
  });
}

export async function rosterFor(actor: Actor, storeId: string) {
  const orgId = actor.orgId;
  return withOrgPrincipal(orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    const roster = await payrollRepo.employmentsForStore(tx, orgId, storeId);
    const today = toBusinessDate();
    return Promise.all(
      roster.map(async (r) => ({
        ...r,
        // `displayName` is the name every other roster reader uses (the T-435 tests read it); `personName` stays for the page.
        displayName: r.personName,
        rate: await payrollRepo.rateInForceOn(tx, orgId, r.id, today),
      })),
    );
  });
}

/**
 * ⭐ The premium settings a run is being computed under, shown on the page.
 *
 * ⚠️ Payroll used to price overtime and holidays from constants in code. They are per-store
 * settings now (T-189b), and a number that decides somebody's pay should be visible on the screen
 * that spends it rather than knowable only by reading a migration.
 */
export async function premiumSettingsFor(actor: Actor, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    const { attendanceConfigRepo } = await import('@shareat/db');
    return attendanceConfigRepo.findLive(tx, storeId);
  });
}

export async function cashAccountsFor(actor: Actor, storeId: string) {
  const orgId = actor.orgId;
  return withOrgPrincipal(orgId, async (tx) => {
    await authorize(tx, actor, 'run_payroll', { storeId });
    const { moneyAccountsRepo } = await import('@shareat/db');
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    // T-486 (DEF-776): a staff float (GL 1120) belongs to one person's cash request; payroll cannot be paid from it.
    // The domain refuses it by name too - the screen is never the only guard.
    return accounts.filter((a) => a.glAccountCode !== '1120');
  });
}

/**
 * ⭐ The store's OWN pay periods for a month — derived from its configuration, not assumed.
 *
 * ⛔ This replaced a hardcoded 1st-to-15th. Ian, 2026-08-31: *"look how payroll dates are
 * configured in v1, it must be configurable."* A store on monthly or weekly periods was being
 * offered a semi-monthly window it does not use.
 */
export function periodsForMonth(
  cfg: { payrollPeriodType: 'monthly' | 'semi_monthly' | 'weekly'; semiMonthlyCutoffDay: number },
  now = new Date(),
): PayPeriod[] {
  return derivePeriods(cfg, Number(toBusinessDate(now).slice(0, 4)), Number(toBusinessDate(now).slice(5, 7)));
}

/** The period containing today, else the first of the month — what the form opens on. */
export function currentPeriod(
  cfg: { payrollPeriodType: 'monthly' | 'semi_monthly' | 'weekly'; semiMonthlyCutoffDay: number },
  now = new Date(),
): PayPeriod {
  const today = toBusinessDate(now);
  const all = periodsForMonth(cfg, now);
  return all.find((p) => today >= p.start && today <= p.end) ?? all[0]!;
}

/** ⚠️ A run's period, as one readable string. Dates only — a period has no time of day. */
export function periodLabel(run: { periodStart: string; periodEnd: string }): string {
  return `${run.periodStart} → ${run.periodEnd}`;
}

/**
 * Server-only helpers for `/payroll`. T-189.
 *
 * ⭐ Everything here is DERIVED on read. A preview computes from `attendance_days` and the rate in
 * force on each day; nothing is cached. ⛔ v1 caches a period and carries `PAYROLL_SNAPSHOT_VERSION`
 * with it — *"forget to bump it and every store keeps being served pay computed by the OLD rules:
 * no error, no visual difference, wrong money."* That cache exists to dodge 375 billed Firestore
 * reads per page load. **Postgres does not have that problem, so the landmine is not ported.**
 */
import { payrollRepo, type PayRunRow, type PayslipRow } from '@shareat/db';
import { previewPayRun, type PayRunPreview } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal, listActingPersons } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';
export type { PayRunRow, PayslipRow, PayRunPreview };

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
    const raw = err instanceof Error ? err.message : String(err);
    return { preview: null, error: raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '') };
  }
}

export async function runsFor(orgId: string, storeId: string): Promise<PayRunRow[]> {
  return withOrgPrincipal(orgId, (tx) => payrollRepo.listPayRuns(tx, orgId, { storeId }));
}

export async function slipsFor(orgId: string, runId: string): Promise<PayslipRow[]> {
  return withOrgPrincipal(orgId, (tx) => payrollRepo.listPayslips(tx, runId));
}

export async function rosterFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const roster = await payrollRepo.employmentsForStore(tx, orgId, storeId);
    const today = new Date().toISOString().slice(0, 10);
    return Promise.all(
      roster.map(async (r) => ({
        ...r,
        rate: await payrollRepo.rateInForceOn(tx, orgId, r.id, today),
      })),
    );
  });
}

export async function cashAccountsFor(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const { moneyAccountsRepo } = await import('@shareat/db');
    return moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
  });
}

/**
 * The default period: the **first half of the current month**, in ISO dates.
 *
 * ⚠️ Semi-monthly is the Philippine norm and what v1's frequency table assumes. It is a starting
 * value on a form, never a rule — the user picks the actual bounds.
 */
export function defaultPeriod(now = new Date()): { start: string; end: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return { start: `${y}-${m}-01`, end: `${y}-${m}-15` };
}

/** ⚠️ A run's period, as one readable string. Dates only — a period has no time of day. */
export function periodLabel(run: { periodStart: string; periodEnd: string }): string {
  return `${run.periodStart} → ${run.periodEnd}`;
}

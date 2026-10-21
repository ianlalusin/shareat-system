import { sql as dsql } from 'drizzle-orm';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { addMinimumWage, addStatutoryRate, addWithholdingBracketSet, confirmMinimumWage, confirmStatutoryRate, confirmWithholdingBracketSet } from '@shareat/domain';

/**
 * T-190 - test-only fixture. A pay run now REFUSES without confirmed statutory tables, so any test that posts or previews payroll
 * seeds them first. Goes through the domain functions (an admin holding `manage_payroll_rates`), never raw SQL.
 * Persons without government numbers keep the pre-T-190 amounts (the skip rule), so existing figures do not move.
 */
const BRACKETS: Record<'monthly' | 'semi_monthly' | 'weekly', { over: string; baseTax: string; rate: string }[]> = {
  semi_monthly: [['0', '0', '0'], ['10417', '0', '0.15'], ['16667', '937.50', '0.20'], ['33333', '4270.70', '0.25'], ['83333', '16770.70', '0.30'], ['333333', '91770.70', '0.35']].map(([over, baseTax, rate]) => ({ over: over!, baseTax: baseTax!, rate: rate! })),
  monthly: [['0', '0', '0'], ['20833', '0', '0.15'], ['33333', '2500', '0.20'], ['66667', '10833.33', '0.25'], ['166667', '40833.33', '0.30'], ['666667', '200833.33', '0.35']].map(([over, baseTax, rate]) => ({ over: over!, baseTax: baseTax!, rate: rate! })),
  weekly: [['0', '0', '0'], ['4808', '0', '0.15'], ['7692', '432.60', '0.20'], ['15385', '1971.20', '0.25'], ['38462', '7740.45', '0.30'], ['153846', '42355.65', '0.35']].map(([over, baseTax, rate]) => ({ over: over!, baseTax: baseTax!, rate: rate! })),
};

async function asOrgAdmin<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Confirmed 2026 SSS / PhilHealth / Pag-IBIG rows, the three withholding tables, and a 695.00 minimum wage per store. */
export async function seedStatutoryRates(orgId: string, admin: Actor, storeIds: string[], minimumWage = '695.00'): Promise<void> {
  await asOrgAdmin(orgId, async (tx) => {
    const common = { effectiveFrom: '2026-01-01', sourceRef: 'T-190 test fixture' };
    const rows = [
      await addStatutoryRate(tx, admin, { ...common, agency: 'sss', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500', ecThreshold: '15000', ecLow: '10', ecHigh: '30' }),
      await addStatutoryRate(tx, admin, { ...common, agency: 'philhealth', eeRate: '0.025', erRate: '0.025', baseKind: 'basic', floor: '10000', ceiling: '100000' }),
      await addStatutoryRate(tx, admin, { ...common, agency: 'pagibig', eeRate: '0.02', erRate: '0.02', baseKind: 'basic', floor: '0', ceiling: '10000', lowThreshold: '1500', lowEeRate: '0.01' }),
    ];
    for (const r of rows) await confirmStatutoryRate(tx, admin, r);
    for (const frequency of ['semi_monthly', 'monthly', 'weekly'] as const) {
      await addWithholdingBracketSet(tx, admin, { frequency, effectiveFrom: '2026-01-01', rows: BRACKETS[frequency], sourceRef: 'T-190 test fixture' });
      await confirmWithholdingBracketSet(tx, admin, { frequency, effectiveFrom: '2026-01-01' });
    }
    for (const storeId of storeIds) {
      const mw = await addMinimumWage(tx, admin, { storeId, effectiveFrom: '2026-01-01', dailyRate: minimumWage, wageOrderRef: 'T-190 test fixture' });
      await confirmMinimumWage(tx, admin, mw);
    }
  });
}

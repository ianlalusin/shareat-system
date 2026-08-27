/**
 * Server-only helpers for the loan screens. T-126, bible row 158.
 *
 * ⭐ Every figure is DERIVED. `positionsByLoan` is one grouped query for the whole register rather
 * than a lookup per row — the N+1 is what makes a derived figure look expensive and tempts someone
 * to store it again, which is exactly what v1 did four times over.
 */
import { loansRepo, moneyAccountsRepo, type LoanPosition, type LoanRow } from '@shareat/db';
import { accruedInterest, scheduledInstalment } from '@shareat/domain';
import { money } from '@shareat/core/money';
import { withOrgPrincipal } from '../expenses/lib';

export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

export interface LoanListRow extends LoanRow {
  position: LoanPosition;
}

const ZERO: LoanPosition = {
  disbursed: '0.00',
  principalPaid: '0.00',
  interestPaid: '0.00',
  outstanding: '0.00',
};

export async function listRegister(orgId: string): Promise<LoanListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [rows, positions] = await Promise.all([
      loansRepo.listLoans(tx, orgId),
      loansRepo.positionsByLoan(tx, orgId),
    ]);
    return rows.map((l) => ({ ...l, position: positions.get(l.id) ?? ZERO }));
  });
}

/** Days one instalment covers — what the frequency means in the arithmetic. */
const DAYS_PER: Record<string, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 90,
  annual: 365,
};

export interface LoanDetail extends LoanListRow {
  payments: Awaited<ReturnType<typeof loansRepo.paymentsFor>>;
  /** What one instalment should be, for display only. */
  instalment: string;
  /** ⭐ Interest that has built up since the last payment — shown BEFORE anyone types an amount. */
  accruedNow: string;
  lastPaymentOn: string | null;
}

export async function getDetail(orgId: string, id: string): Promise<LoanDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const loan = await loansRepo.getById(tx, orgId, id);
    if (!loan) return null;

    const [position, payments, lastPaymentOn] = await Promise.all([
      loansRepo.positionOf(tx, orgId, id),
      loansRepo.paymentsFor(tx, orgId, id),
      loansRepo.lastPaymentDate(tx, orgId, id),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const accruedNow =
      Number(position.outstanding) > 0
        ? accruedInterest({
            outstanding: money(position.outstanding),
            principal: money(loan.principalAmount),
            ratePercent: Number(loan.interestRate),
            ratePeriod: loan.ratePeriod,
            method: loan.interestMethod,
            since: lastPaymentOn ?? loan.startDate,
            until: today,
          })
        : '0.00';

    return {
      ...loan,
      position,
      payments,
      instalment: scheduledInstalment({
        principal: money(loan.principalAmount),
        ratePercent: Number(loan.interestRate),
        ratePeriod: loan.ratePeriod,
        method: loan.interestMethod,
        periods: loan.termPeriods,
        daysPerPeriod: DAYS_PER[loan.paymentFrequency] ?? 30,
      }),
      accruedNow: String(accruedNow),
      lastPaymentOn,
    };
  });
}

/** Where money can come from or land. */
export async function moneyAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return Promise.all(
      accounts.map(async (a) => ({ ...a, balance: await moneyAccountsRepo.balanceOf(tx, orgId, a) })),
    );
  });
}

export function peso(amount: string | number): string {
  return `₱${Number(amount).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const METHOD_LABEL: Record<string, string> = {
  straight: 'Straight — interest on the original amount',
  amortizing: 'Amortizing — interest on what is left',
  equal_principal: 'Equal principal — payments shrink',
};

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paid_off: 'Paid off',
  defaulted: 'Defaulted',
  written_off: 'Written off',
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

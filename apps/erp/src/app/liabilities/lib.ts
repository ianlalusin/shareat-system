/**
 * Server-only helpers for the liability screens. T-128.
 *
 * ⭐ Every figure is read from the ledger — `outstanding = charged − paid` is arithmetic on one
 * balance, and settled means that balance reached zero. ⛔ v1 stores all three on the account plus a
 * fourth copy in its own ledger entry (DEF-074).
 */
import { toBusinessDate } from '@shareat/core/datetime';
import {
  liabilitiesRepo,
  moneyAccountsRepo,
  type LiabilityMovement,
  type LiabilityPosition,
  type LiabilityRow,
} from '@shareat/db';
import { isOverdue } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

const ZERO: LiabilityPosition = { charged: '0.00', paid: '0.00', outstanding: '0.00' };

export interface LiabilityListRow extends LiabilityRow {
  position: LiabilityPosition;
  overdue: boolean;
}

export async function listRegister(orgId: string): Promise<LiabilityListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [rows, positions] = await Promise.all([
      liabilitiesRepo.listLiabilities(tx, orgId),
      liabilitiesRepo.positionsByLiability(tx, orgId),
    ]);
    return rows.map((l) => {
      const position = positions.get(l.id) ?? ZERO;
      return { ...l, position, overdue: isOverdue(l.dueOn, position.outstanding) };
    });
  });
}

export interface LiabilityDetail extends LiabilityListRow {
  entries: LiabilityMovement[];
}

export async function getDetail(orgId: string, id: string): Promise<LiabilityDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const row = await liabilitiesRepo.getById(tx, orgId, id);
    if (!row) return null;
    const position = await liabilitiesRepo.positionOf(tx, orgId, id);
    const entries = await liabilitiesRepo.movementsFor(tx, orgId, id);
    return { ...row, position, overdue: isOverdue(row.dueOn, position.outstanding), entries };
  });
}

/** Where a payment can come from. */
export async function moneyAccounts(orgId: string, storeId: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const accounts = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, { storeId });
    return Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: await moneyAccountsRepo.balanceOf(tx, orgId, a),
      })),
    );
  });
}

/** Expense and asset accounts a charge may land on. */
export async function chargeableAccounts(orgId: string) {
  return withOrgPrincipal(orgId, (tx) => liabilitiesRepo.chargeableAccounts(tx, orgId));
}

export function today(): string {
  return toBusinessDate();
}

export const CATEGORY_LABEL: Record<string, string> = {
  taxes_payable: 'Taxes payable',
  government_contributions: 'Government contributions',
  accrued_expenses: 'Accrued expenses',
  other: 'Other',
};

export const SOURCE_LABEL: Record<string, string> = {
  liability_charge: 'Charged',
  liability_payment: 'Paid',
};

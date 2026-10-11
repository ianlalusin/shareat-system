/**
 * Server-only helpers for the cash-request screens. T-144, bible row 159.
 *
 * ⭐ **Every figure is read from the ledger.** The float position is the balance of `1120` for this
 * request's party; `released − spent − returned − short` is arithmetic on that one number, not a
 * second definition of it. ⛔ v1 stored `remainingAmount` and `varianceAmount` — both subtractions
 * of things the ledger already knew, and both able to disagree with it.
 *
 * ⚠️ `floatsByRequest` is one grouped query for the whole register rather than a lookup per row.
 * The N+1 is what makes a derived figure feel expensive and tempts the next person to store it.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import {
  cashRequestsRepo,
  moneyAccountsRepo,
  type CashRequestRow,
  type FloatPosition,
} from '@shareat/db';
import { compare, money, ZERO as ZERO_MONEY } from '@shareat/core/money';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, listActivePersons, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

const ZERO: FloatPosition = {
  released: '0.00',
  spent: '0.00',
  returned: '0.00',
  short: '0.00',
  outstanding: '0.00',
};

export interface CashRequestListRow extends CashRequestRow {
  float: FloatPosition;
}

export async function listRegister(orgId: string): Promise<CashRequestListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [rows, floats] = await Promise.all([
      cashRequestsRepo.listRequests(tx, orgId),
      cashRequestsRepo.floatsByRequest(tx, orgId),
    ]);
    return rows.map((r) => ({ ...r, float: floats.get(r.id) ?? ZERO }));
  });
}

export interface CashRequestDetail extends CashRequestListRow {
  /** ⭐ Derived: the request closes when the float reaches zero, not when someone says it has. */
  isSettled: boolean;
}

export async function getDetail(orgId: string, id: string): Promise<CashRequestDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const row = await cashRequestsRepo.getById(tx, orgId, id);
    if (!row) return null;
    const float = await cashRequestsRepo.floatPositionOf(tx, orgId, id);
    return { ...row, float, isSettled: compare(money(float.outstanding), ZERO_MONEY) <= 0 };
  });
}

/** Where a float can come from, or land — with balances, so the picker is not blind. */
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

/**
 * ⚠️ The labels say what each state MEANS for the money, not just what it is called. "Approved"
 * and "released" are one word apart and a world apart: one is a promise, the other is cash gone.
 */
export const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested — nothing has moved',
  approved: 'Approved — not yet handed over',
  rejected: 'Refused',
  released: 'Out with the holder',
  liquidated: 'Settled',
  cancelled: 'Withdrawn',
};

export function today(): string {
  return toBusinessDate();
}

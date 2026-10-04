/**
 * Server-only helpers for the owner-equity screens. T-127, bible row 160.
 *
 * ⭐ **Every figure is read from the ledger.** `contributed − drawn = net` is arithmetic on two sums,
 * not a third stored number — which is why the screen cannot show a total that disagrees with the
 * books. ⛔ v1 keeps all three on the owner document, the last a stored copy of a subtraction
 * (DEF-072).
 */
import { toBusinessDate } from '@shareat/core/datetime';
import {
  moneyAccountsRepo,
  ownersRepo,
  type AgedReceivable,
  type DrawingCloseRow,
  type OwnerPosition,
  type OwnerRow,
} from '@shareat/db';
import { monthOf } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, listActivePersons, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

const ZERO: OwnerPosition = {
  contributed: '0.00',
  drawn: '0.00',
  net: '0.00',
  receivable: '0.00',
};

export interface OwnerListRow extends OwnerRow {
  position: OwnerPosition;
  aged: AgedReceivable | null;
}

export async function listRegister(orgId: string): Promise<OwnerListRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    // One grouped query each — the N+1 is what makes a derived figure feel expensive and tempts the
    // next person to store it.
    const [rows, positions, aged] = await Promise.all([
      ownersRepo.listOwners(tx, orgId),
      ownersRepo.positionsByOwner(tx, orgId),
      ownersRepo.agedReceivables(tx, orgId),
    ]);
    const agedBy = new Map(aged.map((a) => [a.ownerId, a]));
    return rows.map((o) => ({
      ...o,
      position: positions.get(o.id) ?? ZERO,
      aged: agedBy.get(o.id) ?? null,
    }));
  });
}

export interface OwnerDetail extends OwnerListRow {
  closes: DrawingCloseRow[];
  /** The most recent finished month with no close yet — what the screen offers to close. */
  closableMonth: string | null;
  closableAmount: string;
}

export async function getDetail(orgId: string, id: string): Promise<OwnerDetail | null> {
  return withOrgPrincipal(orgId, async (tx) => {
    const row = await ownersRepo.getById(tx, orgId, id);
    if (!row) return null;

    const [position, aged, closes] = await Promise.all([
      ownersRepo.positionOf(tx, orgId, id),
      ownersRepo.agedReceivables(tx, orgId),
      ownersRepo.listCloses(tx, orgId, { ownerId: id }),
    ]);

    // ⚠️ The month just gone, and only if it is not already agreed. Offering the CURRENT month would
    // invite closing a month that can still legitimately receive drawings.
    const lastMonth = previousMonth(today());
    const alreadyClosed = closes.some((c) => c.periodMonth.slice(0, 10) === lastMonth);
    const closableAmount = alreadyClosed
      ? '0.00'
      : await ownersRepo.drawnInWindow(tx, orgId, row, {
          since: lastMonth,
          until: today().slice(0, 8) + '01',
        });

    return {
      ...row,
      position,
      aged: aged.find((a) => a.ownerId === id) ?? null,
      closes,
      closableMonth: alreadyClosed ? null : lastMonth,
      closableAmount,
    };
  });
}

/** Where money can come from or land. */
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

export function today(): string {
  return toBusinessDate();
}

/** ⚠️ String maths, no `Date` — the same reason `monthOf` uses it: no timezone can shift a month. */
export function previousMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
}

export { monthOf };

export const TREATMENT_LABEL: Record<string, string> = {
  repayable: 'Expected back — a receivable',
  drawing: 'Not expected back — a drawing',
};

/**
 * ⚠️ **The threshold is a prompt, not a rule.** Nothing in the code refuses an old receivable; what
 * matters is that somebody sees it. An owner balance left uncollected long enough stops looking like
 * a loan to anyone examining it.
 */
export const AGED_DAYS = 90;

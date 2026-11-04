/**
 * T-511 S3 - the Grab control total (`docs/tasks/511-settlement-upload-s3-spec.md` item 5). Pure: a Transactions file and a Transfers file in,
 * one entry per payout out. A payout is `tied` when the exact sum of its rows' Total equals its Net Total, `differs` when it does not, and
 * `waiting_for_rows` when none of its rows are in the file (the first payout of a month pays orders that sit in the previous month's file).
 * Transaction rows whose Settlement ID has no payout row yet (the last day's orders) come back as `unlistedSettlements`.
 */
import { addDays, type BusinessDate } from '@shareat/core/datetime';
import { ZERO, add, equals, subtract, type Money } from '@shareat/core/money';
import type { GrabTransactionRow, GrabTransactionsFile } from './grab-transactions';
import type { GrabPayoutStatus, GrabTransfersFile } from './grab-transfers';
import { intakeRefusal } from './refusal';

export type GrabPayoutState = 'tied' | 'differs' | 'waiting_for_rows';

export interface GrabPayout {
  settlementId: string;
  /** the order day this payout pays: the payout date minus one day (YYYY-MM-DD) */
  storeDay: string;
  netTotal: Money;
  /** the payout's own printed date (YYYY-MM-DD), the day after `storeDay` */
  payoutDate: string;
  status: GrabPayoutStatus;
  /** when the bank transfer happened (YYYY-MM-DD); null while the payout is still processing */
  transferDate: string | null;
  /** exact sum of the rows' Total; null while no rows are in the file */
  rowsTotal: Money | null;
  state: GrabPayoutState;
  /** rowsTotal minus netTotal (so +1.00 means the rows add up to 1.00 more than the payout); null while waiting */
  difference: Money | null;
  rows: GrabTransactionRow[];
}

export interface GrabUnlistedSettlement {
  settlementId: string;
  rowsTotal: Money;
  rows: GrabTransactionRow[];
}

export interface GrabPayoutTie {
  payouts: GrabPayout[];
  unlistedSettlements: GrabUnlistedSettlement[];
}

/** Exact sum of the rows' Total. Figures near the numeric(14,2) ceiling overflow `add`; that is a named refusal, not a raw RangeError. */
function guarded<T>(rows: GrabTransactionRow[], work: () => T): T {
  try {
    return work();
  } catch {
    throw intakeRefusal('GRAB_BAD_VALUE', `The rows of one settlement (the first is on line ${rows[0]?.line ?? 0}) add up to more than the system can hold.`);
  }
}
const sumOf = (rows: GrabTransactionRow[]): Money => guarded(rows, () => add(ZERO, ...rows.map((r) => r.total ?? ZERO)));

function dayBefore(iso: string, line: number): string {
  // The reader has already validated every date; a hand-built transfers object may not have, so refuse by name, never a raw RangeError.
  try {
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso) && addDays(iso as BusinessDate, 0) === iso) return addDays(iso as BusinessDate, -1);
  } catch {
    // falls through to the refusal below
  }
  throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "Date": the payout date is not a real calendar date.`);
}

export function tieGrabPayouts(transactions: GrabTransactionsFile, transfers: GrabTransfersFile): GrabPayoutTie {
  if (transactions.storeId !== transfers.storeId) {
    throw intakeRefusal('GRAB_MIXED_STORES', 'The Transactions file and the Transfers file are from different stores, so they cannot be tied together.');
  }
  // Settlement IDs are matched in upper case on both sides (the Transfers reader refuses `abc` and `ABC` as one payout, so the tie agrees).
  const bySettlement = new Map<string, GrabTransactionRow[]>();
  for (const row of transactions.rows) {
    if (row.settlementId === null) continue;
    const key = row.settlementId.toUpperCase();
    const group = bySettlement.get(key);
    if (group) group.push(row);
    else bySettlement.set(key, [row]);
  }
  const payouts: GrabPayout[] = transfers.rows.map((t) => {
    const rows = bySettlement.get(t.settlementId.toUpperCase()) ?? [];
    const base = {
      settlementId: t.settlementId,
      storeDay: dayBefore(t.payoutDate.date, t.line),
      netTotal: t.netTotal,
      payoutDate: t.payoutDate.date,
      status: t.status,
      transferDate: t.transferDate?.date ?? null,
      rows,
    };
    if (rows.length === 0) return { ...base, rowsTotal: null, state: 'waiting_for_rows', difference: null };
    const rowsTotal = sumOf(rows);
    const difference = guarded(rows, () => subtract(rowsTotal, t.netTotal));
    return { ...base, rowsTotal, state: equals(rowsTotal, t.netTotal) ? 'tied' : 'differs', difference };
  });
  const listed = new Set(transfers.rows.map((t) => t.settlementId.toUpperCase()));
  const unlistedSettlements: GrabUnlistedSettlement[] = [];
  for (const [key, rows] of bySettlement) {
    if (!listed.has(key)) unlistedSettlements.push({ settlementId: rows[0]?.settlementId ?? key, rowsTotal: sumOf(rows), rows });
  }
  return { payouts, unlistedSettlements };
}

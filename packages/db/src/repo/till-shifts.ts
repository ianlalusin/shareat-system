/**
 * The only place SQL is written for till custody. T-186.
 * `docs/tasks/186-till-custody-shift.md`.
 *
 * ## ⭐ The variance is computed here and stored nowhere
 *
 * `counted - expected`, every time it is read. A third stored number is a third thing that can
 * disagree with the two it came from — and this particular disagreement would be between *what we
 * charged the cashier* and *what we counted*.
 *
 * ⚠️ **`expected` itself IS stored**, and that is the deliberate exception the task spec argues in
 * §6.3: `balanceOf` has no `asOf`, and entries can be **backdated**, so re-deriving a past
 * expectation would silently rewrite a variance somebody was already charged for.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';
import { moneyAccounts } from '../../schema/money-accounts';
import {
  tillCountLines,
  tillCustodyShifts,
  type CountMoment,
  type TillShiftStatus,
} from '../../schema/till-shifts';

export interface TillCountRow {
  id: string;
  moment: CountMoment;
  moneyAccountId: string;
  moneyAccountName: string;
  glAccountCode: string;
  /** ⭐ Non-null exactly when this account is the store's till float (T-153). */
  floatTarget: string | null;
  counted: string;
  expected: string;
  /** ⚠️ DERIVED — negative is short, positive is over. Never stored. */
  variance: string;
  countedAt: Date;
  countedBy: string;
  countedByName: string | null;
  notes: string | null;
}

export interface TillShiftRow {
  id: string;
  orgId: string;
  storeId: string;
  businessDate: string;
  shiftNo: number;
  status: TillShiftStatus;
  openedAt: Date;
  openedBy: string;
  openedByName: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closedByName: string | null;
  prevShiftId: string | null;
  attendanceDayId: string | null;
  notes: string | null;
}

// -------------------------------------------------------------------------------------

export async function createShift(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    businessDate: string;
    shiftNo: number;
    openedBy: string;
    prevShiftId?: string | null;
    attendanceDayId?: string | null;
    notes?: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(tillCustodyShifts)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      businessDate: input.businessDate,
      shiftNo: input.shiftNo,
      openedBy: input.openedBy,
      prevShiftId: input.prevShiftId ?? null,
      attendanceDayId: input.attendanceDayId ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: tillCustodyShifts.id });
  return row!.id;
}

/**
 * ⛔ The ONLY mutation of a shift row, and it is one-way: `open` → `closed`.
 *
 * There is no re-open. A shift that was closed with a signed count is evidence; re-opening it
 * would let the count be taken twice against different balances, which is precisely how the
 * question *"which figure did we charge them for"* becomes unanswerable.
 */
export async function closeShift(
  tx: Tx,
  orgId: string,
  shiftId: string,
  input: { closedBy: string; notes?: string | null },
): Promise<boolean> {
  const rows = await tx
    .update(tillCustodyShifts)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedBy: input.closedBy,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    })
    .where(
      and(
        eq(tillCustodyShifts.id, shiftId),
        eq(tillCustodyShifts.orgId, orgId),
        // ⚠️ Guarded in the WHERE, not read-then-write: two closes racing would otherwise both
        // pass a prior status check and the second would overwrite the first closer's name.
        eq(tillCustodyShifts.status, 'open'),
      ),
    )
    .returning({ id: tillCustodyShifts.id });
  return rows.length > 0;
}

export async function voidShift(
  tx: Tx,
  orgId: string,
  shiftId: string,
  reason: string,
): Promise<boolean> {
  const rows = await tx
    .update(tillCustodyShifts)
    .set({ status: 'voided', notes: reason })
    .where(
      and(
        eq(tillCustodyShifts.id, shiftId),
        eq(tillCustodyShifts.orgId, orgId),
        eq(tillCustodyShifts.status, 'open'),
      ),
    )
    .returning({ id: tillCustodyShifts.id });
  return rows.length > 0;
}

export async function recordCount(
  tx: Tx,
  input: {
    shiftId: string;
    moment: CountMoment;
    moneyAccountId: string;
    counted: Money;
    expected: Money;
    countedBy: string;
    notes?: string | null;
  },
): Promise<string> {
  const [row] = await tx
    .insert(tillCountLines)
    .values({
      shiftId: input.shiftId,
      moment: input.moment,
      moneyAccountId: input.moneyAccountId,
      counted: input.counted,
      expected: input.expected,
      countedBy: input.countedBy,
      notes: input.notes ?? null,
    })
    .returning({ id: tillCountLines.id });
  return row!.id;
}

// -------------------------------------------------------------------------------------

/** The store's currently open shift, if any. ⭐ At most one can exist — the database enforces it. */
export async function openShiftFor(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<TillShiftRow | null> {
  const rows = await listShifts(tx, orgId, { storeId, status: 'open' });
  return rows[0] ?? null;
}

export async function getShift(
  tx: Tx,
  orgId: string,
  shiftId: string,
): Promise<TillShiftRow | null> {
  const rows = await listShifts(tx, orgId, { shiftId });
  return rows[0] ?? null;
}

export async function listShifts(
  tx: Tx,
  orgId: string,
  filter: {
    storeId?: string;
    businessDate?: string;
    status?: TillShiftStatus;
    shiftId?: string;
  } = {},
): Promise<TillShiftRow[]> {
  const rows = await tx
    .select({
      id: tillCustodyShifts.id,
      orgId: tillCustodyShifts.orgId,
      storeId: tillCustodyShifts.storeId,
      businessDate: tillCustodyShifts.businessDate,
      shiftNo: tillCustodyShifts.shiftNo,
      status: tillCustodyShifts.status,
      openedAt: tillCustodyShifts.openedAt,
      openedBy: tillCustodyShifts.openedBy,
      openedByName: sql<string | null>`(select p.display_name from persons p where p.id = ${tillCustodyShifts.openedBy})`,
      closedAt: tillCustodyShifts.closedAt,
      closedBy: tillCustodyShifts.closedBy,
      closedByName: sql<string | null>`(select p.display_name from persons p where p.id = ${tillCustodyShifts.closedBy})`,
      prevShiftId: tillCustodyShifts.prevShiftId,
      attendanceDayId: tillCustodyShifts.attendanceDayId,
      notes: tillCustodyShifts.notes,
    })
    .from(tillCustodyShifts)
    .where(
      and(
        eq(tillCustodyShifts.orgId, orgId),
        filter.storeId ? eq(tillCustodyShifts.storeId, filter.storeId) : undefined,
        filter.businessDate ? eq(tillCustodyShifts.businessDate, filter.businessDate) : undefined,
        filter.status ? eq(tillCustodyShifts.status, filter.status) : undefined,
        filter.shiftId ? eq(tillCustodyShifts.id, filter.shiftId) : undefined,
      ),
    )
    .orderBy(desc(tillCustodyShifts.businessDate), desc(tillCustodyShifts.shiftNo));

  return rows as TillShiftRow[];
}

/** Every count taken during one shift, both moments, with the variance computed on read. */
export async function countsFor(tx: Tx, shiftId: string): Promise<TillCountRow[]> {
  const rows = await tx
    .select({
      id: tillCountLines.id,
      moment: tillCountLines.moment,
      moneyAccountId: tillCountLines.moneyAccountId,
      moneyAccountName: moneyAccounts.name,
      glAccountCode: moneyAccounts.glAccountCode,
      floatTarget: moneyAccounts.floatTarget,
      counted: tillCountLines.counted,
      expected: tillCountLines.expected,
      // ⚠️ DERIVED, and cast to text so it arrives as an exact decimal string — never a float.
      variance: sql<string>`(${tillCountLines.counted} - ${tillCountLines.expected})::text`,
      countedAt: tillCountLines.countedAt,
      countedBy: tillCountLines.countedBy,
      countedByName: sql<string | null>`(select p.display_name from persons p where p.id = ${tillCountLines.countedBy})`,
      notes: tillCountLines.notes,
    })
    .from(tillCountLines)
    .innerJoin(moneyAccounts, eq(moneyAccounts.id, tillCountLines.moneyAccountId))
    .where(eq(tillCountLines.shiftId, shiftId))
    .orderBy(asc(tillCountLines.moment), asc(moneyAccounts.glAccountCode));

  return rows as TillCountRow[];
}

/**
 * ⭐ T-135's twelfth question: closed shifts whose CLOSING count did not match the ledger.
 *
 * ⚠️ **This is the COUNTED variance, and it is not `tillFloatOffTarget`.** That one compares the
 * LEDGER to a target and means the office should replenish; this one compares a physical COUNT to
 * the ledger and means cash is missing from the pocket. T-153 §13.4 exists because reading one as
 * the other charges somebody for a delivery they paid for correctly.
 */
export interface CountedVarianceRow {
  shiftId: string;
  storeId: string;
  storeName: string;
  businessDate: string;
  shiftNo: number;
  moneyAccountName: string;
  glAccountCode: string;
  variance: string;
  closedBy: string | null;
  closedByName: string | null;
}

export async function countedVariances(
  tx: Tx,
  orgId: string,
  opts: { storeId?: string } = {},
): Promise<CountedVarianceRow[]> {
  const rows = await tx.execute(sql`
    select
      s.id                                        as "shiftId",
      s.store_id                                  as "storeId",
      st.name                                     as "storeName",
      s.business_date::text                       as "businessDate",
      s.shift_no                                  as "shiftNo",
      ma.name                                     as "moneyAccountName",
      ma.gl_account_code                          as "glAccountCode",
      (l.counted - l.expected)::text              as "variance",
      s.closed_by                                 as "closedBy",
      p.display_name                                 as "closedByName"
    from till_count_lines l
    join till_custody_shifts s on s.id = l.shift_id
    join money_accounts ma on ma.id = l.money_account_id
    join stores st on st.id = s.store_id
    left join persons p on p.id = s.closed_by
    where s.org_id = ${orgId}
      and s.status = 'closed'
      and l.moment = 'close'
      -- A rounding-free comparison: these are numeric(14,2), so anything non-zero is real money.
      and l.counted <> l.expected
      ${opts.storeId ? sql`and s.store_id = ${opts.storeId}` : sql``}
    order by s.business_date desc, s.shift_no desc
  `);
  return rows as unknown as CountedVarianceRow[];
}

/** ⚠️ Used only by the open-shift guard's error message — never to decide anything. */
export async function unclosedShiftCount(tx: Tx, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tillCustodyShifts)
    .where(and(eq(tillCustodyShifts.orgId, orgId), eq(tillCustodyShifts.status, 'open')));
  return row?.n ?? 0;
}

/** Exported for the domain layer's handover check — the successor a shift already has, if any. */
export async function successorOf(
  tx: Tx,
  orgId: string,
  shiftId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: tillCustodyShifts.id })
    .from(tillCustodyShifts)
    .where(and(eq(tillCustodyShifts.orgId, orgId), eq(tillCustodyShifts.prevShiftId, shiftId)));
  return row?.id ?? null;
}

/** The next unused shift number for a store's trading date. 1 when the day has not started. */
export async function nextShiftNo(
  tx: Tx,
  orgId: string,
  storeId: string,
  businessDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${tillCustodyShifts.shiftNo}), 0)::int` })
    .from(tillCustodyShifts)
    .where(
      and(
        eq(tillCustodyShifts.orgId, orgId),
        eq(tillCustodyShifts.storeId, storeId),
        eq(tillCustodyShifts.businessDate, businessDate),
      ),
    );
  return (row?.n ?? 0) + 1;
}

/** The cash money accounts a till is counted against. T-316: the float is a target on the single cashier drawer, not a separate pot. */
export async function countableAccounts(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ id: string; name: string; glAccountCode: string; floatTarget: string | null }[]> {
  const rows = await tx
    .select({
      id: moneyAccounts.id,
      name: moneyAccounts.name,
      glAccountCode: moneyAccounts.glAccountCode,
      floatTarget: moneyAccounts.floatTarget,
    })
    .from(moneyAccounts)
    .where(
      and(
        eq(moneyAccounts.orgId, orgId),
        eq(moneyAccounts.storeId, storeId),
        eq(moneyAccounts.custodian, 'cashier'),
        // ⚠️ Cash only. An e-wallet balance is not something a person counts in a drawer, and
        // asking for a physical count of one is how a made-up number enters the record.
        eq(moneyAccounts.instrument, 'cash'),
        eq(moneyAccounts.isActive, true),
      ),
    )
    .orderBy(asc(moneyAccounts.glAccountCode));
  return rows;
}

export interface CountLineWithShift {
  id: string;
  shiftId: string;
  storeId: string;
  businessDate: string;
  shiftNo: number;
  moment: CountMoment;
  moneyAccountId: string;
  moneyAccountName: string;
  glAccountCode: string;
  counted: string;
  expected: string;
  /** ⚠️ DERIVED. Negative is short, positive is over. */
  variance: string;
}

/** One count line with the shift context a charge needs — the store to gate on, and the date. */
export async function countLineWithShift(
  tx: Tx,
  orgId: string,
  countLineId: string,
): Promise<CountLineWithShift | null> {
  const [row] = await tx
    .select({
      id: tillCountLines.id,
      shiftId: tillCustodyShifts.id,
      storeId: tillCustodyShifts.storeId,
      businessDate: tillCustodyShifts.businessDate,
      shiftNo: tillCustodyShifts.shiftNo,
      moment: tillCountLines.moment,
      moneyAccountId: tillCountLines.moneyAccountId,
      moneyAccountName: moneyAccounts.name,
      glAccountCode: moneyAccounts.glAccountCode,
      counted: tillCountLines.counted,
      expected: tillCountLines.expected,
      variance: sql<string>`(${tillCountLines.counted} - ${tillCountLines.expected})::text`,
    })
    .from(tillCountLines)
    .innerJoin(tillCustodyShifts, eq(tillCustodyShifts.id, tillCountLines.shiftId))
    .innerJoin(moneyAccounts, eq(moneyAccounts.id, tillCountLines.moneyAccountId))
    .where(and(eq(tillCountLines.id, countLineId), eq(tillCustodyShifts.orgId, orgId)));
  return (row as CountLineWithShift | undefined) ?? null;
}

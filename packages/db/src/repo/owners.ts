/**
 * The only place SQL is written for owners. T-127.
 *
 * ## ⭐ `positionOf` is the point of this file
 *
 * v1 stores `totalCapital`, `totalDrawings` and `netEquity` on the owner document, the last of them
 * commented `// totalCapital - totalDrawings` — a stored copy of a subtraction (DEF-072). Here all
 * three are summed from the ledger by party, so `net = contributed − drawn` is arithmetic on one
 * set of numbers rather than a second definition of them.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
// ⛔ T-218 — Manila, never bare current_date (DEF-172).
import { MANILA_TODAY } from './sql-time';
// T-370 / DEF-108 — integer centavos for fifoOwnerOutstanding, never Number (bible §6).
import { fromCentavos, money, toCentavos, type Decimal, type Money } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert, SafeUpdate } from './numeric-input';
import { owners, type OwnerStatus, type PersonalExpenseTreatment } from '../../schema/owners';
import { owner_drawing_closes } from '../../schema/owner-drawing-closes';
import { recordGone } from './record-gone';
import { refuse } from '../refusal';

export const CAPITAL_CODE = '3100';
export const DRAWINGS_CODE = '3200';
export const DUE_FROM_OWNER_CODE = '1260';
/** Where a receivable goes when it is being recovered from pay — party_type `employee`. */
export const EMPLOYEE_ADVANCE_CODE = '1230';
export const PARTY_TYPE = 'owner';

export interface OwnerRow {
  id: string;
  orgId: string;
  storeId: string;
  personId: string;
  role: string | null;
  ownershipPercentage: string | null;
  drawingLimit: string | null;
  drawingLimitPeriod: 'monthly' | 'total' | null;
  personalExpenseTreatment: PersonalExpenseTreatment;
  status: OwnerStatus;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

/** T-371 C2 — every numeric column is a `Decimal` brand of that column's own shape, minted by `decimal()`. */
export type InsertOwnerInput = Pick<
  SafeInsert<typeof owners>,
  'orgId' | 'storeId' | 'personId' | 'createdBy'
> & {
  role: string | null;
  ownershipPercentage: Decimal<'6,3'> | null;
  drawingLimit: Money | null;
  drawingLimitPeriod: 'monthly' | 'total' | null;
  personalExpenseTreatment: PersonalExpenseTreatment;
  notes: string | null;
};

export async function insertOwner(tx: Tx, input: InsertOwnerInput): Promise<{ id: string }> {
  const [row] = await tx.insert(owners).values(input).returning({ id: owners.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<OwnerRow | undefined> {
  const [row] = await tx
    .select()
    .from(owners)
    .where(and(eq(owners.id, id), eq(owners.orgId, orgId)))
    .limit(1);
  return row as OwnerRow | undefined;
}

/**
 * ⛔ T-370 / DEF-516 (R3a) — row-lock the owner before `judgeDrawingLimit` reads `drawnInWindow`,
 * so two concurrent drawings cannot both pass the same cap (`liabilities.ts:85`'s precedent). Held
 * to COMMIT/ROLLBACK. Call AFTER `authorize` so a refused caller never queues on the row.
 *
 * ⚠️ `for update` over an empty set locks nothing and raises nothing (`employment.ts:188`'s same
 * risk with `allocateStaffCode`'s store lock) — silently proceeding unlocked would let two
 * concurrent callers both pass the cap, the exact bug this function exists to close. The caller
 * already confirmed the owner exists moments earlier in this same transaction, so zero rows here
 * is an unreachable invariant, not a normal refusal.
 */
export async function lockOwnerForUpdate(tx: Tx, orgId: string, ownerId: string): Promise<void> {
  const [row] = (await tx.execute(
    sql`select 1 as ok from owners where id = ${ownerId} and org_id = ${orgId} for update`,
  )) as unknown as { ok: number }[];
  if (!row) {
    throw refuse(
      `lockOwnerForUpdate: owner ${ownerId} not found in org ${orgId} — nothing was locked.`,
      'Something went wrong checking this owner. Try again, or contact support if it keeps happening.',
    );
  }
}

export async function listOwners(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<OwnerRow[]> {
  const conditions = [eq(owners.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(owners.storeId, filter.storeId));
  const rows = await tx
    .select()
    .from(owners)
    .where(and(...conditions))
    .orderBy(asc(owners.createdAt));
  return rows as OwnerRow[];
}

export async function updateOwner(
  tx: Tx,
  orgId: string,
  id: string,
  values: Pick<
    SafeUpdate<typeof owners>,
    'role' | 'drawingLimitPeriod' | 'personalExpenseTreatment' | 'status' | 'notes'
  > & {
    /** ⚠️ T-343 S5.5s — `ownershipPercentage` must already have passed `createOwner`'s range guard
     *  (`packages/domain/src/owners/index.ts`); T-371 C2 — the brand proves it went through
     *  `decimal()`, not that it is in range. No caller writes it today. */
    ownershipPercentage?: Decimal<'6,3'> | null;
    drawingLimit?: Money | null;
  },
): Promise<void> {
  const updated = await tx
    .update(owners)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(owners.id, id), eq(owners.orgId, orgId)))
    .returning({ id: owners.id });
  if (updated.length === 0) throw recordGone(`updateOwner: owner ${id} does not exist in org ${orgId}`, 'owner');
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — every figure, from the ledger
// -------------------------------------------------------------------------------------

export interface OwnerPosition {
  contributed: string;
  drawn: string;
  /** ⭐ `contributed − drawn`. Arithmetic on the two above, never a stored third number. */
  net: string;
  /** ⚠️ Personal expenses the business still expects back — 1260, NOT part of `net`. */
  receivable: string;
}

const ZERO: OwnerPosition = {
  contributed: '0.00',
  drawn: '0.00',
  net: '0.00',
  receivable: '0.00',
};

/**
 * ⚠️ Reversed entries are INCLUDED: an entry and its reversal net to zero, so counting both is
 * correct and counting only one is not. Excluding the original while keeping its mirror is the
 * mistake T-126 made and its own tests caught.
 */
const POSITION_SELECT = sql`
  coalesce(sum(case when a.code = ${CAPITAL_CODE}  then jl.credit - jl.debit else 0 end), 0)::text as contributed,
  coalesce(sum(case when a.code = ${DRAWINGS_CODE} then jl.debit  - jl.credit else 0 end), 0)::text as drawn,
  coalesce(sum(case when a.code = ${DUE_FROM_OWNER_CODE} then jl.debit - jl.credit else 0 end), 0)::text as receivable
`;

function toPosition(r: Record<string, string> | undefined): OwnerPosition {
  if (!r) return ZERO;
  const contributed = Number(r.contributed ?? 0);
  const drawn = Number(r.drawn ?? 0);
  return {
    contributed: contributed.toFixed(2),
    drawn: drawn.toFixed(2),
    net: (contributed - drawn).toFixed(2),
    receivable: Number(r.receivable ?? 0).toFixed(2),
  };
}

export async function positionOf(tx: Tx, orgId: string, ownerId: string): Promise<OwnerPosition> {
  const [row] = (await tx.execute(sql`
    select ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${ownerId}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return toPosition(row);
}

/** Every owner's position in one query — the register's N+1 guard. */
export async function positionsByOwner(
  tx: Tx,
  orgId: string,
): Promise<Map<string, OwnerPosition>> {
  const rows = (await tx.execute(sql`
    select jl.party_id as owner_id, ${POSITION_SELECT}
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and je.status <> 'draft'
    group by jl.party_id
  `)) as unknown as Record<string, string>[];
  const map = new Map<string, OwnerPosition>();
  for (const r of rows) map.set(String(r.owner_id ?? r.ownerId), toPosition(r));
  return map;
}

/**
 * ⭐ **What counts against a drawing limit**, and it is deliberately MORE than `3200`.
 *
 * ⛔ A limit that only sees drawings is bypassed by marking every personal expense "repayable":
 * the money leaves, `1260` grows, and the cap never moves. That is the same hole as a revolving
 * fund whose top-up is not gated by receipts — the control has to see every way cash reaches the
 * owner, not just the one with the honest name.
 *
 * ⚠️ Counted at OUTSTANDING balance, so a receivable the owner has actually repaid stops consuming
 * their limit — repaying is what makes room again. ⛔ But a RECLASSIFICATION is not a repayment:
 * "recover from pay" moves the balance to `1230` and nothing has come back yet, so that account is
 * counted too. The limit tracks money that reached the owner and has not returned, whichever
 * receivable is currently holding it.
 *
 * T-370 / DEF-108 — R2: `drawn(window) = [1260/3200 flows, unchanged below] +
 * ownerOutstanding(until) − ownerOutstanding(since)`, where `ownerOutstanding(t)` is
 * `fifoOwnerOutstanding` applied to the PERSON's whole `1230` history up to `t` (not scoped to this
 * owner's own `source_id`). A payroll recovery credits `1230` with NO origin allocation, so it is
 * attributed FIFO across every charge on the person's `1230` ledger, oldest first (R1) — a plain
 * `source_id = owner.id` scope made every recovery invisible to this query, so the cap it should
 * have freed never moved. One person can hold two owner rows (`owners_store_person_key`); each
 * sees only the remainder of its OWN charges, so nothing is double-counted (R2.5).
 *
 * `until` is exclusive; omit `since` for the `total` period. Omit `until` for "all lines".
 *
 * T-370 amendment (2026-09-30, orchestrator ruling, default pending Ian) — a payroll recovery (or a
 * cash repayment) frees the owner's TOTAL/lifetime figure for good (unfloored, below), but a
 * MONTHLY window (`since` given) never reports below zero. It is its OWN running total, starting
 * fresh at zero at `since`, floored at zero after every dated event in the window — never carrying
 * a "deficit" one event created into offsetting a LATER one. A floor on the aggregate delta alone is
 * NOT equivalent: it would let a recovery that lands before this window's own drawings quietly
 * absorb part of them (verified by hand against the tester's O1/M-headroom legs — a 5000 recovery
 * then a 10000 drawing in the same month must still read 10000, not 5000).
 *
 * ⚠️ **By design, the twelve MONTHLY figures in a year can sum to MORE than the TOTAL/lifetime
 * figure.** Each month floors independently at its own zero; the total never floors at all (a
 * recovery frees it for good, R2). A recovery that lands in month M2 against a charge from month M1
 * floors M2's own figure at zero (never negative) instead of carrying the freed amount as a credit
 * against M1 or anywhere else — that freed amount simply does not appear in any SINGLE month's
 * total, only in the lifetime one. Pending Ian; the default per the orchestrator's 2026-09-30 ruling.
 */
export async function drawnInWindow(
  tx: Tx,
  orgId: string,
  owner: { id: string; personId: string },
  window: { since?: string; until?: string } = {},
): Promise<string> {
  // ⭐ R2/R3 — the person's WHOLE `1230` history up to `until`, one query (fed to the pure helper
  // below); every snapshot or per-event delta below is the same rows filtered further, never a
  // second query.
  const lines = (await tx.execute(sql`
    select je.id as "entryId", je.reversal_of_entry_id as "reversalOf", je.source_id as "sourceId",
           jl.debit::text as debit, jl.credit::text as credit,
           je.entry_date::text as "entryDate", je.created_at::text as "createdAt", jl.id as "lineId"
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and je.status <> 'draft'
      and jl.party_type = 'employee' and jl.party_id = ${owner.personId}
      and a.code = ${EMPLOYEE_ADVANCE_CODE}
      ${window.until ? sql`and je.entry_date < ${window.until}` : sql``}
    order by je.entry_date, je.created_at, jl.id
  `)) as unknown as FifoLine[];

  if (window.since === undefined) {
    const [row] = (await tx.execute(sql`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as total
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and jl.party_type = ${PARTY_TYPE} and jl.party_id = ${owner.id}
        and a.code in (${DRAWINGS_CODE}, ${DUE_FROM_OWNER_CODE})
        ${window.until ? sql`and je.entry_date < ${window.until}` : sql``}
    `)) as unknown as Record<string, string>[];
    const flows = toCentavos(money(row?.total ?? '0'));
    const untilOutstanding = toCentavos(money(fifoOwnerOutstanding(lines, owner.id)));
    return fromCentavos(flows + untilOutstanding);
  }

  // ⭐ Monthly path — a chronological event simulation, floored at zero after every step (the
  // ruling above). Each in-window `1230` line's event is ITS OWN marginal effect on this owner's
  // FIFO remainder (computed by the pure, independently-testable `monthlyOwnerFifoDeltas` below);
  // each direct `3200`/`1260` line is its own flat `debit − credit`.
  const since = window.since;
  const events = monthlyOwnerFifoDeltas(lines, owner.id, since);

  const flowsLines = (await tx.execute(sql`
    select jl.debit::text as debit, jl.credit::text as credit,
           je.entry_date::text as "entryDate", je.created_at::text as "createdAt", jl.id as "lineId"
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and je.status <> 'draft'
      and jl.party_type = ${PARTY_TYPE} and jl.party_id = ${owner.id}
      and a.code in (${DRAWINGS_CODE}, ${DUE_FROM_OWNER_CODE})
      and je.entry_date >= ${since}
      ${window.until ? sql`and je.entry_date < ${window.until}` : sql``}
  `)) as unknown as { debit: string; credit: string; entryDate: string; createdAt: string; lineId: string }[];
  for (const l of flowsLines) {
    events.push({
      entryDate: l.entryDate,
      createdAt: l.createdAt,
      lineId: l.lineId,
      delta: toCentavos(money(l.debit)) - toCentavos(money(l.credit)),
    });
  }

  events.sort(byDateThenId);
  let running = 0n;
  for (const e of events) {
    running += e.delta;
    if (running < 0n) running = 0n;
  }
  return fromCentavos(running);
}

/** One line of a person's `1230` ledger, as `drawnInWindow` selects it for `fifoOwnerOutstanding`. */
export interface FifoLine {
  entryId: string;
  reversalOf: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
  entryDate: string;
  createdAt: string;
  lineId: string;
}

/**
 * ⭐ T-370 / DEF-108 — R1-R3: a person's whole `1230` history reduced to one owner's outstanding
 * remainder. A pure function, no DB — a repo may not import `@shareat/domain` (ADR-004), and a
 * single person's `1230` history is small, so the arithmetic lives here.
 *
 * R2's taxonomy, applied to `lines`:
 * 1. A debit line with `reversalOf === null` is a **charge**. Owner-origin for owner O iff
 *    `sourceId === O`.
 * 2. A credit line with `reversalOf = X` (a REVERSAL CREDIT) reduces ONLY charge X's own
 *    remainder. It never joins the pool.
 * 3. A debit line with `reversalOf = X` (e.g. `voidPayRun` reversing a payslip credit) cancels
 *    ONLY that pool credit X's own contribution. It is not a new charge.
 * 4. A credit line with `reversalOf === null` joins the **pool** — one number, applied to charges
 *    OLDEST FIRST (`entryDate`, `createdAt`, `lineId`), regardless of whose charge it is. Payroll
 *    does not allocate a recovery to an origin, so FIFO is the convention (R1): oldest-debt-first
 *    across the person's whole `1230` balance is Ian's ruling (2026-09-30) — one person, one pot of
 *    money owed; a recovery pays whatever that person has owed longest, which can be an OWNER charge
 *    even when the recovery itself arose from a STAFF advance (and vice versa). This is the rule, not
 *    a bug: a staff-first or owner-first alternative would instead re-open the leak `source_id`
 *    scoping was meant to close (a later shortage silently re-consuming an already-recovered cap).
 * 5. The result is the unconsumed remainder of O's own owner-origin charges. Never negative.
 *
 * Integer centavos throughout (`@shareat/core/money`) — never `Number`, per bible §6.
 */
export function fifoOwnerOutstanding(lines: readonly FifoLine[], ownerId: string): string {
  // ⭐ Effective status by walking the reversal chain: an entry is CANCELLED iff some entry that
  // reverses it is itself live; live iff not cancelled. So 0 or 2 reversals = live, 1 or 3 = cancelled.
  const reversersOf = new Map<string, Set<string>>();
  for (const l of lines) {
    if (l.reversalOf === null) continue;
    const set = reversersOf.get(l.reversalOf) ?? new Set<string>();
    set.add(l.entryId);
    reversersOf.set(l.reversalOf, set);
  }
  const liveMemo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isLive = (entryId: string): boolean => {
    const known = liveMemo.get(entryId);
    if (known !== undefined) return known;
    // ⚠️ Unreachable by construction, and therefore untested: `reversal_of_entry_id` always names a
    // chronologically EARLIER entry (a reversal cannot reverse something that doesn't exist yet), so
    // the graph it forms has no cycles to walk into. Kept as a guard, not a proof — the day something
    // upstream lets a reversal reference a later or equal entry, this is what should fire instead of
    // an infinite recursion.
    if (visiting.has(entryId)) {
      throw refuse(
        `fifoOwnerOutstanding: reversal cycle through entry ${entryId}`,
        'The owner ledger has a reversal that loops back on itself, so the drawing limit cannot be worked out. Contact support.',
      );
    }
    visiting.add(entryId);
    let cancelled = false;
    for (const r of reversersOf.get(entryId) ?? []) {
      if (isLive(r)) cancelled = true;
    }
    visiting.delete(entryId);
    liveMemo.set(entryId, !cancelled);
    return !cancelled;
  };

  // Only LIVE reversal entries act on their targets.
  const reversalCreditsByTarget = new Map<string, bigint>();
  const reversalDebitsByTarget = new Map<string, bigint>();
  for (const l of lines) {
    if (l.reversalOf === null || !isLive(l.entryId)) continue;
    const debit = toCentavos(money(l.debit));
    const credit = toCentavos(money(l.credit));
    if (credit > 0n) {
      reversalCreditsByTarget.set(l.reversalOf, (reversalCreditsByTarget.get(l.reversalOf) ?? 0n) + credit);
    }
    if (debit > 0n) {
      reversalDebitsByTarget.set(l.reversalOf, (reversalDebitsByTarget.get(l.reversalOf) ?? 0n) + debit);
    }
  }

  const charges = lines
    .filter((l) => l.reversalOf === null && toCentavos(money(l.debit)) > 0n)
    .map((l) => {
      const reduced = reversalCreditsByTarget.get(l.entryId) ?? 0n;
      const remaining = toCentavos(money(l.debit)) - reduced;
      return {
        sourceId: l.sourceId,
        entryDate: l.entryDate,
        createdAt: l.createdAt,
        lineId: l.lineId,
        remaining: remaining > 0n ? remaining : 0n,
      };
    })
    .sort(
      (a, b) =>
        a.entryDate.localeCompare(b.entryDate) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.lineId.localeCompare(b.lineId),
    );

  let pool = lines
    .filter((l) => l.reversalOf === null && toCentavos(money(l.credit)) > 0n)
    .reduce((sum, l) => {
      const cancelled = reversalDebitsByTarget.get(l.entryId) ?? 0n;
      const net = toCentavos(money(l.credit)) - cancelled;
      return sum + (net > 0n ? net : 0n);
    }, 0n);

  let ownerTotal = 0n;
  for (const c of charges) {
    const consumed = c.remaining < pool ? c.remaining : pool;
    pool -= consumed;
    const outstanding = c.remaining - consumed;
    if (c.sourceId === ownerId) ownerTotal += outstanding;
  }
  return fromCentavos(ownerTotal);
}

export interface DrawnEvent {
  entryDate: string;
  createdAt: string;
  lineId: string;
  delta: bigint;
}

const byDateThenId = (a: { entryDate: string; createdAt: string; lineId: string }, b: { entryDate: string; createdAt: string; lineId: string }): number =>
  a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt) || a.lineId.localeCompare(b.lineId);

/**
 * ⭐ T-370 / DEF-108 performance follow-up (auditor, 2026-09-30) — the monthly-window FIFO
 * computation, extracted as its own PURE function so order-independence can be pinned by a
 * shuffled-input unit test: `lines` is explicitly re-sorted here (twice — into `beforeSince` and
 * the in-window set) regardless of the array's incoming order, since the caller's SQL query makes
 * no ordering promise of its own (the `order by` on that query is belt-and-suspenders, not the only
 * layer bible §15.11 asks for).
 *
 * Returns each in-window `1230` line's own marginal delta to `ownerId`'s FIFO outstanding, in
 * chronological order. `drawnInWindow` merges these with the direct `3200`/`1260` flow deltas and
 * runs the floor-at-zero-after-every-step simulation described on its own doc.
 */
export function monthlyOwnerFifoDeltas(lines: readonly FifoLine[], ownerId: string, since: string): DrawnEvent[] {
  const beforeSince = lines.filter((l) => l.entryDate < since).sort(byDateThenId);
  const withinWindow1230 = lines.filter((l) => l.entryDate >= since).sort(byDateThenId);
  const events: DrawnEvent[] = [];

  // Recomputing `fifoOwnerOutstanding` from scratch over a GROWING prefix at every in-window line
  // was O(n·k) (measured 1.8s at n=5000, held inside the owner row lock). With no reversal anywhere
  // in the person's `1230` history up to `until`, every charge's raw debit and every pool credit's
  // raw amount IS already its final contribution (R2 items 2/3 never fire), so the running FIFO
  // match can be built up incrementally in ONE pass — a two-queue match (oldest unpaid charge vs.
  // idle pool) is exactly `fifoOwnerOutstanding`'s own rule, applied as lines arrive instead of
  // re-derived from scratch each time. A reversal breaks that (an EARLIER charge or pool credit's
  // raw contribution can change after later lines already consumed it), so that case falls back to
  // the original, proven-correct per-line recompute. ⚠️ NOT rare: `voidPayRun` reverses every
  // payslip it recovers from, so one voided pay run permanently switches that person's `1230`
  // history onto the fallback path from then on (never exercised by a monthly window in THIS task's
  // own tests, but expected to happen in real use). DEF-543 (logged) — a performance follow-up to
  // extend the fast path to cover reversals too; correctness is unaffected either way.
  const hasReversal = lines.some((l) => l.reversalOf !== null);
  if (!hasReversal) {
    const queue: { sourceId: string | null; remaining: bigint }[] = [];
    let idlePool = 0n;
    let ownerRunning = 0n;
    const applyCharge = (sourceId: string | null, debit: bigint) => {
      const consumed = debit < idlePool ? debit : idlePool;
      idlePool -= consumed;
      const remaining = debit - consumed;
      if (remaining > 0n) queue.push({ sourceId, remaining });
      if (sourceId === ownerId) ownerRunning += remaining;
    };
    const applyCredit = (credit: bigint) => {
      let left = credit;
      while (left > 0n && queue.length > 0) {
        const front = queue[0]!;
        const consumed = front.remaining < left ? front.remaining : left;
        front.remaining -= consumed;
        left -= consumed;
        if (front.sourceId === ownerId) ownerRunning -= consumed;
        if (front.remaining === 0n) queue.shift();
      }
      idlePool += left;
    };

    for (const l of beforeSince) {
      const debit = toCentavos(money(l.debit));
      const credit = toCentavos(money(l.credit));
      if (debit > 0n) applyCharge(l.sourceId, debit);
      else if (credit > 0n) applyCredit(credit);
    }
    let prevOutstanding = ownerRunning;
    for (const line of withinWindow1230) {
      const debit = toCentavos(money(line.debit));
      const credit = toCentavos(money(line.credit));
      if (debit > 0n) applyCharge(line.sourceId, debit);
      else if (credit > 0n) applyCredit(credit);
      events.push({ entryDate: line.entryDate, createdAt: line.createdAt, lineId: line.lineId, delta: ownerRunning - prevOutstanding });
      prevOutstanding = ownerRunning;
    }
  } else {
    let prefix: FifoLine[] = beforeSince;
    let prevOutstanding = toCentavos(money(fifoOwnerOutstanding(prefix, ownerId)));
    for (const line of withinWindow1230) {
      prefix = [...prefix, line];
      const next = toCentavos(money(fifoOwnerOutstanding(prefix, ownerId)));
      events.push({ entryDate: line.entryDate, createdAt: line.createdAt, lineId: line.lineId, delta: next - prevOutstanding });
      prevOutstanding = next;
    }
  }
  return events;
}

/** What the owner still owes on `1260` — the ceiling on any settlement. */
export async function receivableOf(tx: Tx, orgId: string, ownerId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${ownerId}
      and a.code = ${DUE_FROM_OWNER_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.total ?? 0).toFixed(2);
}

export interface AgedReceivable {
  ownerId: string;
  outstanding: string;
  /** The date of the OLDEST unsettled charge — what the age is measured from. */
  oldestOn: string;
  daysOutstanding: number;
}

/**
 * ⭐ **Owner receivables, with their age.** An aged `1260` balance is a FINDING, not a balance.
 *
 * ⚠️ A personal expense the business is owed becomes a constructive dividend if it is never really
 * collected — that is the line the tax treatment turns on — so a balance quietly sitting for months
 * is the thing somebody has to see. It surfaces the way remittance surfaces open variances: on the
 * register, first, without anyone remembering to ask.
 *
 * ⚠️ Age is measured from the OLDEST charge still outstanding, FIFO-style, not from the newest and
 * not from an average — the oldest is the one that has been sitting longest and is the one an
 * examiner would ask about.
 */
export async function agedReceivables(tx: Tx, orgId: string): Promise<AgedReceivable[]> {
  const rows = (await tx.execute(sql`
    select
      jl.party_id as owner_id,
      coalesce(sum(jl.debit - jl.credit), 0)::text as outstanding,
      min(case when jl.debit > 0 then je.entry_date end)::text as oldest_on,
      -- ⛔ T-218 / DEF-172. Manila, never bare current_date.
      (${MANILA_TODAY} - min(case when jl.debit > 0 then je.entry_date end))::int as days_outstanding
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${DUE_FROM_OWNER_CODE}
      and je.status <> 'draft'
    group by jl.party_id
    having coalesce(sum(jl.debit - jl.credit), 0) > 0
    order by min(case when jl.debit > 0 then je.entry_date end) asc
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    ownerId: String(r.owner_id ?? r.ownerId),
    outstanding: Number(r.outstanding ?? 0).toFixed(2),
    oldestOn: String(r.oldest_on ?? r.oldestOn ?? ''),
    daysOutstanding: Number(r.days_outstanding ?? r.daysOutstanding ?? 0),
  }));
}

/**
 * Does this person hold an active role in the org?
 *
 * ⚠️ **The best proxy available for "is on the payroll", and not the same thing.** v2 has no payroll
 * module, so nothing can prove somebody is PAID. This proves they work here, which is enough to rule
 * out the failure that matters: parking a receivable against the wages of someone who has none.
 * ⛔ Replace this with a real payroll lookup when payroll lands.
 */
export async function personHoldsActiveRole(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select 1 as ok from person_roles
    where person_id = ${personId} and org_id = ${orgId} and revoked_at is null
    limit 1
  `)) as unknown as Record<string, unknown>[];
  return Boolean(row);
}

// -------------------------------------------------------------------------------------
// The monthly close
// -------------------------------------------------------------------------------------

export interface DrawingCloseRow {
  id: string;
  orgId: string;
  storeId: string;
  ownerId: string;
  periodMonth: string;
  acknowledgedAmount: string;
  adjustmentAmount: string | null;
  adjustmentReason: string | null;
  adjustmentEntryId: string | null;
  closedOn: string;
  closedBy: string;
  notes: string | null;
}

/** T-371 C2 — both amounts are `Money` (14,2), minted by `decimal()`. */
export type InsertCloseInput = Pick<
  SafeInsert<typeof owner_drawing_closes>,
  'orgId' | 'storeId' | 'ownerId' | 'periodMonth' | 'closedOn' | 'closedBy'
> & {
  acknowledgedAmount: Money;
  adjustmentAmount: Money | null;
  adjustmentReason: string | null;
  adjustmentEntryId: string | null;
  notes: string | null;
};

export async function insertClose(tx: Tx, input: InsertCloseInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(owner_drawing_closes)
    .values(input)
    .returning({ id: owner_drawing_closes.id });
  return row!;
}

/** ⭐ The lock. A drawing dated into a closed month is refused — see `closeFor`'s callers. */
export async function closeFor(
  tx: Tx,
  orgId: string,
  ownerId: string,
  periodMonth: string,
): Promise<DrawingCloseRow | undefined> {
  const [row] = await tx
    .select()
    .from(owner_drawing_closes)
    .where(
      and(
        eq(owner_drawing_closes.orgId, orgId),
        eq(owner_drawing_closes.ownerId, ownerId),
        eq(owner_drawing_closes.periodMonth, periodMonth),
      ),
    )
    .limit(1);
  return row as DrawingCloseRow | undefined;
}

export async function listCloses(
  tx: Tx,
  orgId: string,
  filter: { ownerId?: string } = {},
): Promise<DrawingCloseRow[]> {
  const conditions = [eq(owner_drawing_closes.orgId, orgId)];
  if (filter.ownerId) conditions.push(eq(owner_drawing_closes.ownerId, filter.ownerId));
  const rows = await tx
    .select()
    .from(owner_drawing_closes)
    .where(and(...conditions))
    .orderBy(desc(owner_drawing_closes.periodMonth));
  return rows as DrawingCloseRow[];
}

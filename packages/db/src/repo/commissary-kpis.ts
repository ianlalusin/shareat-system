/**
 * Commissary KPI reads — T-212, `docs/tasks/212-commissary-and-inventory-kpis.md`.
 *
 * Three figures a commissary manager needs: what is on the floor, what is stranded in disputes and
 * for how long, and what actually arrived. All three are live queries over fact rows — Phase 6's
 * standing invariant (`docs/plans/phase-6-reporting-and-dashboards.md` §2, bible §4.2 rule 7). There
 * is no summary table here, no counter, and nothing for a write path to update.
 *
 * ## ⭐ The one figure v1 gets wrong, and why reading LINES is the fix
 *
 * v1's `monthReceivedTotal` sums `branchOrders.totalAmount` — the **dispatched** value, which
 * `confirmReceiptAction` never writes back. So a month containing a single short receipt overstates
 * (discovery 26 §B.4). ⛔ **`receivedInRange` below never reads `trade_orders.total_amount` at all.**
 * That is deliberate and structural: a subtraction can be forgotten by the next person to touch this
 * file, whereas a figure derived from `received_quantity` has no wrong version to fall back to.
 *
 * ## ⚠️ `trade_discrepancies.value` is at COST, not at the transfer rate
 *
 * `packages/domain/src/commissary/transfer.ts:423-429` writes it at cost, on purpose, because cost
 * is what is actually stranded in `1340`. ⚠️ **The schema's doc comment said "Quantity × the line's
 * transfer rate" until 2026-09-05** — the opposite — and this file's first draft trusted it and
 * derived a cross-check that could never have tied. Comment corrected under **DEF-175**.
 *
 * So: this file never uses `value` to reconcile a transfer-rate figure. Where it needs the shortfall
 * at the transfer rate it multiplies `trade_discrepancies.quantity` by the LINE's own rate.
 *
 * ## ⛔ INTERNAL orders only — and this one is not obvious
 *
 * v1 reads a `branchOrders` collection that contains **nothing but** commissary→branch transfers; a
 * franchisee sale lives somewhere else entirely. **v2 keeps both in `trade_orders`**, told apart only
 * by `customers.counterparty_store_id` (`customersRepo.treatmentOf` → `'internal'`). So porting v1's
 * query shape verbatim silently blends two populations, and the blend is not harmless:
 * `receiveTradeOrder` sets `received_quantity` **only** on the internal branch
 * (`packages/domain/src/trade/index.ts:745`) — an external sale is marked `received` with every
 * line's `received_quantity` still NULL, because no branch takes those goods into stock.
 *
 * ⚠️ Read without this scope, every external wholesale sale reports as **100% short-received**.
 * Measured on dev data 2026-09-05: ₱720 of a ₱1,420 apparent shortfall was two external sales that
 * arrived perfectly fine. Half the number was fiction. This is the *"read v1 as requirements, never
 * as design"* rule (bible §1.2b) with a price tag on it.
 *
 * Reads take an `Executor` and never open a transaction of their own — `reports.ts`'s convention.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '../client';

/**
 * ⛔ The internal-transfer scope, defined once. `counterparty_store_id is not null` IS
 * `treatmentOf(customer) === 'internal'` (`repo/customers.ts:53-59`) — the same predicate the
 * domain's own receive path branches on, not a second definition of "is this a branch order".
 */
const INTERNAL_ONLY = sql`and c.counterparty_store_id is not null`;

/**
 * ⛔ Manila, never bare `current_date`. DEF-172 and migration `0112`'s own comment: `current_date`
 * follows the SESSION timezone, so on a UTC server every business-date comparison is a full day
 * wrong through Manila's early-morning hours. Defined once here so no query in this file can quietly
 * use the other form.
 */
const MANILA_TODAY = sql`(now() at time zone 'Asia/Manila')::date`;

/**
 * The Manila calendar date of a `timestamptz` column.
 *
 * ⚠️ `sql.raw` interpolates without escaping, so the parameter is typed as the **exact literal
 * column references this file uses** rather than `string`. Every call site today passes a literal;
 * the narrow type is what stops a later one passing a variable and turning a helper into an
 * injection point.
 */
type TimestampColumn = 'd.created_at' | 'o.received_at';
function manilaDateOf(column: TimestampColumn) {
  return sql.raw(`(${column} at time zone 'Asia/Manila')::date`);
}

export interface CommissaryKpiFilter {
  orgId: string;
  /** Omit or pass null for "every store". */
  storeId?: string | null;
}

// ---------------------------------------------------------------------------------------------
// 1. In flight
// ---------------------------------------------------------------------------------------------

/**
 * ⭐ Derived from the timestamps, exactly as the order screens derive it — **never a sixth status**.
 * Migration `0121`'s header is explicit that v2 adds *"deliberately no new status values"*, and
 * `trade_orders_branch_stage_check` (ready ⇒ accepted) is what makes this ladder total.
 *
 * ⚠️ `accepted`/`ready` are **branch-order stages only** — the same constraint makes `accepted_at`
 * unreachable without a `requested_by_store_id`. A COMMISSARY-initiated transfer therefore sits at
 * `submitted` until it dispatches, which is accurate ("confirmed, not yet gone") but reads oddly if
 * you take the label literally. Whatever renders this should say *awaiting dispatch*, not *submitted
 * by the branch*.
 */
export type InFlightStage = 'submitted' | 'accepted' | 'ready' | 'dispatched';

export interface InFlightStageRow {
  stage: InFlightStage;
  orderCount: number;
  /** `Σ total_amount`. Correct for an in-flight order: nothing has been received yet, so the
   *  header total IS what is currently committed. ⚠️ Not the basis `receivedInRange` uses. */
  totalValue: string;
}

/**
 * Orders still in motion, by derived stage. `draft` is excluded — nobody is waiting on a draft —
 * and `received`/`void` are terminal.
 *
 * ⛔ A stage with no orders is **absent, not zero**. v1 pre-seeds all eight statuses with zeros
 * (`STATUS_ZERO`); a permanently-zero line in a KPI is the defect class bible §16.9 names, and the
 * phase plan already refused the same shape once for the scorecard's third term.
 */
export async function inFlightOrders(
  ex: Executor,
  filter: CommissaryKpiFilter,
): Promise<InFlightStageRow[]> {
  // ⚠️ The stage is derived in a subquery and ranked there. Postgres resolves a bare output-column
  // alias in ORDER BY, but NOT one used inside an expression — `order by case when stage = …` would
  // look for a `stage` column on `trade_orders` and fail. Rank alongside, order by the rank.
  const rows = (await ex.execute(sql`
    select s.stage, count(*)::int as order_count,
           coalesce(sum(s.total_amount), 0)::text as total_value
    from (
      select
        case
          when o.status = 'dispatched' then 'dispatched'
          when o.ready_at is not null then 'ready'
          when o.accepted_at is not null then 'accepted'
          else 'submitted'
        end as stage,
        case
          when o.status = 'dispatched' then 4
          when o.ready_at is not null then 3
          when o.accepted_at is not null then 2
          else 1
        end as stage_rank,
        o.total_amount
      from trade_orders o
      join customers c on c.id = o.customer_id
      where o.org_id = ${filter.orgId}
        and o.status in ('confirmed', 'dispatched')
        ${INTERNAL_ONLY}
        ${filter.storeId ? sql`and o.store_id = ${filter.storeId}` : sql``}
    ) s
    group by s.stage, s.stage_rank
    order by s.stage_rank
  `)) as unknown as { stage: InFlightStage; order_count: number; total_value: string }[];

  return rows.map((r) => ({
    stage: r.stage,
    orderCount: Number(r.order_count),
    totalValue: r.total_value,
  }));
}

// ---------------------------------------------------------------------------------------------
// 2. Open disputes — the one with measured harm behind it
// ---------------------------------------------------------------------------------------------

export interface OpenDisputeRow {
  id: string;
  orderId: string;
  storeId: string;
  referenceNo: string | null;
  orderDate: string;
  quantity: string;
  /** ⚠️ At COST — see this file's header. Label it as cost wherever it is shown. */
  value: string;
  status: string;
  deferredTo: string | null;
  ageDays: number;
}

export interface OpenDisputeSummary {
  count: number;
  /** Deferred rows are INCLUDED in `count`; this is how many of them are deferred. */
  deferredCount: number;
  /** ⚠️ At COST. */
  totalValue: string;
  oldestAgeDays: number;
  buckets: { fresh: number; ageing: number; overdue: number };
  /** Oldest first, capped — see `DISPUTE_ROW_CAP`. Never the basis for a count or a total. */
  rows: OpenDisputeRow[];
}

/** Display cap for the tile's list. ⛔ Never applied to a count or a money figure (phase §2.2). */
export const DISPUTE_ROW_CAP = 20;

/**
 * ⚠️ **The 15-day boundary is not invented here.** It is the same threshold v1's *wastage*
 * forced-resolution backstop already uses, applied to the dispute type that never got one
 * (phase-6 plan §6 Q3). 4 of 9 live disputes are past it right now.
 */
const AGEING_FROM_DAYS = 7;
const OVERDUE_FROM_DAYS = 15;

/**
 * Every unresolved receiving dispute, with its AGE — the figure whose absence let 4 of 9 live
 * disputes pass 15 days unnoticed (phase-6 plan §9 item 9, an exit criterion for the phase).
 *
 * ⭐ **The set is `status <> 'resolved'` — the identical predicate `tradeDiscrepanciesRepo.unresolved`
 * and `.blocking` use, and this is a THIRD CONSUMER of it, never a third definition.** That file's
 * header states why: v1 kept a separate count for the day-open block and a separate list for the
 * screen, and when they disagreed the screen showed nothing to fix while the block still refused to
 * open the day.
 *
 * ⚠️ **A deferred dispute is still counted and still ages.** A deferral is *"a promise to decide by a
 * date, not an exemption"* (T-174's schema header) — its clock does not reset. Hiding deferred rows
 * is how the breach would become invisible a second time.
 *
 * ⚠️ `store_id` on a discrepancy is the **COMMISSARY's** store, not the branch's: the stranded value
 * is on its books and its manager disposes of it (T-174 invariant 11).
 *
 * ⛔ **Deliberately NOT filtered to internal orders**, unlike the other two functions here. A
 * discrepancy row can only be written by `confirmReceipt`, which runs on the internal branch alone —
 * so the scope is already total, and adding the condition would buy nothing while breaking the
 * property above: the predicate would no longer be character-for-character the one the day-open
 * block uses, which is the only thing keeping the tile and the block from disagreeing.
 */
export async function openDisputes(
  ex: Executor,
  filter: CommissaryKpiFilter,
): Promise<OpenDisputeSummary> {
  const scope = filter.storeId ? sql`and d.store_id = ${filter.storeId}` : sql``;
  const age = sql`(${MANILA_TODAY} - ${manilaDateOf('d.created_at')})`;

  // Aggregate over the WHOLE set. ⛔ Never over the capped rows below.
  const [totals] = (await ex.execute(sql`
    select
      count(*)::int as count,
      (count(*) filter (where d.status = 'deferred'))::int as deferred_count,
      round(coalesce(sum(d.value), 0), 2)::text as total_value,
      coalesce(max(${age}), 0)::int as oldest_age_days,
      (count(*) filter (where ${age} < ${AGEING_FROM_DAYS}))::int as fresh,
      (count(*) filter (where ${age} >= ${AGEING_FROM_DAYS} and ${age} <= ${OVERDUE_FROM_DAYS}))::int as ageing,
      (count(*) filter (where ${age} > ${OVERDUE_FROM_DAYS}))::int as overdue
    from trade_discrepancies d
    where d.org_id = ${filter.orgId}
      and d.status <> 'resolved'
      ${scope}
  `)) as unknown as {
    count: number;
    deferred_count: number;
    total_value: string;
    oldest_age_days: number;
    fresh: number;
    ageing: number;
    overdue: number;
  }[];

  const rows = (await ex.execute(sql`
    select
      d.id, d.order_id, d.store_id, o.reference_no, o.order_date::text as order_date,
      d.quantity::text as quantity, d.value::text as value, d.status,
      d.deferred_to::text as deferred_to,
      ${age}::int as age_days
    from trade_discrepancies d
    join trade_orders o on o.id = d.order_id
    where d.org_id = ${filter.orgId}
      and d.status <> 'resolved'
      ${scope}
    order by d.created_at asc
    limit ${DISPUTE_ROW_CAP}
  `)) as unknown as Record<string, unknown>[];

  return {
    count: Number(totals?.count ?? 0),
    deferredCount: Number(totals?.deferred_count ?? 0),
    totalValue: totals?.total_value ?? '0.00',
    oldestAgeDays: Number(totals?.oldest_age_days ?? 0),
    buckets: {
      fresh: Number(totals?.fresh ?? 0),
      ageing: Number(totals?.ageing ?? 0),
      overdue: Number(totals?.overdue ?? 0),
    },
    rows: rows.map((r) => ({
      id: String(r.id),
      orderId: String(r.order_id),
      storeId: String(r.store_id),
      referenceNo: r.reference_no == null ? null : String(r.reference_no),
      orderDate: String(r.order_date),
      quantity: String(r.quantity),
      value: String(r.value),
      status: String(r.status),
      deferredTo: r.deferred_to == null ? null : String(r.deferred_to),
      ageDays: Number(r.age_days),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Received in range — the corrected figure
// ---------------------------------------------------------------------------------------------

export interface ReceivedSummary {
  orderCount: number;
  /** ⭐ THE figure: `Σ (received_quantity × rate)`. Derived from lines; the order header is never
   *  read for it. */
  goodsReceivedValue: string;
  /** `Σ line_total`. At dispatch `line_total` is re-derived to `fulfilled_quantity × rate`
   *  (`fulfilment.ts:132`), so this is genuinely what left the commissary. */
  goodsDispatchedValue: string;
  /**
   * Short on lines that DID record a receipt. Non-zero means goods are genuinely missing and a
   * dispute should exist for them.
   */
  shortReceivedValue: string;
  /**
   * ⭐ Value on lines with **no line-level receipt recorded at all** (`received_quantity is null`) —
   * named rather than folded into either of the two above.
   *
   * ⛔ **Folding it into `shortReceivedValue` invents a shortfall that never happened**, and folding
   * it into `goodsReceivedValue` claims a receipt nobody signed. Both were tried; both are wrong.
   * A **ledger-only** line is the honest case that lands here — `receiveTradeOrder` skips it
   * deliberately (*"this line moves no branch stock"*, `trade/index.ts:775,787`), so its value moved
   * on the books while no stock receipt exists to record. Phase §2.2: a figure whose basis is
   * incomplete says so on the screen.
   *
   * The four fields satisfy `dispatched = received + short + unrecorded`, exactly.
   */
  unrecordedValue: string;
  /** ⚠️ Freight and other fees, stated SEPARATELY and never blended into the goods figure —
   *  `trade_orders.delivery_fee`'s own rule: *"ON TOP, never into the item's cost."* v1's
   *  `Σ totalAmount` silently included it. */
  feesValue: string;
}

/**
 * What actually arrived in a date range, and what it cost to get there — the corrected form of v1's
 * `monthReceivedTotal`.
 *
 * ⭐ **`goodsDispatchedValue + feesValue` is what v1 would have reported.** Both are on the return so
 * the difference is legible on screen rather than merely absent: a manager who sees "₱31,000
 * dispatched, ₱27,900 received, ₱3,100 short" learns something the single corrected number hides.
 *
 * ⚠️ Fees are summed per ORDER in its own CTE. Summing them across the line join would multiply a
 * ₱500 delivery fee by the order's line count.
 */
export async function receivedInRange(
  ex: Executor,
  filter: CommissaryKpiFilter & { fromDate: string; toDate: string },
): Promise<ReceivedSummary> {
  const [row] = (await ex.execute(sql`
    with ord as (
      select o.id, o.delivery_fee, o.other_fees
      from trade_orders o
      join customers c on c.id = o.customer_id
      where o.org_id = ${filter.orgId}
        and o.status = 'received'
        and o.received_at is not null
        ${INTERNAL_ONLY}
        and ${manilaDateOf('o.received_at')} >= ${filter.fromDate}
        and ${manilaDateOf('o.received_at')} <= ${filter.toDate}
        ${filter.storeId ? sql`and o.store_id = ${filter.storeId}` : sql``}
    ),
    ln as (
      select
        -- Recorded receipts only. ⛔ A NULL received_quantity is NOT a zero receipt.
        round(coalesce(sum(l.received_quantity * l.rate)
                       filter (where l.received_quantity is not null), 0), 2) as goods_received,
        round(coalesce(sum(l.line_total)
                       filter (where l.received_quantity is not null), 0), 2) as dispatched_recorded,
        round(coalesce(sum(l.line_total), 0), 2) as goods_dispatched,
        round(coalesce(sum(l.line_total)
                       filter (where l.received_quantity is null), 0), 2) as unrecorded
      from trade_order_lines l
      join ord on ord.id = l.order_id
    )
    select
      (select count(*) from ord)::int as order_count,
      ln.goods_received::text as goods_received_value,
      ln.goods_dispatched::text as goods_dispatched_value,
      (ln.dispatched_recorded - ln.goods_received)::text as short_received_value,
      ln.unrecorded::text as unrecorded_value,
      (select round(coalesce(sum(delivery_fee + other_fees), 0), 2) from ord)::text as fees_value
    from ln
  `)) as unknown as Record<string, unknown>[];

  return {
    orderCount: Number(row?.order_count ?? 0),
    goodsReceivedValue: String(row?.goods_received_value ?? '0.00'),
    goodsDispatchedValue: String(row?.goods_dispatched_value ?? '0.00'),
    shortReceivedValue: String(row?.short_received_value ?? '0.00'),
    unrecordedValue: String(row?.unrecorded_value ?? '0.00'),
    feesValue: String(row?.fees_value ?? '0.00'),
  };
}

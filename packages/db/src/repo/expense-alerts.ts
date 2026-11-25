/**
 * T-639 - expense alerts: rules that flag unusual spending. docs/tasks/639-expense-alerts.md.
 *
 * Same shape as every detector in `findings.ts`: each function is a QUESTION asked of `expenses` on every read and returns what is
 * unusual. Nothing is stored (the acknowledge flow stays the findings module's), nothing is blocked, nothing is posted. All of them
 * are `soft`: they nag whoever can act and never hold a month close or refuse an expense.
 *
 * ## Where the numbers come from
 * The thresholds are business rules (`expenses.alert_*` in the domain's rule registry, edited on /settings/business-rules). A repo may
 * not import the domain (ADR-004), so the domain reads them and passes them in as `ExpenseAlertThresholds` through a resolver,
 * `ThresholdsFor(categoryId)`. Today the resolver returns the one organisation default for every category; a per-category override is
 * the same function returning a different object, with no change here.
 *
 * ## Weeks
 * Monday to Sunday, in the store's business date. `expenses.business_date` is already a Manila business date, so
 * `date_trunc('week', business_date)` (ISO, Monday first) is the week, and "today" is `MANILA_TODAY` (never `current_date`).
 * `asOf` lets a test pin today, as `posUsagePullNotRun` does.
 *
 * ## Money
 * Every amount is minted to `Money` and handled in scaled bigint (`@shareat/core/money`); a multiplier is a count of hundredths
 * (1.5 is 150n) applied with `multiplyByFraction`, so there is no float anywhere in the maths.
 *
 * ## What counts
 * Statistical detectors read OPEX and COGS only. CAPEX is lumpy by nature (one oven is a "spike") and PERSONAL is an owner's drawing,
 * not operating spend ("looks personal" is a separate judgement, not in this task). Voided expenses never count; a draft does, so a
 * manager hears about a big expense before it is approved.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { add, compare, divideMoney, formatMoney, money, multiplyByFraction, negate, subtract, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { mediumBusinessDate, parseBusinessDate } from '@shareat/core/datetime';
import { MANILA_TODAY } from './sql-time';
import { consumptionWindow } from './budgets';
import type { DetectedFinding } from './findings';

// shortcut: these method sizes are constants, not screen settings: they say how the detector measures, not what a business tolerates;
// upgrade to rules only if Ian wants to tune the look-back itself.
/** The full weeks before this one that "usual" is measured over. */
export const HISTORY_WEEKS = 8;
/** Fewer weeks with any spending than this and there is no "usual" yet (a new category or store must not alarm on its first weeks). */
export const MIN_HISTORY_WEEKS = 3;
/** The look-back a single expense is compared against. */
export const OUTLIER_DAYS = 90;
/** Earlier expenses needed in that look-back before one can stand out. */
export const OUTLIER_MIN_HISTORY = 10;
/** Same store, supplier and amount within this many days is a possible duplicate. */
export const DUPLICATE_DAYS = 3;
/** Single-expense detectors judge expenses of the last this-many days, the life of an acknowledgement, so a finding does not outlive its usefulness. */
export const RECENT_DAYS = 30;

export interface ExpenseAlertThresholds {
  /** Spike multiplier in hundredths: 150n is 1.5 times. */
  spikeX100: bigint;
  /** The peso floor: smallest extra spend, single expense or duplicate amount worth an alert. */
  minAmount: Money;
  /** Outlier multiplier (of the MAD) in hundredths: 500n is 5 times. */
  outlierX100: bigint;
  /** Frequency multiplier in hundredths: 200n is 2 times. */
  frequencyX100: bigint;
  /** Fewest expenses in a week before a frequency jump is flagged. */
  frequencyMinCount: number;
}

export type ThresholdsFor = (categoryId: string) => ExpenseAlertThresholds;

// ---------------------------------------------------------------------------------------------
// The pure maths (no SQL, no clock): everything a unit test pins.
// ---------------------------------------------------------------------------------------------

/** The middle value; the two middle ones are averaged (rounded half-up to the centavo) when the count is even. `null` when empty. */
export function medianMoney(values: readonly Money[]): Money | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => {
    const d = toCentavos(a) - toCentavos(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  });
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : divideMoney(add(sorted[mid - 1]!, sorted[mid]!), 2);
}

/**
 * The usual week: the median of the weeks that HAD spending (a week of zero is no information about the usual week, it is a week the
 * category was not used). `null` until at least `MIN_HISTORY_WEEKS` such weeks exist.
 */
export function usualWeeklySpend(weeklyTotals: readonly Money[]): Money | null {
  const spent = weeklyTotals.filter((t) => compare(t, ZERO) > 0);
  return spent.length < MIN_HISTORY_WEEKS ? null : medianMoney(spent);
}

/** More than `X` times the usual AND at least the peso floor above it. */
export function isSpendSpike(thisWeek: Money, usual: Money, t: Pick<ExpenseAlertThresholds, 'spikeX100' | 'minAmount'>): boolean {
  return compare(thisWeek, multiplyByFraction(usual, t.spikeX100, 100n)) > 0 && compare(subtract(thisWeek, usual), t.minAmount) >= 0;
}

/** `a` over `b` as text to one decimal, half-up: 200000 over 100000 is "2.0". `b` must be positive. */
export function ratioText(a: Money, b: Money): string {
  const den = toCentavos(b);
  const tenths = (toCentavos(a) * 20n + den) / (den * 2n);
  return `${tenths / 10n}.${tenths % 10n}`;
}

const abs = (m: Money): Money => (compare(m, ZERO) < 0 ? negate(m) : m);

/** Median absolute deviation: the median of how far each value sits from the median. `null` when empty. */
export function madOf(values: readonly Money[]): { median: Money; mad: Money } | null {
  const median = medianMoney(values);
  if (!median) return null;
  return { median, mad: medianMoney(values.map((v) => abs(subtract(v, median))))! };
}

export interface OutlierLimit {
  median: Money;
  mad: Money;
  /** median + k x MAD. */
  limit: Money;
}

/** The limit for one category at one store, or `null` while there are fewer than `OUTLIER_MIN_HISTORY` earlier expenses to judge by. */
export function outlierLimit(history: readonly Money[], outlierX100: bigint): OutlierLimit | null {
  if (history.length < OUTLIER_MIN_HISTORY) return null;
  const { median, mad } = madOf(history)!;
  return { median, mad, limit: add(median, multiplyByFraction(mad, outlierX100, 100n)) };
}

/** Above the limit AND at least the peso floor above the typical amount (a category with identical amounts has a MAD of zero: the floor stops a 50-peso difference flagging). */
export function isOutlier(amount: Money, o: OutlierLimit, minAmount: Money): boolean {
  return compare(amount, o.limit) > 0 && compare(subtract(amount, o.median), minAmount) >= 0;
}

/** More than `X` times the average weekly count of the last `HISTORY_WEEKS` weeks (zero weeks count, a count of none is a count), and at least the minimum, in whole numbers. */
export function isFrequencyJump(thisCount: number, historyCount: number, t: Pick<ExpenseAlertThresholds, 'frequencyX100' | 'frequencyMinCount'>): boolean {
  return thisCount >= t.frequencyMinCount && BigInt(thisCount) * BigInt(HISTORY_WEEKS) * 100n > t.frequencyX100 * BigInt(historyCount);
}

/** The average weekly count over `HISTORY_WEEKS`, to one decimal, half-up. */
export function meanCountText(historyCount: number): string {
  const tenths = Math.floor((historyCount * 20 + HISTORY_WEEKS) / (HISTORY_WEEKS * 2));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

// ---------------------------------------------------------------------------------------------
// The detectors
// ---------------------------------------------------------------------------------------------

const peso = (m: Money): string => formatMoney(m);
const humanDay = (businessDate: string): string => mediumBusinessDate(parseBusinessDate(businessDate));
const todayOf = (asOf?: string) => (asOf ? sql`${asOf}::date` : MANILA_TODAY);

/** One place for "is this a statistical subject": operating spend only, never voided. */
const OPERATING = sql`e.status <> 'voided' and c."group" in ('OPEX', 'COGS')`;

/**
 * Detectors 1 and 3, from ONE query: a category's spend in a week against its usual week (Ian's example: meat is ordinarily 100k a
 * week and is now 200k), and the number of expenses in a week against the usual count. Two weeks are judged: this week and the last
 * completed one, each against the `HISTORY_WEEKS` full weeks before IT, so a Friday to Sunday spike still shows on Monday.
 * Findings are keyed by store, category and week, so a spike is accepted for the week it happened in and a new week is asked afresh.
 */
export async function categorySpendAlerts(tx: Tx, orgId: string, thresholdsFor: ThresholdsFor, asOf?: string): Promise<DetectedFinding[]> {
  const today = todayOf(asOf);
  const rows = (await tx.execute(sql`
    select e.store_id::text as store_id, s.name as store_name, e.category_id::text as category_id, c.category,
           date_trunc('week', e.business_date)::date::text as week_start,
           ((date_trunc('week', ${today})::date - date_trunc('week', e.business_date)::date) / 7)::int as weeks_back,
           sum(e.total_amount)::text as total, count(*)::int as n
      from expenses e
      join stores s on s.id = e.store_id
      join expense_categories c on c.id = e.category_id
     where e.org_id = ${orgId}
       and ${OPERATING}
       and e.business_date >= (date_trunc('week', ${today})::date - ${(HISTORY_WEEKS + 1) * 7}::int)
       and e.business_date <= ${today}
     group by e.store_id, s.name, e.category_id, c.category, date_trunc('week', e.business_date)
  `)) as unknown as {
    store_id: string;
    store_name: string;
    category_id: string;
    category: string;
    week_start: string;
    weeks_back: number;
    total: string;
    n: number;
  }[];

  const groups = new Map<string, { storeId: string; storeName: string; categoryId: string; category: string; weeks: { week: string; back: number; total: Money; n: number }[] }>();
  for (const r of rows) {
    const key = `${r.store_id}:${r.category_id}`;
    const g = groups.get(key) ?? { storeId: r.store_id, storeName: r.store_name, categoryId: r.category_id, category: r.category, weeks: [] };
    g.weeks.push({ week: r.week_start, back: r.weeks_back, total: money(r.total), n: r.n });
    groups.set(key, g);
  }

  const found: DetectedFinding[] = [];
  for (const g of groups.values()) {
    const t = thresholdsFor(g.categoryId);
    for (const [back, when] of [[0, 'this week'], [1, 'last week']] as const) {
      const current = g.weeks.find((w) => w.back === back);
      if (!current) continue;
      const history = g.weeks.filter((w) => w.back > back && w.back <= back + HISTORY_WEEKS);

      const usual = usualWeeklySpend(history.map((w) => w.total));
      if (usual && isSpendSpike(current.total, usual, t)) {
        found.push({
          kind: 'expenseCategorySpike',
          key: `expenseCategorySpike:${g.storeId}:${g.categoryId}:${current.week}`,
          storeId: g.storeId,
          severity: 'soft',
          detail:
            `${g.category}: ${peso(current.total)} ${when} at ${g.storeName}, usually about ${peso(usual)} (${ratioText(current.total, usual)}×). ` +
            'Worth asking what changed. Nothing is blocked; this is only a nudge.',
        });
      }

      const historyCount = history.reduce((a, w) => a + w.n, 0);
      if (history.length >= MIN_HISTORY_WEEKS && isFrequencyJump(current.n, historyCount, t)) {
        found.push({
          kind: 'expenseFrequencySpike',
          key: `expenseFrequencySpike:${g.storeId}:${g.categoryId}:${current.week}`,
          storeId: g.storeId,
          severity: 'soft',
          detail:
            `${g.category}: ${current.n} expenses ${when} at ${g.storeName}, usually about ${meanCountText(historyCount)} a week. ` +
            'Many small expenses can be one purchase split up. Nothing is blocked.',
        });
      }
    }
  }
  return found;
}

/**
 * Detector 2: one expense far above the usual for its category at its store. Judged against the other expenses of the last
 * `OUTLIER_DAYS`; only expenses of the last `RECENT_DAYS` are candidates.
 */
export async function singleExpenseOutliers(tx: Tx, orgId: string, thresholdsFor: ThresholdsFor, asOf?: string): Promise<DetectedFinding[]> {
  const today = todayOf(asOf);
  const rows = (await tx.execute(sql`
    select e.id::text as expense_id, e.store_id::text as store_id, s.name as store_name, e.category_id::text as category_id, c.category,
           e.business_date::text as business_date, e.total_amount::text as amount, sup.name as supplier_name,
           (e.business_date >= ${today} - ${RECENT_DAYS}::int) as recent
      from expenses e
      join stores s on s.id = e.store_id
      join expense_categories c on c.id = e.category_id
      join suppliers sup on sup.id = e.supplier_id
     where e.org_id = ${orgId}
       and ${OPERATING}
       and e.business_date >= ${today} - ${OUTLIER_DAYS}::int
       and e.business_date <= ${today}
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    category_id: string;
    category: string;
    business_date: string;
    amount: string;
    supplier_name: string;
    recent: boolean;
  }[];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.store_id}:${r.category_id}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const found: DetectedFinding[] = [];
  for (const list of groups.values()) {
    if (list.length <= OUTLIER_MIN_HISTORY) continue; // a candidate plus ten earlier ones at the very least
    for (const r of list) {
      if (!r.recent) continue;
      const t = thresholdsFor(r.category_id);
      const limit = outlierLimit(
        list.filter((o) => o.expense_id !== r.expense_id).map((o) => money(o.amount)),
        t.outlierX100,
      );
      if (!limit || !isOutlier(money(r.amount), limit, t.minAmount)) continue;
      found.push({
        kind: 'expenseOutlier',
        key: `expenseOutlier:${r.expense_id}`,
        storeId: r.store_id,
        severity: 'soft',
        detail:
          `${r.store_name}: ${peso(money(r.amount))} for ${r.category} to ${r.supplier_name} on ${humanDay(r.business_date)} is far above the usual ` +
          `${peso(limit.median)} for this category here. Worth a second look; nothing is blocked.`,
      });
    }
  }
  return found;
}

/** The advisory kinds this file raises: nudges, not tasks, so the manager scorecard and finding_occurrences leave them out. */
export const EXPENSE_ALERT_KINDS: ReadonlySet<string> = new Set([
  'expenseCategorySpike',
  'expenseOutlier',
  'expenseFrequencySpike',
  'expenseDuplicate',
  'expenseSelfApproved',
  'expenseOverBudget',
]);

/**
 * Detector 5: the same store, supplier and amount more than once within `DUPLICATE_DAYS` of each other. ONE finding per cluster (days
 * chain: the 1st, 3rd and 5th are one cluster), never a pair or a side, keyed by the earliest member (by business date, then id, so a
 * later duplicate joining the cluster does not change the key and lose its acknowledgement).
 */
export async function possibleDuplicateExpenses(tx: Tx, orgId: string, thresholdsFor: ThresholdsFor, asOf?: string): Promise<DetectedFinding[]> {
  const today = todayOf(asOf);
  // Both sides are date-bounded so the (org_id, business_date) index serves the self-join: a pair's newer side is within RECENT_DAYS, so both are within RECENT_DAYS + DUPLICATE_DAYS.
  const rows = (await tx.execute(sql`
    select a.id::text as a_id, b.id::text as b_id, a.store_id::text as store_id, s.name as store_name, a.category_id::text as category_id,
           ec.category, sup.name as supplier_name, a.total_amount::text as amount,
           a.business_date::text as a_date, b.business_date::text as b_date
      from expenses a
      join expenses b on b.org_id = a.org_id and b.store_id = a.store_id and b.supplier_id = a.supplier_id
                     and b.total_amount = a.total_amount and b.id > a.id
                     and abs(b.business_date - a.business_date) <= ${DUPLICATE_DAYS}::int
      join stores s on s.id = a.store_id
      join suppliers sup on sup.id = a.supplier_id
      join expense_categories ec on ec.id = a.category_id
     where a.org_id = ${orgId}
       and a.business_date >= ${today} - ${RECENT_DAYS + DUPLICATE_DAYS}::int
       and b.business_date >= ${today} - ${RECENT_DAYS + DUPLICATE_DAYS}::int
       and a.status <> 'voided' and b.status <> 'voided'
       and greatest(a.business_date, b.business_date) >= ${today} - ${RECENT_DAYS}::int
  `)) as unknown as {
    a_id: string;
    b_id: string;
    store_id: string;
    store_name: string;
    category_id: string;
    category: string;
    supplier_name: string;
    amount: string;
    a_date: string;
    b_date: string;
  }[];

  // Union the pairs into clusters: each pair links two ids, a cluster is a connected set of ids.
  type Row = (typeof rows)[number];
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const members = new Map<string, { date: string; row: Row }>();
  for (const r of rows) {
    for (const [id, date] of [[r.a_id, r.a_date], [r.b_id, r.b_date]] as const) {
      if (!parent.has(id)) parent.set(id, id);
      members.set(id, { date, row: r });
    }
    parent.set(root(r.a_id), root(r.b_id));
  }
  const clusters = new Map<string, { id: string; date: string; row: Row }[]>();
  for (const [id, m] of members) {
    const list = clusters.get(root(id)) ?? [];
    list.push({ id, ...m });
    clusters.set(root(id), list);
  }

  const found: DetectedFinding[] = [];
  for (const list of clusters.values()) {
    list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id < y.id ? -1 : 1));
    const first = list[0]!;
    const r = first.row;
    if (compare(money(r.amount), thresholdsFor(r.category_id).minAmount) < 0) continue;
    const days = [...new Set(list.map((m) => m.date))].map(humanDay);
    const when = days.length === 1 ? `${list.length === 2 ? 'both' : 'all'} on ${days[0]}` : `on ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
    found.push({
      kind: 'expenseDuplicate',
      key: `expenseDuplicate:${first.id}`,
      storeId: r.store_id,
      severity: 'soft',
      detail:
        `${r.store_name}: ${list.length === 2 ? 'two' : list.length} ${peso(money(r.amount))} expenses to ${r.supplier_name} (${r.category}), ${when}. ` +
        'A repeat entry, or real purchases? Nothing is blocked.',
    });
  }
  return found;
}

/** Detector 6: an expense approved by the person who recorded it. The approval flow allows it, so it is a nudge, not a refusal. */
export async function selfApprovedExpenses(tx: Tx, orgId: string, thresholdsFor: ThresholdsFor, asOf?: string): Promise<DetectedFinding[]> {
  const today = todayOf(asOf);
  const rows = (await tx.execute(sql`
    select e.id::text as expense_id, e.store_id::text as store_id, s.name as store_name, e.category_id::text as category_id, c.category,
           e.total_amount::text as amount, e.business_date::text as business_date, p.display_name as person_name
      from expenses e
      join stores s on s.id = e.store_id
      join expense_categories c on c.id = e.category_id
      join persons p on p.id = e.created_by
     where e.org_id = ${orgId}
       and e.status = 'posted'
       and e.approved_by is not null
       and e.approved_by = e.created_by
       and e.business_date >= ${today} - ${RECENT_DAYS}::int
  `)) as unknown as {
    expense_id: string;
    store_id: string;
    store_name: string;
    category_id: string;
    category: string;
    amount: string;
    business_date: string;
    person_name: string;
  }[];

  return rows
    .filter((r) => compare(money(r.amount), thresholdsFor(r.category_id).minAmount) >= 0)
    .map((r) => ({
      kind: 'expenseSelfApproved',
      key: `expenseSelfApproved:${r.expense_id}`,
      storeId: r.store_id,
      severity: 'soft' as const,
      detail:
        `${r.store_name}: ${r.person_name} recorded and approved their own ${peso(money(r.amount))} ${r.category} expense from ${humanDay(r.business_date)}. ` +
        'A second person would normally approve it. Nothing is blocked.',
    }));
}

/**
 * Detector 4: a budget cap exceeded. There was no budget finding before this one (T-215 shows the cap on the expense screen only), so this
 * reuses the budgets' own consumption window (`consumptionWindow`, exported from `budgets.ts`) rather than restating it. Live budgets are
 * this month's period caps and any reset-style cap whose window began in the last 31 days.
 */
export async function expenseOverBudget(tx: Tx, orgId: string, asOf?: string): Promise<DetectedFinding[]> {
  const today = todayOf(asOf);
  const rows = (await tx.execute(sql`
    select b.id::text as budget_id, b.store_id::text as store_id, s.name as store_name, c.category, b.amount::text as amount,
           coalesce((
             select sum(e.total_amount)
               from expenses e
              where e.org_id = b.org_id and e.store_id = b.store_id
                and e.category_id = b.category_id and e.status = 'posted'
                and ${consumptionWindow()}
           ), 0)::text as consumed
      from expense_budgets b
      join stores s on s.id = b.store_id
      join expense_categories c on c.id = b.category_id
     where b.org_id = ${orgId}
       and (b.period_key = to_char(${today}, 'YYYYMM')
            or (b.last_reset_at is not null and b.last_reset_at::date >= ${today} - 31))
  `)) as unknown as { budget_id: string; store_id: string; store_name: string; category: string; amount: string; consumed: string }[];

  return rows
    .filter((r) => compare(money(r.consumed), money(r.amount)) > 0)
    .map((r) => ({
      kind: 'expenseOverBudget',
      key: `expenseOverBudget:${r.budget_id}`,
      storeId: r.store_id,
      severity: 'soft' as const,
      detail:
        `${r.store_name}: ${r.category} spending is ${peso(money(r.consumed))} against a cap of ${peso(money(r.amount))}, ` +
        `${peso(subtract(money(r.consumed), money(r.amount)))} over. A cap never stops an expense; this is the nudge.`,
    }));
}

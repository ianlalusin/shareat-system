/**
 * The only place SQL is written for expense budgets. T-215.
 *
 * ⛔ **Consumption is a query, never a column.** v1 keeps `consumedAmount` on the budget document
 * and increments it from the expense actions; that is the same shape as AR's `outstandingAmount`,
 * measured **wrong on 106 of 794 live rows (13.3%)**. Bible §4.2 rule 7 (extended by §13 row 173)
 * bans a separately-accumulated counter *"even when it is called a cache"*.
 *
 * ⛔ **And it is grouped by `category_id`, never by `account_code`.** Measured on the seed on
 * 2026-09-06: 39 categories, **36 distinct account codes** — `6890`, `6620` and `6600` are each
 * shared by two categories. An account-code roll-up silently over-counts six envelopes, and the
 * failure is invisible: a manager sees a cap as exhausted when half the spend belongs elsewhere.
 * `budgets.test.ts` case 2 is that exact scenario, and it is the one test that catches a wrong
 * implementation. (DEF-193 records the same collision from the other direction.)
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { expenseBudgets, type ReissueInterval } from '../../schema/expense-budgets';

export interface ExpenseBudgetRow {
  id: string;
  orgId: string;
  storeId: string;
  categoryId: string;
  periodKey: string;
  amount: string;
  autoReissue: boolean;
  reissueInterval: ReissueInterval | null;
  reissuedFromId: string | null;
  lastResetAt: Date | null;
}

/** A budget with the two figures nobody stores: what has been spent, and what is left. */
export interface BudgetWithConsumption extends ExpenseBudgetRow {
  categoryGroup: string;
  categoryLabel: string;
  accountCode: string | null;
  consumed: string;
  remaining: string;
  /** ⚠️ `true` only when the cap is genuinely exceeded — never merely reached. */
  overBudget: boolean;
}

/**
 * ⭐ **The window a budget's consumption is measured over — and it is not always the period.**
 *
 * Two shapes, and `last_reset_at` is the discriminator:
 *
 * - **No reset has happened** (`last_reset_at is null`) — the window is the `YYYYMM` period. That
 *   covers every plain cap and every period-interval one.
 * - **A reset has happened** — the window is `[last_reset_at, now)`, and **the period no longer
 *   bounds it.**
 *
 * ⛔ **The second half is the part that is easy to get wrong, and getting it wrong is silent.** A
 * `weekly` cap lives on a `YYYYMM` row and v1 keeps it there — reset intervals move the same
 * document, period intervals create a new one. Keep the period filter as well as the window and a
 * weekly budget stops counting anything the moment its window crosses into the next month: the
 * `business_date >= last_reset_at` clause and the `= period_key` clause can no longer both be
 * true, so consumption reads **zero for ever** and the cap silently becomes infinite. A budget
 * that reports zero spent is indistinguishable from one nobody has spent against.
 *
 * ⭐ v1 could not express any of this: its reset had to ZERO a stored counter, so the same row
 * could never remember when its window began. Deriving consumption is what makes the window a
 * fact instead of a side effect.
 */
function consumptionWindow(b = 'b', e = 'e'): ReturnType<typeof sql> {
  return sql.raw(
    `((${b}.last_reset_at is null and to_char(${e}.business_date, 'YYYYMM') = ${b}.period_key)` +
      ` or (${b}.last_reset_at is not null and ${e}.business_date >= ${b}.last_reset_at::date))`,
  );
}

/** Every cap set for one store in one period, each with its derived consumption. */
export async function listForStorePeriod(
  tx: Tx,
  orgId: string,
  storeId: string,
  periodKey: string,
): Promise<BudgetWithConsumption[]> {
  const rows = (await tx.execute(sql`
    select b.id, b.org_id, b.store_id, b.category_id, b.period_key,
           b.amount::text as amount, b.auto_reissue, b.reissue_interval,
           b.reissued_from_id, b.last_reset_at,
           c."group" as category_group, c.category, c.sub_category, c.account_code,
           coalesce((
             select sum(e.total_amount)
             from expenses e
             where e.org_id = b.org_id
               and e.store_id = b.store_id
               -- ⛔ category_id. NOT account_code — see this file's header.
               and e.category_id = b.category_id
               and e.status = 'posted'
               and ${consumptionWindow()}
           ), 0)::text as consumed
    from expense_budgets b
    join expense_categories c on c.id = b.category_id
    where b.org_id = ${orgId} and b.store_id = ${storeId} and b.period_key = ${periodKey}
    order by c."group", c.category, c.sub_category nulls first
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => {
    const amount = Number(r.amount);
    const consumed = Number(r.consumed);
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      storeId: String(r.store_id),
      categoryId: String(r.category_id),
      periodKey: String(r.period_key),
      amount: amount.toFixed(2),
      autoReissue: r.auto_reissue === true,
      reissueInterval: (r.reissue_interval as ReissueInterval | null) ?? null,
      reissuedFromId: r.reissued_from_id ? String(r.reissued_from_id) : null,
      lastResetAt: r.last_reset_at ? new Date(String(r.last_reset_at)) : null,
      categoryGroup: String(r.category_group),
      categoryLabel: r.sub_category ? `${String(r.category)} — ${String(r.sub_category)}` : String(r.category),
      accountCode: r.account_code ? String(r.account_code) : null,
      consumed: consumed.toFixed(2),
      // ⚠️ Remaining may be NEGATIVE and is deliberately not floored. `cashPayments` in v1's
      // sales report floors a residual at zero and hides exactly the signal worth seeing
      // (`docs/GLOSSARY.md`); an over-spent envelope is that signal here.
      remaining: (amount - consumed).toFixed(2),
      overBudget: consumed > amount + 0.005,
    };
  });
}

/**
 * What one category has left at one store, right now — the figure `/expenses/new` shows.
 *
 * ⚠️ Returns `null` when there is NO cap, which is not the same as a cap of zero. Zero means
 * *spend nothing here*; absent means *nobody has capped this*, and the screen must say so
 * differently or a category with no budget reads as one with no money.
 */
export async function remainingFor(
  tx: Tx,
  orgId: string,
  storeId: string,
  categoryId: string,
  periodKey: string,
): Promise<{ amount: string; consumed: string; remaining: string; overBudget: boolean } | null> {
  const [row] = (await tx.execute(sql`
    select b.amount::text as amount,
           coalesce((
             select sum(e.total_amount)
             from expenses e
             where e.org_id = b.org_id and e.store_id = b.store_id
               and e.category_id = b.category_id and e.status = 'posted'
               and ${consumptionWindow()}
           ), 0)::text as consumed
    from expense_budgets b
    where b.org_id = ${orgId} and b.store_id = ${storeId}
      and b.category_id = ${categoryId} and b.period_key = ${periodKey}
    limit 1
  `)) as unknown as Record<string, string>[];
  if (!row) return null;
  const amount = Number(row.amount);
  const consumed = Number(row.consumed);
  return {
    amount: amount.toFixed(2),
    consumed: consumed.toFixed(2),
    remaining: (amount - consumed).toFixed(2),
    overBudget: consumed > amount + 0.005,
  };
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<ExpenseBudgetRow | undefined> {
  const [row] = await tx
    .select()
    .from(expenseBudgets)
    .where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.orgId, orgId)))
    .limit(1);
  return row as ExpenseBudgetRow | undefined;
}

/**
 * Set or replace one envelope.
 *
 * ⭐ `ON CONFLICT` on the unique envelope, so re-setting a cap for a period that already has one
 * is an EDIT rather than a duplicate-key error a screen would have to explain. ⚠️ `last_reset_at`
 * is deliberately NOT touched here — editing an amount mid-week must not silently restart the
 * window and forgive the week's spending.
 */
export async function setBudget(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    categoryId: string;
    periodKey: string;
    amount: string;
    autoReissue: boolean;
    reissueInterval: ReissueInterval | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(expenseBudgets)
    .values(input)
    .onConflictDoUpdate({
      target: [expenseBudgets.orgId, expenseBudgets.storeId, expenseBudgets.categoryId, expenseBudgets.periodKey],
      set: {
        amount: input.amount,
        autoReissue: input.autoReissue,
        reissueInterval: input.reissueInterval,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: expenseBudgets.id });
  return row!;
}

/** ⚠️ Removing a cap is not the same as setting it to zero — it means "no cap", so the row goes. */
export async function removeBudget(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.delete(expenseBudgets).where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.orgId, orgId)));
}

/** Every auto-reissuing budget in an org, newest period first — the job's input. */
export async function listAutoReissuing(tx: Tx, orgId: string): Promise<ExpenseBudgetRow[]> {
  const rows = await tx
    .select()
    .from(expenseBudgets)
    .where(and(eq(expenseBudgets.orgId, orgId), eq(expenseBudgets.autoReissue, true)))
    .orderBy(sql`period_key desc`);
  return rows as ExpenseBudgetRow[];
}

/**
 * Clone a budget into the next period.
 *
 * ⛔ `ON CONFLICT DO NOTHING`, returning nothing when the row already exists — that is what makes
 * the job idempotent as a **database fact** rather than as a promise the job keeps. A second run
 * the same day creates nothing and does not throw.
 */
export async function insertReissued(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    categoryId: string;
    periodKey: string;
    amount: string;
    autoReissue: boolean;
    reissueInterval: ReissueInterval | null;
    reissuedFromId: string;
    createdBy: string | null;
  },
): Promise<{ id: string } | null> {
  const rows = await tx
    .insert(expenseBudgets)
    .values(input)
    .onConflictDoNothing({
      target: [expenseBudgets.orgId, expenseBudgets.storeId, expenseBudgets.categoryId, expenseBudgets.periodKey],
    })
    .returning({ id: expenseBudgets.id });
  return rows[0] ?? null;
}

/** Move a reset-interval budget's window forward. Returns false when nothing changed. */
export async function stampReset(tx: Tx, orgId: string, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(expenseBudgets)
    .set({ lastResetAt: at, updatedAt: sql`now()` })
    .where(and(eq(expenseBudgets.id, id), eq(expenseBudgets.orgId, orgId)))
    .returning({ id: expenseBudgets.id });
  return rows.length > 0;
}

/** Categories with no cap for this store/period — the *"No cap set"* half of `/budgets`. */
export async function categoriesWithoutBudget(
  tx: Tx,
  orgId: string,
  storeId: string,
  periodKey: string,
): Promise<{ id: string; label: string; group: string }[]> {
  const rows = (await tx.execute(sql`
    select c.id, c."group", c.category, c.sub_category
    from expense_categories c
    where c.org_id = ${orgId}
      and not exists (
        select 1 from expense_budgets b
        where b.org_id = c.org_id and b.category_id = c.id
          and b.store_id = ${storeId} and b.period_key = ${periodKey}
      )
    order by c."group", c.category, c.sub_category nulls first
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    id: String(r.id),
    group: String(r.group),
    label: r.sub_category ? `${String(r.category)} — ${String(r.sub_category)}` : String(r.category),
  }));
}

/**
 * Recurring-expense templates — create, edit, pause, resume, remove. T-216.
 *
 * ⛔ **THE JOB IS NOT HERE, AND THAT IS NOT AN OVERSIGHT.** Whether a due template **DRAFTS** an
 * expense for a person to confirm (this task's design, `docs/tasks/216-*.md` §3) or **AUTO-PAYS**
 * it on a cron (v1's) is an open decision for Ian, and it changes the job's *shape* rather than a
 * flag. A template table is identical either way, so it ships; a job built against the wrong answer
 * would have to be rewritten, and a job registered but never run is DEF-044's shape exactly — a
 * cron claimed in data and absent in fact.
 *
 * ⚠️ **Consequence, stated on the screen too:** until that job exists, **a template drafts
 * nothing.** It is a recorded intention and no more. Saying so out loud is the difference between
 * an inert feature and a silent one.
 *
 * ⭐ **Nothing here posts.** A template carries no journal entry and no money.
 */
import { moneyAccountsRepo, recurringExpensesRepo, transaction, type Tx } from '@shareat/db';
import type { RecurringInterval } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { compare, ZERO } from '@shareat/core/money';
import { parseDecimalInput } from '../shared/money-input';
import { parseWholeNumberInput } from '../shared/whole-number-input';
import { refuse } from '../shared/refusal';
import { firstDueDate, isAnchorValid } from './recurrence';

export interface CreateRecurringTemplateInput {
  storeId: string;
  name: string;
  categoryId: string;
  /**
   * The party the bill comes from - the landlord, the utility, the ISP.
   *
   * REQUIRED on a new template, though the COLUMN is nullable so the migration could land on rows
   * that predate it. The job cannot draft without it: `expenses.supplier_id` and
   * `expenses.supplier_invoice_id` are both NOT NULL, and `createExpense` is the only path in.
   */
  supplierId: string;
  defaultAmount: string;
  defaultMoneyAccountId?: string | null;
  interval: RecurringInterval;
  /** A raw box string is parsed here, after `authorize()` (T-374 S5 / DEF-579); a `number` is checked as-is. */
  anchorDay: number | string;
  /** Defaults to today (Manila). The first due date is derived, never typed. */
  from?: string;
  /**
   * ⛔ Required to name a CASHIER account as the default. v1's `payment-routing.ts` resolves an
   * ambiguous scheduled payment to office cash at runtime because *"a recurring/scheduled payment
   * must never silently draw from the cashier till"* — the till is the daily operating drawer.
   * Here the drift is impossible and the deliberate case is a **recorded fact**, not a fallback.
   */
  tillIsDeliberate?: boolean;
}

function manilaToday(nowMs = Date.now()): string {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Shared by create and edit: the account must exist, belong to this store, and — if it is a
 * cashier account — have been chosen deliberately.
 */
async function checkAccount(
  tx: Tx,
  orgId: string,
  storeId: string,
  accountId: string | null | undefined,
  tillIsDeliberate: boolean,
): Promise<boolean> {
  if (!accountId) return false;
  const account = await moneyAccountsRepo.getById(tx, orgId, accountId);
  if (!account) throw new Error('that money account does not exist.');
  if (account.storeId !== storeId) {
    throw new Error(`${account.name} belongs to a different store — a template pays from its own store's account.`);
  }
  if (account.custodian === 'cashier' && !tillIsDeliberate) {
    throw new Error(
      `${account.name} is a CASHIER account — the till is the daily operating drawer, and a bill ` +
        'that pays itself out of it leaves the day short with nothing naming why. Choose an office ' +
        'account, or tick "yes, really pay this from the till".',
    );
  }
  return account.custodian === 'cashier';
}

/**
 * T-374 S5 / DEF-579 — the anchor day arrives as the raw box string. `Number('')` is `0` (a blank weekly template became
 * Sunday) and `Number` reads `0x5` as 5 and `1e1` as 10; `parseWholeNumberInput` refuses all three. 0-31 is the widest
 * range of any interval; `isAnchorValid` then judges the day against the interval, unchanged.
 */
function parseAnchorDay(raw: number | string): number {
  return parseWholeNumberInput(raw, 'recurring template: anchorDay', 'The day', 0, 31);
}

export async function createRecurringTemplate(
  tx: Tx | null,
  actor: Actor,
  input: CreateRecurringTemplateInput,
): Promise<{ id: string; nextDueDate: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_recurring_expenses', { storeId: input.storeId });

    const name = input.name.trim();
    if (!name) throw new Error('give the template a name — "Lipa branch rent", not "expense 3".');
    // T-371: `recurring_expenses.default_amount` is NOT NULL with no default, so a blank is refused (R6), never an
    // invented zero; the positivity check compares the (14,2) brand, never a float.
    const defaultAmount = parseDecimalInput(
      input.defaultAmount,
      '14,2',
      'createRecurringTemplate: the default amount',
      'The default amount',
      { blank: 'refuse' },
    );
    if (compare(defaultAmount, ZERO) <= 0) {
      throw refuse(
        'a default amount has to be greater than zero. ⚠️ It is a DEFAULT — the drafted expense is edited against the real bill.',
        'The default amount has to be greater than zero. It is a default — the drafted expense is edited against the real bill.',
      );
    }
    // ⚠️ The database refuses this too; this exists so a person reads a sentence instead of a
    // constraint name. ⛔ It is not a second source of truth — the CHECK is the rule.
    const anchorDay = parseAnchorDay(input.anchorDay);
    if (!isAnchorValid(input.interval, anchorDay)) {
      throw new Error(
        input.interval === 'weekly' || input.interval === 'bi_weekly'
          ? `a ${input.interval} template is anchored on a day of the WEEK (0 = Sunday to 6).`
          : 'a monthly, quarterly or annual template is anchored on a day of the MONTH (1 to 31). A 31st anchor clamps to the month end; it is not refused.',
      );
    }

    if (!input.supplierId) {
      throw new Error(
        'name the supplier this bill comes from - the landlord, the utility, the ISP. The job ' +
          'records a pending invoice against them on the due date, and an expense cannot exist ' +
          'without one.',
      );
    }

    const deliberate = input.tillIsDeliberate === true;
    const isTill = await checkAccount(trx, actor.orgId, input.storeId, input.defaultMoneyAccountId, deliberate);

    // ⭐ DERIVED, never typed. A template created on the 3rd with a monthly anchor of the 15th is
    // due THIS month — getting that wrong makes every new template a month late, silently.
    const nextDueDate = firstDueDate(input.from ?? manilaToday(), input.interval, anchorDay);

    const { id } = await recurringExpensesRepo.insertTemplate(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      name,
      categoryId: input.categoryId,
      supplierId: input.supplierId,
      defaultAmount,
      defaultMoneyAccountId: input.defaultMoneyAccountId ?? null,
      // ⚠️ Recorded ONLY when it is actually true of this account, so the flag never claims a
      // deliberate choice about an office account nobody had to think about.
      tillIsDeliberate: isTill && deliberate,
      interval: input.interval,
      anchorDay,
      nextDueDate,
      createdBy: actor.personId,
    });
    return { id, nextDueDate };
  };
  if (tx) return run(tx);
  return transaction(run);
}

export interface UpdateRecurringTemplateInput {
  templateId: string;
  name?: string;
  categoryId?: string;
  supplierId?: string;
  defaultAmount?: string;
  defaultMoneyAccountId?: string | null;
  interval?: RecurringInterval;
  /** Omitted leaves the stored day unchanged; a supplied blank is refused (T-374 S5 / DEF-579). */
  anchorDay?: number | string;
  tillIsDeliberate?: boolean;
}

export async function updateRecurringTemplate(
  tx: Tx | null,
  actor: Actor,
  input: UpdateRecurringTemplateInput,
): Promise<void> {
  const run = async (trx: Tx) => {
    const template = await recurringExpensesRepo.getById(trx, actor.orgId, input.templateId);
    if (!template) throw new Error('that template does not exist.');
    await authorize(trx, actor, 'manage_recurring_expenses', { storeId: template.storeId });

    const interval = input.interval ?? template.interval;
    const suppliedAnchorDay = input.anchorDay === undefined ? undefined : parseAnchorDay(input.anchorDay);
    const anchorDay = suppliedAnchorDay ?? template.anchorDay;
    if (!isAnchorValid(interval, anchorDay)) {
      throw new Error(`anchor ${anchorDay} is out of range for a ${interval} template.`);
    }
    // T-371: absent leaves the column unchanged; a SUPPLIED blank is refused (R6 — NOT NULL, no default), never zeroed.
    const defaultAmount =
      input.defaultAmount !== undefined
        ? parseDecimalInput(input.defaultAmount, '14,2', 'updateRecurringTemplate: the default amount', 'The default amount', {
            blank: 'refuse',
          })
        : undefined;
    if (defaultAmount !== undefined && compare(defaultAmount, ZERO) <= 0) {
      throw refuse('a default amount has to be greater than zero.', 'The default amount has to be greater than zero.');
    }

    const deliberate = input.tillIsDeliberate ?? template.tillIsDeliberate;
    const accountId =
      input.defaultMoneyAccountId === undefined ? template.defaultMoneyAccountId : input.defaultMoneyAccountId;
    const isTill = await checkAccount(trx, actor.orgId, template.storeId, accountId, deliberate);

    // ⚠️ Changing the INTERVAL or the ANCHOR re-derives the cursor from today, not from the old due
    // date: a template switched from monthly-on-the-30th to weekly-on-Tuesday has no sensible
    // "next" derived from a date the new rule could never have produced.
    //
    // ⛔ Compared against the STORED values, not merely "was a value supplied". The screen posts
    // every field on every save, so keying this on `!== undefined` would move the due date whenever
    // anyone corrected a typo in the name — a silent change to when a bill comes up, made by an
    // edit that had nothing to do with timing. Caught in self-review, not by a test.
    const cursorMoved = interval !== template.interval || anchorDay !== template.anchorDay;

    await recurringExpensesRepo.updateTemplate(trx, actor.orgId, input.templateId, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
      // The one way an existing supplier-less template gets fixed. Clearing it is not offered:
      // a template with no supplier cannot draft, and silently disabling one is DEF-190's shape.
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      ...(defaultAmount !== undefined ? { defaultAmount } : {}),
      ...(input.defaultMoneyAccountId !== undefined ? { defaultMoneyAccountId: accountId } : {}),
      tillIsDeliberate: isTill && deliberate,
      ...(input.interval !== undefined ? { interval } : {}),
      ...(suppliedAnchorDay !== undefined ? { anchorDay } : {}),
      ...(cursorMoved ? { nextDueDate: firstDueDate(manilaToday(), interval, anchorDay) } : {}),
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Pause or resume.
 *
 * ⭐ Pausing is the ONLY way to stop a template that has already produced something. Deleting one
 * that has drafted an expense would strand that expense's explanation — *"why does this draft
 * exist?"* is answered by the template, and a deleted answer is worse than a paused one.
 */
export async function setRecurringTemplateStatus(
  tx: Tx | null,
  actor: Actor,
  input: { templateId: string; status: 'active' | 'paused' },
): Promise<void> {
  const run = async (trx: Tx) => {
    const template = await recurringExpensesRepo.getById(trx, actor.orgId, input.templateId);
    if (!template) throw new Error('that template does not exist.');
    await authorize(trx, actor, 'manage_recurring_expenses', { storeId: template.storeId });

    // ⚠️ Resuming re-derives the cursor from TODAY. A template paused for three months would
    // otherwise wake with a due date three months behind and draft its way forward — noise on the
    // morning somebody switched it back on, and the opposite of what "resume" means.
    const cursor =
      input.status === 'active' && template.nextDueDate < manilaToday()
        ? { nextDueDate: firstDueDate(manilaToday(), template.interval, template.anchorDay) }
        : {};
    await recurringExpensesRepo.updateTemplate(trx, actor.orgId, input.templateId, {
      status: input.status,
      ...cursor,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** ⛔ Only while it has never produced anything. Otherwise: pause it. */
export async function deleteRecurringTemplate(
  tx: Tx | null,
  actor: Actor,
  input: { templateId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const template = await recurringExpensesRepo.getById(trx, actor.orgId, input.templateId);
    if (!template) throw new Error('that template does not exist.');
    await authorize(trx, actor, 'manage_recurring_expenses', { storeId: template.storeId });
    if (template.lastDraftedExpenseId !== null) {
      throw new Error(
        `${template.name} has already produced an expense, so it is history — pause it instead. ` +
          'Deleting it would strand the answer to "why does this draft exist?".',
      );
    }
    await recurringExpensesRepo.deleteTemplate(trx, actor.orgId, input.templateId);
  };
  if (tx) return run(tx);
  return transaction(run);
}

export * from './recurrence';
export * from './job';

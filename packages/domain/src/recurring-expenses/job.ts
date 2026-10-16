/**
 * `runRecurringExpenses` — the daily drafting job. T-216 Part 2,
 * `docs/tasks/216-recurring-expense-automation.md` §J4.
 *
 * ## ⛔ IT DRAFTS. IT NEVER PAYS. Ian, 6–7 Sep 2026.
 *
 * v1 **auto-pays**: a due recurring expense posts a real expense and moves real cash on a cron.
 * Three of the five hardening rounds visible in v1's own comments exist *only* because a machine
 * could move money unattended, and a fourth exists to stop it moving money into a closed month.
 * This job records a **pending** supplier invoice and a **draft** expense and stops. Nothing
 * reaches the ledger until a person has read the real bill, attached it, verified the invoice and
 * approved the expense.
 *
 * ## ⭐ Why an invoice at all — the correction that made this buildable
 *
 * The spec said the job would call `createExpense` "unchanged". It cannot: `expenses.supplier_id`
 * and `expenses.supplier_invoice_id` are both **NOT NULL**, gated inside `createExpense` and
 * backstopped by the `expenses_check_invoice_open_for_recording` trigger, and `createExpense` is
 * the **only** caller of `insertExpense` in the tree. A machine with no invoice cannot record an
 * expense at all.
 *
 * So the template names a supplier and the job records the bill first. ⭐ That turns out to be the
 * better story rather than a workaround: a recurring bill genuinely comes FROM somebody, the
 * invoice date carries the due date onto the expense for free (receipt-date authority, T-130
 * Invariant 3), and the receipt gate stays exactly where T-130 put it — on the invoice, satisfied
 * by the human who attaches the real bill.
 *
 * ## ⭐ It acts AS THE TEMPLATE'S CREATOR, not as a system principal
 *
 * Every other job here uses an `AsSystem` variant that skips `authorize` and writes through repos.
 * This one deliberately does not: it calls `recordInvoice` and `createExpense` with the template
 * creator's `Actor`, through their real gates. So the automation **can never do what the person who
 * set it up could not** — T-216 §8's rule enforced rather than stated. A creator since descoped or
 * demoted produces a loud per-template failure, which is the right failure.
 *
 * ⚠️ Free, not costly: `manage_recurring_expenses` is manager-and-above, while `create_expense` and
 * `record_supplier_invoice` are staff-and-above, so anyone who could create a template holds both.
 *
 * ## Catch-up (T-430) and closed months
 *
 * A template owes one draft per missed DUE DATE (row 327): the job loops while the cursor is on or before today, up to
 * `CATCH_UP_CAP` drafts per template per night, one transaction per due date, and reports `capped N` when it stops
 * early. The unique (template, due date) key still guards every date.
 *
 * A due date inside a `closed` or `locked` fiscal period is drafted on the FIRST OPEN DAY instead (invoice date = due
 * date = that day; `recordInvoice` refuses a due date before its invoice date), with the real due date kept in the
 * `recurring_expense_drafts` row and in the notes. If every period up to today is shut, nothing is drafted and the
 * template is retried the next night.
 */
import {
  recurringExpensesRepo,
  fiscalPeriodsRepo,
  moneyAccountsRepo,
  withOrgPrincipal,
  type SchedulerFailure,
} from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import { createExpense } from '../expenses';
import { recordInvoice } from '../ap';
import { runJobForOrg, listOrgsToRun, type JobOutcome } from '../scheduler';
import { nextDueDate } from './recurrence';
import type { ExpensePaymentMethod } from '../expenses/routing';

/** T-430 D2: the most due dates one template drafts in one night. The rest stay owed and are reported as `capped`. */
export const CATCH_UP_CAP = 12;

/** Manila, the same +8 shift every other job in this codebase uses. */
function manilaToday(nowMs: number): string {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface RecurringExpenseRunResult {
  outcomes: JobOutcome[];
  hadFailures: boolean;
}

/**
 * How a template's default account becomes a payment on the drafted expense.
 *
 * ⭐ Derived, so there is no `default_payment_method` column to keep in step with the account.
 * ⚠️ A template with **no** account yields `credit`: the bill exists and is owed, and which
 * account settles it is a later and separate act. That is the ordinary shape of a landlord's
 * invoice, and the human editing the draft can say otherwise before posting.
 */
export function paymentForAccount(
  instrument: 'cash' | 'ewallet' | 'bank' | null,
  moneyAccountId: string | null,
): { method: ExpensePaymentMethod; moneyAccountId: string | null } {
  if (!moneyAccountId || instrument === null) return { method: 'credit', moneyAccountId: null };
  if (instrument === 'cash') return { method: 'cash', moneyAccountId: null };
  // `routeExpense` blocks an `online` posting without the wallet, naming the payment row — and we
  // have it, so it is always supplied rather than left for the human to remember.
  return { method: 'online', moneyAccountId };
}

export async function runRecurringExpenses(
  options: { orgId?: string; trigger?: 'cron' | 'manual'; nowMs?: number } = {},
): Promise<RecurringExpenseRunResult> {
  const trigger = options.trigger ?? 'cron';
  const nowMs = options.nowMs ?? Date.now();
  const today = manilaToday(nowMs);
  // ⚠️ `scheduler_runs.period` is shaped `YYYY-MM` by a CHECK, and a daily job has no month of its
  // own, so it records the Manila month it RAN in — the same choice every daily job here makes.
  const period = today.slice(0, 7);

  const orgs = await listOrgsToRun(options.orgId);
  const outcomes: JobOutcome[] = [];

  for (const org of orgs) {
    outcomes.push(
      await runJobForOrg(org, 'recurring_expenses', period, trigger, async () => {
        const failures: SchedulerFailure[] = [];
        let drafted = 0;
        let skipped = 0;
        let redated = 0;
        let capped = 0;
        let paused = 0;
        let noOpen = 0;

        // ⛔ `withOrgPrincipal`, NOT a bare `transaction`. Every table this job touches is
        // `org_column`-scoped with FORCE ROW LEVEL SECURITY, and a transaction that never sets
        // `app.org_id` sees nothing and may write nothing under the app's own role.
        //
        // ⚠️ THIS IS INVISIBLE TO THE INTEGRATION TESTS. They connect as `postgres`, which is
        // `rolsuper` and `rolbypassrls`, so every policy is bypassed and a bare `transaction`
        // passes there and fails only in production. Found in self-review, not by a gate.
        const due = await withOrgPrincipal(org.id, (tx) => recurringExpensesRepo.listDue(tx, org.id, today));

        for (const template of due) {
          // ⛔ ONE TRANSACTION PER TEMPLATE, and `reference_postgres_batch_needs_savepoint` is the
          // reason: one DB error aborts the transaction it happened in, so a shared transaction
          // would take this run's own `scheduler_runs` write down with it and the failure would
          // leave no trace at all — DEF-044 wearing its quietest mask.
          try {
            // A template that cannot draft is a CONFIGURATION FAULT, not a no-op. ⚠️ Reported as a
            // failure rather than counted as `skipped`, because `skipped` is where faults go to die
            // quietly: "skipped 4" on a healthy morning and "skipped 4" on a morning when four bills
            // silently stopped being drafted must not be the same line.
            if (!template.supplierId) {
              failures.push({
                subjectId: template.id,
                subjectName: template.name,
                reason:
                  'no supplier — the job records a pending invoice on the due date and an expense ' +
                  'cannot exist without one. Set the supplier on /expenses/recurring.',
              });
              continue;
            }
            if (!template.createdBy) {
              failures.push({
                subjectId: template.id,
                subjectName: template.name,
                reason:
                  'no creator on the template — the job acts as the person who set it up, so there ' +
                  'is nobody for it to act as. Recreate the template.',
              });
              continue;
            }

            const actor: Actor = { personId: template.createdBy, orgId: org.id };
            let cursor = template.nextDueDate;
            let draftedHere = 0;
            // Hard stop on a pathological cursor; the cap and the cursor's own advance end every real loop first.
            for (let guard = 0; cursor.localeCompare(today) <= 0 && guard < 500; guard++) {
              if (draftedHere >= CATCH_UP_CAP) {
                // Still owed after the cap: reported, and the template stays due for tomorrow night.
                let n = 0;
                for (let d = cursor; d.localeCompare(today) <= 0 && n < 5000; d = nextDueDate(d, template.interval, template.anchorDay)) n += 1;
                capped += n;
                break;
              }
              const dueDate = cursor;
              const step = await withOrgPrincipal(org.id, async (tx) => {
                // Lock the template for this one due date: a pause, an edit or a second runner waits for the stamp.
                const cur = await recurringExpensesRepo.getByIdForUpdate(tx, org.id, template.id);
                if (!cur) return { kind: 'gone' as const };
                if (cur.status !== 'active') return { kind: 'paused' as const };
                if (cur.nextDueDate !== dueDate) return { kind: 'moved' as const, cursor: cur.nextDueDate };

                const following = nextDueDate(dueDate, cur.interval, cur.anchorDay);
                // D4: a due date in a closed/locked month is dated on the first open day. Read-only, so a null
                // answer leaves no claim behind.
                const open = await fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, org.id, dueDate, today);
                if (open === null) return { kind: 'no_open_period' as const };

                // CLAIM FIRST. The unique (template, due date) key is the invariant. A lost claim means this date was
                // already drafted while the cursor (locked, checked above) is still on it: a runner died between claim
                // and stamp. Advance the cursor with NO documents (D3).
                const claim = await recurringExpensesRepo.claimDraft(tx, {
                  orgId: org.id,
                  recurringExpenseId: template.id,
                  dueDate,
                });
                if (!claim) {
                  await recurringExpensesRepo.advanceStuckCursor(tx, org.id, template.id, {
                    expectedDueDate: dueDate,
                    nextDueDate: following,
                  });
                  return { kind: 'lost' as const, cursor: following };
                }

                const redated = open.date !== dueDate;
                const why =
                  redated && open.shutBy
                    ? `due ${dueDate}, dated ${open.date} because ${open.shutBy.startsOn.slice(0, 7)} is ${open.shutBy.status}`
                    : null;
                // T-371 R4: the stored default is re-minted into the (14,2) brand, never cast.
                const amount = money(cur.defaultAmount);

                const invoice = await recordInvoice(tx, actor, {
                  storeId: cur.storeId,
                  supplierId: cur.supplierId!,
                  // The date it lands on; it carries onto the expense (`createExpense` forces `businessDate` from the
                  // invoice). The real due date lives in the drafts row and the note when re-dated.
                  invoiceDate: open.date,
                  // T-367 S3 (DEF-499): a blank due date means invoice date + supplier terms; say it explicitly.
                  dueDate: open.date,
                  totalAmount: amount,
                  invoiceNo: `RECUR-${template.id}-${dueDate}`,
                  notes:
                    `Recurring: ${cur.name}. Drafted by the recurring-expense job; the real bill replaces this.` +
                    (why ? ` ${why}.` : ''),
                });

                const account = cur.defaultMoneyAccountId
                  ? await moneyAccountsRepo.getById(tx, org.id, cur.defaultMoneyAccountId)
                  : null;
                let payment = paymentForAccount(
                  account ? (account.instrument as 'cash' | 'ewallet' | 'bank') : null,
                  cur.defaultMoneyAccountId,
                );
                // DEF-663 (T-430): a cash line must NAME its money account (routing refuses one that names none, so
                // the draft could never be approved as-is). The template's own account is that money account; if it
                // cannot be used (gone, retired, another store, a staff float that needs a cash request), draft the
                // bill on credit with no account and the approver picks the source. Never a cash line with a null account.
                if (payment.method === 'cash') {
                  const usable =
                    account != null &&
                    account.isActive &&
                    account.storeId === cur.storeId &&
                    account.custodian !== 'staff';
                  payment = usable
                    ? { method: 'cash', moneyAccountId: cur.defaultMoneyAccountId }
                    : { method: 'credit', moneyAccountId: null };
                }

                const expense = await createExpense(tx, actor, {
                  storeId: cur.storeId,
                  businessDate: open.date, // ignored by createExpense; the invoice date wins
                  categoryId: cur.categoryId,
                  supplierId: cur.supplierId!,
                  supplierInvoiceId: invoice.id,
                  particulars:
                    `${cur.name} — drafted by the recurring-expense job for ${dueDate}` + (why ? ` (${why})` : ''),
                  payments: [{ method: payment.method, amount, moneyAccountId: payment.moneyAccountId }],
                });

                await recurringExpensesRepo.attachDraftDocuments(tx, org.id, claim.id, {
                  expenseId: expense.id,
                  supplierInvoiceId: invoice.id,
                });

                // SAME TRANSACTION as the documents, and a compare-and-set: the cursor moves from THIS due date
                // (never from today) and only while the template is still active on it; zero rows rolls it all back.
                await recurringExpensesRepo.stampDrafted(tx, org.id, template.id, {
                  expenseId: expense.id,
                  nextDueDate: following,
                  at: new Date(nowMs),
                  expectedDueDate: dueDate,
                });
                return { kind: 'drafted' as const, cursor: following, redated };
              });

              if (step.kind === 'drafted') {
                drafted += 1;
                draftedHere += 1;
                if (step.redated) redated += 1;
                cursor = step.cursor;
              } else if (step.kind === 'lost') {
                skipped += 1;
                cursor = step.cursor;
              } else if (step.kind === 'moved') {
                cursor = step.cursor;
              } else {
                if (step.kind === 'paused') paused += 1;
                else if (step.kind === 'no_open_period') noOpen += 1;
                break;
              }
            }
          } catch (e) {
            failures.push({
              subjectId: template.id,
              // The name, not the uuid — a failure line nobody can act on without a database
              // session is a failure line nobody acts on.
              subjectName: template.name,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        }

        return {
          posted: drafted,
          skipped,
          failures,
          // ⚠️ Counts, never a bare "done" (bible §15.6). "drafted 0" on a run that saw 12 due
          // templates is a fault; "drafted 0" on a run that saw none is a quiet morning, and the
          // two are indistinguishable without the first number.
          detail:
            `due ${due.length} · drafted ${drafted} · re-dated ${redated} · capped ${capped} · already drafted ${skipped} · ` +
            `paused during run ${paused} · no open period ${noOpen} · refused ${failures.length}`,
        };
      }),
    );
  }

  return { outcomes, hadFailures: outcomes.some((o) => o.failed > 0 || o.error) };
}

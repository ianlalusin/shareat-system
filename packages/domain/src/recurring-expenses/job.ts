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
 * ## ⚠️ A locked period still drafts, and that is deliberate
 *
 * v1 needed a period guard because it POSTED. A draft posts nothing, so there is nothing for a
 * period to refuse — and there is no period guard on either create path to refuse it with (the lock
 * lives at `postEntry`). A job that refused would leave the bill invisible until somebody reopened
 * the month, which is the forgetting this module exists to prevent. The draft is created and simply
 * cannot be approved until the period opens, in the one place that already knows how to say so.
 */
import {
  recurringExpensesRepo,
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

            const dueDate = template.nextDueDate;
            // T-371 R4: the stored default is re-written onto the invoice and the payment row, so it is re-minted into
            // the (14,2) brand, never cast. 0155 keeps NaN out of stored data, so this never refuses.
            const amount = money(template.defaultAmount);
            const actor: Actor = { personId: template.createdBy, orgId: org.id };

            const result = await withOrgPrincipal(org.id, async (tx) => {
              // ⭐ CLAIM FIRST. The cursor stops the ordinary second run of the day; this stops the
              // ones it cannot see — two processes racing, or a cursor moved backwards by an edit.
              // Claiming after creating the documents would strand them when the claim loses.
              const claim = await recurringExpensesRepo.claimDraft(tx, {
                orgId: org.id,
                recurringExpenseId: template.id,
                dueDate,
              });
              if (!claim) return null;

              const invoice = await recordInvoice(tx, actor, {
                storeId: template.storeId,
                supplierId: template.supplierId!,
                // ⭐ The due date, and it is what carries onto the expense: `createExpense` forces
                // `businessDate` from the invoice, so the draft lands on the day it was due.
                invoiceDate: dueDate,
                // T-367 S3 (DEF-499): a blank due date now means invoice date + the supplier's terms, which would
                // push this bill's due date out by the terms. The template's date IS the due date, so say so.
                dueDate,
                totalAmount: amount,
                invoiceNo: `RECUR-${template.id}-${dueDate}`,
                notes: `Recurring: ${template.name}. Drafted by the recurring-expense job; the real bill replaces this.`,
              });

              const account = template.defaultMoneyAccountId
                ? await moneyAccountsRepo.getById(tx, org.id, template.defaultMoneyAccountId)
                : null;
              const payment = paymentForAccount(
                account ? (account.instrument as 'cash' | 'ewallet' | 'bank') : null,
                template.defaultMoneyAccountId,
              );

              const expense = await createExpense(tx, actor, {
                storeId: template.storeId,
                businessDate: dueDate, // ignored by createExpense; the invoice date wins
                categoryId: template.categoryId,
                supplierId: template.supplierId!,
                supplierInvoiceId: invoice.id,
                particulars: `${template.name} — drafted by the recurring-expense job for ${dueDate}`,
                payments: [
                  {
                    method: payment.method,
                    amount,
                    moneyAccountId: payment.moneyAccountId,
                  },
                ],
              });

              await recurringExpensesRepo.attachDraftDocuments(tx, org.id, claim.id, {
                expenseId: expense.id,
                supplierInvoiceId: invoice.id,
              });

              // ⛔ SAME TRANSACTION as the documents above. A draft whose cursor did not advance
              // drafts again tomorrow, and every tomorrow after that.
              // ⭐ ONE interval, from the DUE date rather than from today: a template three months
              // overdue drafts once and converges over three daily runs. Three drafts on one morning
              // is noise; v1's own restraint was "never pre-create", and this is its mirror.
              await recurringExpensesRepo.stampDrafted(tx, org.id, template.id, {
                expenseId: expense.id,
                nextDueDate: nextDueDate(dueDate, template.interval, template.anchorDay),
                at: new Date(nowMs),
              });
              return expense.id;
            });

            if (result === null) skipped += 1;
            else drafted += 1;
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
          detail: `due ${due.length} · drafted ${drafted} · already drafted ${skipped} · refused ${failures.length}`,
        };
      }),
    );
  }

  return { outcomes, hadFailures: outcomes.some((o) => o.failed > 0 || o.error) };
}

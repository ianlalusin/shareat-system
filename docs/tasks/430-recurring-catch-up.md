# T-430 — Recurring templates: a starting period, and catch-up drafting

**Status:** spec written 2026-10-16, not started. Opus spec; Opus review fixes and Ian's answers folded in 16 Oct.
**Source:** worklist `docs/plans/2026-10-14-ian-answers-worklist.md` row 9; bible row 327 (Ian, Q9): *"when template
is created add the recurring timing then build up based on the selected period."* Row 183 stands: **drafts, never pays.**
**Builds on:** T-216 (template + job, `packages/domain/src/recurring-expenses/`), T-140 (the scheduler that runs it),
T-418 (`deleteTemplate` refuses once `last_drafted_expense_id` is set — unchanged here, and a catch-up draft sets it).
**Model: SONNET** (money). One builder, one tester. **Migration: YES, one** (number allocated by the orchestrator;
next free is `0201`). Size M.

## Goal, in plain words

When someone sets up a recurring bill (rent, internet), they say **from when** it applies. If that is in the past,
the nightly job writes one draft bill for **every due date** missed since then, up to today, not just one.
If it is in the future, the first draft appears when that date comes. Nothing is paid. A person still reads,
attaches and approves each draft.

## What exists today (read at `f18494f`)

- `createRecurringTemplate` already takes an optional `from` (defaults to Manila today) and derives the first due
  date with `firstDueDate`. It does **not** store it, does **not** validate it, and the screen does not offer it.
- `runRecurringExpenses` (`job.ts`) drafts **one** due date per template per run and says so: "a template three
  months overdue drafts once and converges over three daily runs". Row 327 overrules that line.
- Idempotency is already a database fact: `recurring_expense_drafts_once_idx` UNIQUE on
  `(recurring_expense_id, due_date)`, written `ON CONFLICT DO NOTHING` by `claimDraft`. **No new uniqueness key.**
  ⚠️ Not a `YYYY-MM` key: a weekly template has 4-5 due dates a month (that file's own header says why).
  In this spec **"period" means one due date of the template**, never a calendar month.
- There is **no org-wide go-live date** in the schema. The template is store-scoped, and `stores.opening_date`
  (T-346, nullable; null = not yet open) is the floor.

## Design

**D1. Starting period on create.** New input `startsOn` (`YYYY-MM-DD`, replaces `from`; the first due date is
`firstDueDate(startsOn, interval, anchorDay)`). **A future date is allowed (Ian, 16 Oct):** nothing drafts until
that due date comes. Refused, in the domain after `authorize()`, when: (a) the store's `opening_date` is set and
`startsOn` < it; (b) the store's `opening_date` is null and `startsOn` < Manila today (a store that has not opened
has no past to catch up). Omitted = today. Stored in the new column `recurring_expenses.starts_on`, not editable
after the first draft (it is history, like the template itself under T-418).
⚠️ **Resume and interval/anchor edits keep today's behaviour** (cursor re-derived from today), which **drops** any
owed due dates between the old cursor and the new one, including ones a capped template had not reached yet.
Deliberate (paused months are not caught up) but never silent: both paths count the dropped due dates
(`nextDueDate` walk from old cursor to new) and record it in their audit row as `dropped_due_dates: N` (D5).

**D2. Catch-up loop.** In `job.ts`, per template, loop while `cursor <= today` and `drafted < CATCH_UP_CAP`
(`CATCH_UP_CAP = 12`, a named export; Ian, 16 Oct). Each iteration is the existing claim → invoice → expense →
attach → stamp, **one transaction per due date** (a failure on date 3 keeps dates 1-2 and reports date 3). The
cursor advances from the due date, never from today, so every elapsed due date gets exactly one draft. A template
still behind after the cap is reported: detail line gains `· capped N` and it stays due for the next night.

**D3. Concurrency.** (1) The existing unique index: `claimDraft` is `ON CONFLICT DO NOTHING`. **On a lost claim**,
re-read the template in a fresh transaction: if its cursor still equals that due date (a runner died between claim
and stamp, or a hand edit moved the cursor back onto a drafted date), **advance the cursor through the CAS below
with no documents** and continue; if the cursor already moved, continue from the new cursor. A template can never
stick on a drafted date. Counted as `already drafted`. (2) `stampDrafted` (repo l.160) becomes compare-and-set:
`WHERE id = $id AND next_due_date = <expected due date> AND status = 'active'`; zero rows → throw inside the
transaction so that date's documents roll back. The cursor never moves backwards or skips, and a template
**paused mid-run stops** at its next iteration (reported once as `paused during run`, not a failure).

**D4. Closed months — decided: re-date to the first open day, with a note.** When a due date falls in a `closed`
or `locked` fiscal period, the open date `O = firstOpenDateOnOrAfter(...)` is sent to `recordInvoice` as **both**
`invoiceDate` and `dueDate`. ⛔ `recordInvoice` refuses a due date before the invoice date
(`packages/domain/src/ap/index.ts:605`), so the real date can NOT go on the invoice. The **real** due date lives
in `recurring_expense_drafts.due_date` (so the unique index still keys on the real date) and in the invoice note
and expense particulars: `due <real date>, dated <O> because <period> is <status>`.
**Why, not refuse:** refusing drops a real debt from the books and from the row-327 "what we owe" view, the
forgetting this module exists to prevent. **Why, not keep the closed date** (today's comment in `job.ts`): twelve
back-dated catch-up drafts would each need a month reopened or a `PeriodOverride`, which nobody will do. Booking
a late-found cost in the current open period is the ordinary accounting treatment. This replaces the "A locked
period still drafts" paragraph in `job.ts` for all drafts. New repo fn
`fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, date, today)`: returns `date` when no period row covers it or
the covering row is `open`; otherwise the day after the covering period's `ends_on`, repeated. ⛔ If that answer
would be **after `today`** (every period up to today is closed) it returns `null`: the job drafts nothing for that
template, leaves the cursor, reports `no open period` in the detail line and the audit, and retries next night.

**D5. Audit.** Each draft already leaves a `recurring_expense_drafts` row and a stamped template. Add: the scheduler
detail line `due · drafted · re-dated · capped · already drafted · paused during run · no open period · refused`;
`auditLogRepo.append` on create (`starts_on`), on resume and on interval/anchor edit (`dropped_due_dates`);
pattern: `channel-settlements` `setChannelPayoutDestination`.

**D6. Migration (hand-authored, ADR-012 §5 checklist).** `ALTER TABLE recurring_expenses ADD COLUMN starts_on date`,
backfill `(created_at AT TIME ZONE 'Asia/Manila')::date`, then `SET NOT NULL`. Name:
`0201_t430_recurring_starts_on.sql` (number confirmed by the orchestrator). Journal `when` = previous + 86400000 =
**1803439907084** (0200's is 1803353507084). **No new table**, so no change to `cutover/classification.ts` or
`rls/registry.ts`, and no new index. GLOSSARY grepped: no "starting period"/`starts_on` term to collide with;
`fiscal_periods.starts_on` already means "first day", so the name is consistent.

## Files

**BUILDER (source only):** `packages/db/schema/recurring-expenses.ts` · NEW `packages/db/migrations/0201_t430_recurring_starts_on.sql`
(+ `meta` journal) · `packages/db/src/repo/recurring-expenses.ts` (`insertTemplate` takes `startsOn`; `stampDrafted` CAS)
· `packages/db/src/repo/fiscal-periods.ts` (`firstOpenDateOnOrAfter`) · `packages/domain/src/recurring-expenses/index.ts`
(D1, D5) · `packages/domain/src/recurring-expenses/job.ts` (D2-D5) · `apps/erp/src/app/expenses/recurring/page.tsx`,
`actions.ts`, `typed-forms.ts` (a "Starts from" date field, default today, with a line saying past dates create
catch-up drafts) · `docs/tasks/216-recurring-expense-automation.md` (one status line pointing here).

**TESTER (tests only):** NEW `packages/domain/tests/integration/t430-recurring-catch-up.test.ts` (cases 1-15) ·
EDIT `packages/domain/tests/integration/recurring-expenses-job.test.ts` (replace the "drafts once and converges"
case, which this task deliberately breaks) · NEW `apps/erp/tests/t430-starts-from-field.test.ts` (case 16).

## Acceptance cases (real Postgres; `nowMs` pinned in every job case; each names the mutant it kills)

1. Monthly template, `startsOn` 3 due dates ago, one run → exactly 3 drafts, one per due date, cursor = next future
   date. *Kills: loop removed (1 draft), loop off-by-one (2 or 4).*
2. Weekly template, `startsOn` exactly 21 days before the pinned `nowMs` → exactly 4 drafts (days 0, 7, 14, 21), all
   in one month. *Kills: a per-month key or loop; `<` vs `<=` on the cursor.*
3. Second run the same day → 0 new drafts, `due 0`. *Kills: cursor not stamped per iteration.*
4. Two runs started concurrently (`Promise.all`) → each due date drafted once, no orphan invoice/expense.
   *Kills: claim removed.*
5. `stampDrafted` called directly with a wrong expected date → 0 rows, throws, and the invoice and expense created
   earlier in that transaction are rolled back. *Kills: CAS `next_due_date` condition dropped.*
6. Stuck cursor: a drafts row exists for the cursor date but the cursor was never stamped → the run advances the
   cursor with no new documents and drafts the next due date. *Kills: lost claim stops or skips the template for ever.*
7. Template paused between iterations (fixture pauses it after the 1st draft) → no 2nd draft, detail has
   `paused during run`, no failure. *Kills: `status = 'active'` dropped from the CAS.*
8. 15 due dates elapsed → 12 drafted, detail has `capped`, template still due; next run drafts the other 3.
   *Kills: cap ignored; cap not reported.*
9. Failure on the 2nd of 3 (supplier deactivated mid-run via a fixture) → 1st kept, failure names the template, no
   documents for the 2nd. *Kills: one shared transaction for the whole loop.*
10. Due date in a `closed` period → invoice `invoice_date` = invoice `due_date` = expense date = first open day;
    drafts row `due_date` = real date; note names both. Same for `locked`. *Kills: re-date skipped; real date sent
    as the invoice due date (refused by `recordInvoice`).*
11. No period row covering the date → dated on the real due date. Every period through today closed → no draft,
    cursor unchanged, `no open period` reported. *Kills: missing row treated as closed; a null open date drafting
    into the future or moving the cursor.*
12. Every draft is `draft`/`pending`; no ledger entry, no payment, no money-account movement. *Kills: any auto-pay path.*
13. `startsOn` next month → accepted, no draft before that due date, first draft on it; before the store's
    `opening_date` → refused; null opening date and a past date → refused; equal to `opening_date` → accepted.
    *Kills: each validation branch removed, a future-date refusal added back, or `<` vs `<=` flipped.*
14. Capped template with 5 owed dates left, resumed after pause, and separately interval-edited → each audit row
    carries `dropped_due_dates: 5`. *Kills: the drop made silent.*
15. Template that has caught up → `deleteRecurringTemplate` refused (T-418 guard); a never-drafted one deletes.
    Create writes one audit row carrying `starts_on`. *Kills: T-418 guard regressed; create audit dropped.*
16. Screen renders a "Starts from" date input defaulting to today, and the action passes it through as `startsOn`.
    *Kills: field not wired (silently today).*

## Done when

Cases 1-16 green; existing `recurring-expenses*.test.ts` and `t361-recurring-cod.test.ts` green; migration applied on a
fresh gate DB and the **full** suite green (memory: full suite for migrations); typecheck and lint clean;
`job.ts` header no longer claims "converges over daily runs" or "a locked period still drafts".

## Ian's answers (16 Oct), folded in — no open questions

- A **future** start date is allowed; the first draft appears when that due date comes (D1, case 13).
- Cap = **12 drafts per template per night** (D2, case 8).

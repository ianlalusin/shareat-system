# T-430 — Recurring templates: a starting period, and catch-up drafting

**Status:** spec written 2026-10-16, not started. Opus spec.
**Source:** worklist `docs/plans/2026-10-14-ian-answers-worklist.md` row 9; bible row 327 (Ian, Q9): *"when template
is created add the recurring timing then build up based on the selected period."* Row 183 stands: **drafts, never pays.**
**Builds on:** T-216 (template + job, `packages/domain/src/recurring-expenses/`), T-140 (the scheduler that runs it),
T-418 (`deleteTemplate` refuses once `last_drafted_expense_id` is set — unchanged here, and a catch-up draft sets it).
**Model: SONNET** (money). One builder, one tester. **Migration: YES, one** (number allocated by the orchestrator;
next free is `0201`). Size M.

## Goal, in plain words

When someone sets up a recurring bill (rent, internet), they say **from when** it applies. If that is in the past,
the nightly job writes one draft bill for **every due date** missed since then, up to today, not just one.
Nothing is paid. A person still reads, attaches and approves each draft.

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
`firstDueDate(startsOn, interval, anchorDay)`). Refused, in the domain after `authorize()`, when:
(a) `startsOn` > Manila today; (b) the store's `opening_date` is set and `startsOn` < it; (c) the store's
`opening_date` is null and `startsOn` < today (a store that has not opened has no past to catch up).
Omitted = today, as now. Stored in the new column `recurring_expenses.starts_on`. Editing the interval/anchor and
resuming from pause keep today's behaviour (cursor re-derived from today; paused months are **not** caught up).
`starts_on` is not editable after the first draft (it is history, like the template itself under T-418).

**D2. Catch-up loop.** In `job.ts`, per template, loop while `cursor <= today` and `drafted < CATCH_UP_CAP`
(`CATCH_UP_CAP = 12`, a named export). Each iteration is the existing claim → invoice → expense → attach → stamp,
**one transaction per due date** (a failure on date 3 keeps dates 1-2 and reports date 3). The cursor advances
from the due date, never from today, so every elapsed due date gets exactly one draft. A template still behind
after the cap is reported, not skipped silently: detail line gains `· capped N` and the template stays due.

**D3. Concurrency.** Two guards, both required: (1) the existing unique index — a lost claim returns null, and the
loop **stops for that template** (another runner owns it); (2) `stampDrafted` becomes compare-and-set:
`WHERE next_due_date = <the due date just drafted>`, zero rows → throw inside the transaction so the documents
roll back. The cursor can therefore never move backwards or skip.

**D4. Closed months — decided: re-date to the first open day, with a note.** A catch-up draft whose due date falls
in a `closed` or `locked` fiscal period gets `invoiceDate` (and so the expense's business date) = the first day of
the first `open` period after it; `dueDate` on the invoice and `due_date` on the drafts row stay the **real** due
date; the invoice note and expense particulars say `due <real date>, dated <open date> because <period> is closed`.
**Why, not refuse:** refusing drops a real debt from the books and from the row-327 "what we owe" view — the
forgetting this module exists to prevent. **Why, not keep the closed date** (today's comment in `job.ts`): one
late draft could wait for a reopen; twelve back-dated catch-up drafts would each need a month reopened or a
`PeriodOverride`, which nobody will do. Booking a late-found cost in the current open period is the ordinary
accounting treatment, and the real due date stays visible for AP ageing. This replaces the "A locked period still
drafts" paragraph in `job.ts` for all drafts, not only catch-up. New repo fn
`fiscalPeriodsRepo.firstOpenDateOnOrAfter(tx, orgId, date)`: returns `date` itself when no period row covers it or
the covering row is `open`; otherwise the day after the covering period's `ends_on`, repeated.

**D5. Audit.** Each draft already leaves a `recurring_expense_drafts` row and a stamped template. Add: the scheduler
detail line `due · drafted · caught up · re-dated · capped · already drafted · refused`; one `auditLogRepo.append`
on create recording `starts_on` (pattern: `channel-settlements` `setChannelPayoutDestination`).

**D6. Migration (hand-authored, ADR-012 §5 checklist).** `ALTER TABLE recurring_expenses ADD COLUMN starts_on date`,
backfill `(created_at AT TIME ZONE 'Asia/Manila')::date`, then `SET NOT NULL`. No new table, so no classification /
RLS registry entry; no new index. Name: `0201_t430_recurring_starts_on.sql` (number confirmed by the orchestrator).
GLOSSARY grepped: no existing "starting period"/`starts_on` term to collide with; `fiscal_periods.starts_on` exists
with the same meaning (first day), so the name is consistent.

## Files

**BUILDER (source only):** `packages/db/schema/recurring-expenses.ts` · NEW `packages/db/migrations/0201_t430_recurring_starts_on.sql`
(+ `meta` journal) · `packages/db/src/repo/recurring-expenses.ts` (`insertTemplate` takes `startsOn`; `stampDrafted` CAS)
· `packages/db/src/repo/fiscal-periods.ts` (`firstOpenDateOnOrAfter`) · `packages/domain/src/recurring-expenses/index.ts`
(D1) · `packages/domain/src/recurring-expenses/job.ts` (D2-D5) · `apps/erp/src/app/expenses/recurring/page.tsx`,
`actions.ts`, `typed-forms.ts` (a "Starts from" date field, default today, with a line saying past dates create
catch-up drafts) · `docs/tasks/216-recurring-expense-automation.md` (one status line pointing here).

**TESTER (tests only):** NEW `packages/domain/tests/integration/t430-recurring-catch-up.test.ts` (cases 1-12) ·
EDIT `packages/domain/tests/integration/recurring-expenses-job.test.ts` (replace the "drafts once and converges"
case, which this task deliberately breaks) · NEW `apps/erp/tests/t430-starts-from-field.test.ts` (case 13).

## Acceptance cases (real Postgres; each names the mutant it kills)

1. Monthly template, `startsOn` 3 due dates ago, one run → exactly 3 drafts, one per due date, cursor = next
   future date. *Kills: loop removed (1 draft), loop off-by-one (2 or 4).*
2. Weekly template started 3 weeks back → 3 or 4 drafts matching `firstDueDate`/`nextDueDate` exactly, all in one
   month. *Kills: a per-month key or loop.*
3. Second run the same day → 0 new drafts, `already drafted 0`, `due 0`. *Kills: cursor not stamped per iteration.*
4. Two runs started concurrently (`Promise.all`) → each due date drafted once, no orphan invoice/expense.
   *Kills: claim removed; loop continuing after a lost claim.*
5. Cursor moved backwards by hand to an already-drafted date → that date is skipped, no duplicate, and `stampDrafted`
   CAS refuses a stale cursor (rolled back, no documents). *Kills: CAS `WHERE` dropped.*
6. 15 due dates elapsed → 12 drafted, detail has `capped`, template still due; next run drafts the other 3.
   *Kills: cap ignored; cap reported as `skipped` or not at all.*
7. Failure on the 2nd of 3 (e.g. supplier deactivated mid-run via a fixture) → 1st kept, failure names the template,
   no partial documents for the 2nd. *Kills: one shared transaction for the whole loop.*
8. Due date inside a `closed` period → invoice/expense dated the first open day, invoice `due_date` and drafts row
   = real date, note names both. Same for `locked`. *Kills: re-date skipped; due date overwritten too.*
9. No fiscal period row covering the date → dated on the real due date. *Kills: missing row treated as closed.*
10. Every draft is `draft`/`pending`; no ledger entry, no payment, no money-account movement. *Kills: any auto-pay path.*
11. `startsOn` tomorrow → refused; before the store's `opening_date` → refused; null opening date and a past date
    → refused; equal to `opening_date` → accepted. *Kills: each validation branch removed or `<` vs `<=` flipped.*
12. Template that has caught up → `deleteRecurringTemplate` refused (T-418 guard); a never-drafted one deletes.
    Create writes one audit row carrying `starts_on`. *Kills: T-418 guard regressed; audit dropped.*
13. Screen renders a "Starts from" date input defaulting to today, and the action passes it through as `startsOn`.
    *Kills: field not wired (silently today).*

## Done when

Cases 1-13 green; existing `recurring-expenses*.test.ts` and `t361-recurring-cod.test.ts` green; migration applied on a
fresh gate DB and the **full** suite green (memory: full suite for migrations); typecheck and lint clean;
`job.ts` header no longer claims "converges over daily runs" or "a locked period still drafts".

## Questions for Ian (none block the build; defaults in brackets)

- Q1. A starting date in the **future** (a lease that begins next month) is refused by this spec, per the brief.
  [Default: refuse. Allowing it is a one-line change and harmless, since nothing drafts until the date.]
- Q2. Cap of **12 drafts per template per night**. [Default 12: a year of monthly bills at once, the rest next night.]

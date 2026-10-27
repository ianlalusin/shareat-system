# T-487 — A month cannot close with unposted sales days; verifying into a closed month refuses plainly, admin override

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit finding F15 (Claude accounting-core
pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-accounting-core-pass.md`), re-verified on origin/main
26605d1. Branch `audit/t487-close-gate-sales-days`. Defect DEF-779. Numbers from the orchestrator (BOARD.md).

## Finding — DEF-779 (P2, money: revenue can stay off the books with no in-product remedy)
- `closeBlockers` (`packages/domain/src/fiscal-periods/index.ts:61-67`) and `closePeriod` (`:123-167`) gate on draft
  expenses/deliveries (`unpostedDraftsInRange`, `packages/db/src/repo/fiscal-periods.ts:461-495`, kinds
  `'expense' | 'delivery'` only), usage settlement, hard findings and earlier-open months. No sales-day check.
- The only sales-day blocker is the findings detector `salesDayUnposted` (`packages/db/src/repo/findings.ts:1988-2010`):
  POS-sourced days only, and only once older than 3 days. A typed day (`pos_sourced = false`) never blocks; a day 0-3
  days old never blocks, even when its month has ended.
- `verifySalesDay` (`packages/domain/src/sales-days/verify.ts:83-160`) posts on the day's business date with no
  `periodOverride`; for a closed month `postEntry` throws a plain developer `Error` (`ledger/post-entry.ts:192-198`).
  Reopening is never built (ADR-006:132,186), so such a day is stuck, and from day 4 `salesDayUnposted` (hard,
  org-wide) blocks every later close.

## Rulings
1. **Close gate.** A sales day whose `business_date` falls in the period and whose status is `open` or `submitted`
   (POS-sourced or typed) blocks `closePeriod`. Add it to `unpostedDraftsInRange` as a new kind `'salesDay'` (query on
   `sales_days`, using the `(org_id, business_date)` index; include store name and business date for the message), and
   extend the two message builders (`closePeriod`'s count sentence at `fiscal-periods/index.ts:130-140` and
   `holes.ts` `draftLabel`) so the refusal names it, e.g. "3 sales days in October are not posted yet. Verify or void
   them first." `voided` and `verified` days never block.
2. **Verify into a closed month.** `verifySalesDay` checks the day's period before posting, using the same
   `periodRefusal(buildPeriodFacts(...), { override })` pair `approveExpense` uses (`expenses/approve.ts:361-372`,
   sentences in `business-rules/expenses.ts:200-209`; reuse, do not copy). Closed + no override → the plain sentence
   ("October is closed. Ask an administrator to post this one entry into it."), nothing written. Locked → the locked
   sentence, never overridable. Closed + `periodOverride` → posts through `postEntry`'s existing override path (which
   authorizes `override_period_lock`, admin/super_admin only, and writes the `period_overrides` row).
3. **Screen.** The sales-day verify action reads the override exactly like the expense approve action
   (`apps/erp/src/app/expenses/actions.ts:309-328` with `apps/erp/src/lib/period-override.ts` `readPeriodOverride` /
   `periodOverrideProblem` / `closedMonthOf`), and the verify form shows the same override fields to an admin when the
   day's month is closed. Mirror the expense form's markup; no new pattern.
4. No reopen, no change to the findings detector, no change to `postEntry`.

## Tests (red first, real Postgres, dedicated fresh *_test DB)
`packages/domain/tests/integration/t487-close-gate-sales-days.test.ts`:
- a submitted POS-sourced day and (separately) an open typed day, each dated inside month M and only 1 day before the
  close → `closePeriod(M)` refused naming the sales day; nothing closed. Same day verified (or voided) → M closes.
- a submitted day in an already-closed M → `verifySalesDay` refused with the closed-month sentence, day still
  `submitted`, no journal entry; with `periodOverride` by an admin → posts, day `verified`, one `period_overrides` row;
  with an override by a non-admin → refused (capability); locked M → refused even with override.
- Fixtures: `_fixtures/sales-day-flow.ts` `mkTypedDay`, `_fixtures/pos-s6.ts` `s6Fixture`, and the
  `fiscal-period-close.test.ts` `openPeriod` pattern; fresh ids.
Existing close/verify tests (`fiscal-period-close.test.ts`, `t368-periods.test.ts`, `t401-s6-close-and-scorecard.test.ts`,
`t344-*`, `year-close.test.ts`, `t385-s1-*`, `t385-s3-*`, `sales-days.test.ts`, `t369-s3-*`) stay green; if one closed a
month containing an unposted day by accident, fix the fixture (say which) — never weaken the gate.

## Files
`packages/db/src/repo/fiscal-periods.ts`, `packages/domain/src/fiscal-periods/index.ts`, `fiscal-periods/holes.ts`,
`packages/domain/src/sales-days/verify.ts`, the sales-day verify server action and form under `apps/erp/src/app/`
(find them; name them in the report), the new test file, fixtures only if needed, `docs/DEFECTS-REGISTER.md`
(section E, DEF-779). Nothing in `trade/**`, `deliveries/**`, `customers/**` (another lane is changing them).

## Acceptance
New tests red on 26605d1 for the stated reasons, then green; the existing tests above green; root + ERP typecheck
clean; guard/census unit files green (re-measure census only where a guard says so).

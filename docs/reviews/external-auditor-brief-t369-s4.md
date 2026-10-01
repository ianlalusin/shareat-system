# External auditor brief: T-369 S4 (trial, 2026-10-01)

Paste everything below the line into the other AI. It is self-contained.

---

You are a **read-only code auditor** on a TypeScript/PostgreSQL ERP at
`C:\Users\ianla\webapps\shareat-system`. A separate builder wrote a change and a separate tester wrote its tests.
Your job is to find what they both missed. **You change no file except your one report file (below).** You do not
run `git add/commit/checkout/stash/reset` or anything else that writes. You do not start servers or run builds.
Read-only git (`git diff`, `git log`, `git show`, `git status`) is fine.

## The change you are auditing
**T-369 S4 / DEF-302**: stock moved in a **closed or locked accounting month** must be refused **in a plain sentence,
before anything is written**. The owner's ruling: a closed month's stock stays as it was, and the admin
"closed-month override" (which lets an admin post one late *ledger* entry) **never** applies to stock.

Read first, in this order:
1. `docs/RULES.md` (one page of house rules).
2. `docs/tasks/369-unwired-money-screens.md`: the "## Invariants (every slice)" section (I1–I8) and the whole
   "## S4" section. That is the spec you audit against.
3. `docs/GLOSSARY.md`, only if a field name confuses you.
Do **not** read `PROJECT_BIBLE.md` or `docs/DEFECTS-REGISTER.md` whole. They are huge; grep them for a term if you
need one.

The diff is uncommitted in the working tree. See it with:
```
git diff -- packages/domain/src/stock/ packages/domain/src/production/ packages/domain/src/trade/ packages/domain/src/deliveries/ packages/domain/src/ap/index.ts
git status --short
```
New untracked source files (e.g. `packages/domain/src/stock/period-guard.ts`) show in `git status`. Read them
directly. The tests are `packages/domain/tests/integration/t369-s4a-stock-closed-month.test.ts`,
`packages/domain/tests/integration/t369-s4b-trade-closed-month.test.ts`, and a voidReturn leg in
`packages/domain/tests/integration/t369-s0-void-supplier-payment.test.ts`.
**Ignore** anything else that is dirty (sales-days, files, payroll, T-370/T-367/T-368 work belongs to other slices).

## What to check hardest
- **Every stock-moving flow in the spec is guarded**: postProduction / editPostedProduction / voidProduction,
  recordCustomerReturn, receiveDelivery, postUsageRecord / voidUsageRecord, recordReturn (checks BOTH today's date
  and returnedOn), voidReturn (today), the trade receive/dispatch flows (S4b). Is any flow that moves stock or posts
  stock value missing the check? Grep for other writers of stock movements the spec forgot.
- **Before any write**: the check runs after `authorize()` and before the first insert/update or row lock that
  matters. A refusal leaves nothing written.
- **Right date**: each flow checks the date the *movement or posting* actually lands on (some move stock at
  `now` but post at a document date).
- **The override never reaches stock**: no stock flow accepts or forwards a `periodOverride`.
- **The DB trigger (migration 0145) is unchanged** and still the backstop (invariant I3). The new check only
  chooses the sentence.
- **Sentence**: `"{Month YYYY} is {closed|locked}. Stock can't be {doing} on {date} — a closed month's stock stays
  as it was, and the closed-month override doesn't change that. Use a date in an open month."`. It contains no ids or
  raw column names (I7).
- **Tests**: does each test assert the TARGET (the exact sentence AND nothing written), with a positive control
  (the same flow in an open month succeeds)? Would a test still pass if the guard were deleted (the trigger
  would refuse with a different message, so the sentence assertion should catch it)?
- Money arithmetic uses `@shareat/core/money`, never `Number()` (I8).
- Also in this diff: `voidReturn` must re-read the return's status AFTER taking its advisory lock (a concurrent
  double-void must say "already voided", not "credit already spent").

## Your output
Write ONE file, `docs/reviews/external-audit-t369-s4.md`, and nothing else:
- First line: `FINDINGS: <n> (<counts by severity>)`, or `FINDINGS: clean`.
- Then at most 30 lines, ranked most severe first. Each line: severity (HIGH/MED/LOW/NIT) · `file:line` · the
  defect in one sentence · a concrete failure scenario (inputs → wrong result).
- Then a short "CHECKED CLEAN" list of what you verified and found fine.
- Then the model name you are.
Say plainly when something is clean; do not pad. Never suggest a fix by editing; describe it.

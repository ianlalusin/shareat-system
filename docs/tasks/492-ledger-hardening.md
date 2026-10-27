# T-492 — Ledger hardening: correction dates refused in words (F16); exemption flags switched off after use (F17); reversed headers frozen (F18)

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit findings F16, F17 (Claude
accounting-core pass) and F18 (Claude ledger-engine pass), `C:\Users\ianla\shareat-audits\OPEN\`, re-verified on
origin/main. **Two slices, two PRs:** S1 = F16 + F17 (code only), branch `audit/t492-ledger-hardening`; S2 = F18
(a migration; its own PR and number from the orchestrator; full suite on a fresh DB). Defects DEF-784 (F16), DEF-785
(F17), DEF-786 (F18). This file describes both; S2 is not built in S1.

## S1 — F16 / DEF-784 (P3): `postPosCorrection` says "open month" and never checks it
`packages/domain/src/sales-days/correction.ts:33-36` documents "a Manila date in an open month"; the only checks are
`:102` (`parseBusinessDate`) and `:106` (not before the day). A closed/locked month reaches `postEntry`'s developer error
(`ledger/post-entry.ts:192-198`). Ruling: before posting, `journalRepo.findPeriodForDate(tx, orgId, entryDate)`; no period
→ refuse "There is no fiscal period for <date> yet."; otherwise `periodRefusal(buildPeriodFacts(period), { override: false })`
(`business-rules/expenses.ts`, as `expenses/approve.ts:361` and T-487 do) → `refuse(raw, sentence)`. No override for
corrections (the documented rule is "open month"). Update `t375-s6-correction.test.ts:182-193`, which pins postEntry's
old error text: assert the new sentence (still says "closed"); and `apps/erp/tests/integration/t375-s6-day-corrections-web.test.ts`
if it pins the text.

## S1 — F17 / DEF-785 (P3, latent): transaction-local exemption flags are never switched off
`packages/db/src/repo/journal.ts:410` sets `app.reversal_posting` = 'on' and `:424` sets `app.period_override` = 'on',
both `set_config(..., true)` (transaction-local) and never 'off', so a LATER ordinary posting in the same transaction
is still exempt (e.g. after `reverseEntry`, a `postEntry` to an archived account would pass the 0005 trigger). Bible
row 193: the exemption is for the one entry; fail closed. Ruling: add `endReversalPostingContext(tx)` and
`endPeriodOverrideContext(tx)` beside the setters (`set_config(..., 'off', true)`), and call them in `finally` right
after the exempted write: in `ledger/reverse-entry.ts` around its `postEntry` (~:184-195), and in
`ledger/post-entry.ts` after the override posting (~:211-261), including the `created: false` early-return path if the
flag was set before it. No trigger/migration change.
Test (red first, real Postgres): in ONE transaction, `reverseEntry(...)` then `postEntry` to an archived account →
refused by the trigger (today it succeeds); same for an override posting followed by an ordinary posting into the
closed month → refused. Existing `reverse-entry.test.ts` (:644-666, :809-840) and override tests stay green.

## S2 — F18 / DEF-786 (P3, missing backstop; NOT built in S1)
`packages/db/migrations/0005_reverse_entry_exemptions.sql:87-112` `journal_entries_check_posted_immutable` guards only
`OLD.status = 'posted'`; a `reversed` header (entry_date, period_id, memo...) can be updated or deleted by any path
(the lines trigger already covers both). New hand-authored migration (ADR-012 §5), number from the orchestrator:
`CREATE OR REPLACE FUNCTION journal_entries_check_posted_immutable()`: DELETE refused for `posted` OR `reversed`;
`posted` keeps today's UPDATE rules; `reversed` fully frozen (status stays `reversed`, every column except `updated_at`
unchanged). Update `packages/db/migrations/0161_*` reasoning only by a NOTE in the new migration (applied files are never
edited). Tests: raw-SQL UPDATE/DELETE of a reversed header refused; `t354-immutability-triggers-always`,
`t354-trigger-registry` (update a pinned body only if it pins it), `t345-missed-month` (reversed adjustments) green.
Full suite on a fresh DB before its PR.

## Files (S1)
`packages/domain/src/sales-days/correction.ts`, `packages/db/src/repo/journal.ts`, `packages/domain/src/ledger/reverse-entry.ts`,
`packages/domain/src/ledger/post-entry.ts`, the tests named above plus one new test file for F17,
`docs/DEFECTS-REGISTER.md` (DEF-784, DEF-785; DEF-786 as reported, S2 pending — full row shape, run
`tests/unit/register-row-shape.test.ts`).

## Acceptance (S1)
Red then green; `reverse-entry.test.ts`, override/period tests, `t375-s6-*` green; root + ERP typecheck clean; the WHOLE
unit project green (`npx vitest run --project unit`).

## S2 build notes (2026-10-26, orchestrator allocation)
Migration number **0219**, file `packages/db/migrations/0219_t492_reversed_header_frozen.sql`, journal entry `when` =
**1804995107084** (0217's + 2 days, above 0218's reserved 1804908707084; 0218 = T-398 S5, not on main yet — leave the
gap; the orchestrator renumbers S5 above this at its merge, rule 4c). Hand-authored per
`docs/decisions/ADR-012-hand-authored-migrations.md` §5 (`db:generate` is retired). Branch
`audit/t492-s2-reversed-header-frozen`, its own PR. Full integration suite on a fresh DB before the PR (migration rule).

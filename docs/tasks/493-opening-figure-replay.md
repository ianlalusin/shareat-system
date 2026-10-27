# T-493 — Re-entering an opening figure with a different amount is refused, never silently kept

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: audit finding F22 (Claude posting-paths
pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-posting-paths-pass.md`), re-verified on origin/main.
Branch `audit/t493-opening-figure-replay`. Defect DEF-783. F23 (same task number) is held until T-398 S5 merges; this
PR covers F22 only.

## Finding — DEF-783 (P3, live on the cutover screen)
`packages/domain/src/cutover/opening.ts:141` keys the opening entry on `opening:${orgId}:${accountCode}:${storeId}:${partyId}`
(no amount, direction, date or memo); `:160` writes lines only `if (created)`. So re-entering a figure with a corrected
amount (or flipped direction) returns the existing `entryId` as success and keeps the OLD amount. The screen is live:
`apps/erp/src/app/cutover/actions.ts:88-110` `addOpeningFigureAction`, form at `cutover/opening/page.tsx:89`. The intended
way to change a figure is remove-then-add (`removeOpeningFigureAction`, `:112-125`, needs `run_cutover` + admin PIN,
recorded approval).

## Rulings
1. When `created === false`, read the existing entry's lines and compare amount and direction (debit vs credit) with
   the request. Same → return `{ entryId }` as today (an identical repeat stays idempotent). Different → refuse, nothing
   written: "That figure is already entered as <existing amount> <Dr/Cr>. Remove it first, then enter the new amount."
   (`refuse(raw, sentence)`, the module's existing style). Do NOT edit the draft in place: that would skip the admin-PIN
   approval removal requires (a design question for Ian if ever wanted).
2. Reuse `packages/domain/src/ledger/replay.ts` if it is on main by then (T-488); otherwise compare inline with the
   module's existing money helpers — do not add a second copy of that helper.

## Tests (red first, real Postgres, dedicated fresh *_test DB)
`packages/domain/tests/integration/cutover.test.ts` (or a new `t493-opening-replay.test.ts`): identical repeat → same
entryId, residual unchanged (existing case stays green); same key, different amount → refused with the sentence, the
draft's lines unchanged; flipped direction → refused. ERP: `apps/erp/tests/integration/t390-s5-opening-web.test.ts` keeps
passing; add one action-level case if that file has the pattern.

## Files
`packages/domain/src/cutover/opening.ts`, the test file(s), `docs/DEFECTS-REGISTER.md` (DEF-783, full row shape — run
`tests/unit/register-row-shape.test.ts`). Nothing else.

## Acceptance
Red then green; `cutover.test.ts`, `t390-s5-opening-web.test.ts`, `t343-s5-5v-followups.test.ts` green; root + ERP
typecheck clean; the WHOLE unit project green (`npx vitest run --project unit`).

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

## S2 — 2026-10-28 (Opus planner, AUDIT session): a customer cash refund comes from the refunding store's own account (F23, DEF-797)
Source: audit finding F23 (Claude posting-paths pass, `C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-26-claude-posting-paths-pass.md`),
re-confirmed on main fd3ae7b. **Ian's ruling, 2026-10-28: "yes refuse"** — a refund from another store's money account is refused
(no transfer / inter-store path). Branch `audit/t493-s2-refund-own-store-account`, own PR; DEF-797 and bible row 402 from the orchestrator.
- **Today:** `packages/domain/src/trade/returns.ts` ~317-326 (`recordCustomerReturn`, `input.refund`) loads the money account and
  credits it at `order.storeId` without checking `account.storeId === order.storeId`, so a refund could take money out of another
  store's safe while the books say the refunding store paid. Customer collections (`ar/index.ts` ~572-586) and AP payments guard
  the cross-store case properly. The refund screen hides the account choice today, so this is caller-guarded, not yet observed.
- **Rulings:** (1) after loading the account, refuse unless `account.storeId === order.storeId`: "That money account belongs to
  another store. A refund is paid from this store's own cash." (same `{ ok: false, reason }` shape the function already returns;
  if it has a user-facing reason field, use it). (2) Refuse the staff cash float (GL 1120) by name, before posting, as payroll does
  (T-486 / `assertPayrollMoneyAccount` in `payroll/index.ts`; reuse the same reason wording style): a float belongs to one person's
  cash request and a refund has none to attach (today the database would reject it with a developer error). (3) Change nothing else
  in `returns.ts` (#86 is also changing this file: keep the diff to these checks).
- **Tests first (real Postgres, dedicated fresh *_test DB):** in the existing customer-returns integration test (or a new
  `t493-s2-refund-own-store.test.ts`): refund from another store's account → refused, nothing written (no return row, no journal
  entry, no stock movement); refund from the store's 1120 float → refused by name, nothing written; refund from the store's own
  office cash → unchanged (posts).
- Files: `packages/domain/src/trade/returns.ts`, the test file, this spec, `docs/DEFECTS-REGISTER.md` (DEF-797, full row shape),
  `PROJECT_BIBLE.md` row 402 (planner writes it).
- Acceptance: red then green; customer-returns / trade tests green; root + ERP typecheck; WHOLE unit project; register-row-shape.

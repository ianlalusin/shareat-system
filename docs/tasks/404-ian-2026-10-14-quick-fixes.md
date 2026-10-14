# T-404 — Ian's 2026-10-14 quick fixes (UI only)

**Status:** ✅ BUILT 2026-10-14 on `claude/pos-v2-feature-planning-1vey06`
**Source:** [`docs/feedback/2026-10-14-ian-raw.md`](../feedback/2026-10-14-ian-raw.md) items 13, 15, 24/25, 31;
review [`docs/feedback/2026-10-14-ian-feedback-review.md`](../feedback/2026-10-14-ian-feedback-review.md).
**Model:** written and built in one session; no schema, no domain, no posting change.

## Why these and not the rest
Only items that change **presentation** and reverse **no** recorded decision. Everything that touches the
data model, `authorize()`, posting, or a bible row is in the review as a question for Ian.

## Scope — files touched (and nothing else)
| File | Change | Ian item |
|---|---|---|
| `apps/erp/src/app/ap/suppliers/[id]/page.tsx` | Read-only **details card** above the edit disclosure; **Invoices** table (already loaded, never rendered) with whole-row link; "Owed (2110)" → "Owed to this supplier" | 25, 24, 15, 13 |
| `apps/erp/src/app/admin/stores/page.tsx` | "Open a branch" form behind a `<details>` button (re-opens on a refused create); whole row opens the store | 31, 13 |
| `apps/erp/src/app/inventory/page.tsx` | "1310 + 1320 + 1330" → "Inventory on the books"; "1340 in transit" → "In transit (branch orders)" | 15 |
| `apps/erp/src/app/till/page.tsx` | "Charge to 1230" → "Charge to this person"; settled line names the advance in words | 15 |
| `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts` | Consequence-label key follows the renamed button | 15 |

## Rules followed
- **Whole-row link = T-258 stretched-link technique** (`relative` on `<tr>`, `after:absolute after:inset-0` on a real link
  with a distinguishing `aria-label`). Never `<tr onClick>`, never `<a>` around `<tr>`.
- **One primary per view (row 311):** the stores disclosure `<summary>` is styled `secondary`; the form's own
  "Open branch" stays the primary.
- **Bank number masked** on the supplier details card with the register's `maskAccountNumber` (DEF-498).
- **Empty facts say so in words** ("Not recorded"), never a blank cell (row 229's spirit).

## Not done (follow-up specs, see the review)
- The ~75-table whole-row sweep with a shared `RowLink` primitive + census test.
- The remaining ~16 files that print account codes (`accountLabel(code)` helper).
- `/ap/suppliers` read gate (`approve_supplier`) — needs the cashier invoice screen moved off `/ap` first.

## Verification
- `npm run typecheck` — clean before and after.
- `npm test` (unit) — see the commit message for the real numbers.
- Not browser-verified in this session (no app server/DB here); the orchestrator's live pass at 390/1280 should
  confirm the stretched rows and the supplier card.

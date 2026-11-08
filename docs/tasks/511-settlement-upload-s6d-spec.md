# T-511 Slice 6d - settlement form layout on /channel-settlements/record

Status: SPEC (Opus), 2026-11-08. Branch lane/t511-s6d off lane/t511-s6c-r (f1386b4). Source: the Form-layout hand-back in docs/tasks/544-channel-settlements-tabs-and-record-page.md.

## Context
T-511 Slice 6d. BOSS 8 Nov: S6c is PR #202 (lane/t511-s6c-r f1386b4). Do the "Form-layout hand-back" from `docs/tasks/544-channel-settlements-tabs-and-record-page.md` on `/channel-settlements/record`, on a NEW branch `lane/t511-s6d` (created, off f1386b4, worktree wt-t511). Ian's complaint (5-7 Nov): the settlement form looks bad. DRAWING ONLY: no migration, no domain, no money logic, no new fields. S6c's `settleChargeIds` stays out of the manual form (ruled; S7 approve passes it).

## What the repo looks like now (read 8 Nov)
- `SettlementForm.tsx` (609 lines, client) already sits in the kit's `SplitWorkspace` (T-444; columns equal 1fr/1fr at wide, `balance='details'` gives 0.8/1.2; no sticky), uses `FormGrid layout="pairs"` (T-445, max 40rem, 2 columns when the container is wide), `Field` with the `(?)` HelpTip hint (T-448), and `fieldset`+`legend` boxes with borders for deductions and loan.
- T-542 already removed the ⛔ glyphs from rendered text. STILL rendered: the "legacy system filtered it out and overstated fees" sentence (deductions) and the "double-count cost ₱198,148.29 … legacy system" sentence (panel footer).
- The panel is one bordered box with a "Check the payout" h2, a `dl`, "Check the numbers" button, preview; the submit is `SubmitButton` text "Post this settlement" below the box.
- `recordSettlementAction` errors redirect to `/channel-settlements` (`actions.ts:159`) with the flash; `/record` has no `FlashBanner` and no `withFlash`.
- Kit pieces to reuse: `FormSection` (fieldset + legend, hairline `border-top` between siblings, no box, `ui/FormGrid.tsx:125`), `SplitWorkspace`, `Field`, `Banner`, `FlashBanner`, `withFlash`/`redirectWithFlash` (`lib/flash.ts`).

## Rulings (reconcile the old 544 list with the newer kit)
1. **Layout.** Keep `SplitWorkspace` (do not hand-roll an lg grid). Add an optional prop `stickyDetails` that adds a class so the details section is `position: sticky; top: 1rem` ONLY inside the same container-query block that makes it two columns (add the CSS beside `.split-workspace-grid`, `globals.css:~539`). Other users of `SplitWorkspace` (`items/[id]`) are unchanged. Form side ≤ ~44rem at 1440: the `pairs` grid already caps at 40rem; use `balance='details'` only if the render shows the form column too wide.
2. **Four sections, no nested bordered boxes.** Use `FormSection` (legend is the heading; accessible, house kit). Deviation from the hand-back's literal `h2`, on purpose. 1 **Which day**: Channel and Day being settled, each on its own full row (the day option text is long and must not clip); the "Banks into …" line and the "No payout account" warning stay as VISIBLE muted text under Channel (not hidden in a tooltip: it matters before posting). 2 **The payout**: Gross, Net, Payout reference, Settled on. 3 **What the platform deducted**: six inputs, 2 columns at 390px, 3 columns when the form column is ≥ ~36rem (container query, not viewport); one muted line under the heading: "Each fee posts to its own account. A deduction can be negative: a promo credit stays a minus." 4 **Loan docked from the payout (optional)**: a `<details>`, summary is the heading.
3. **Loan `<details>` opens by itself** when `loanId` or `loanAmount` has a value, or when any active loan belongs to the selected channel's store. A pure exported helper `loanSectionOpen({ loanId, loanAmount, channelStoreId, loans })` decides the default; the person's own toggle wins afterwards (`open={userChoice ?? default}`, `onToggle` records it).
4. **Panel** ("Check the payout", sticky): Channel / Waiting balance / Verified day `dl`; then the preview; then "Check the numbers" (secondary) and "Post settlement" (primary, TEXT, `SubmitButton` with the same disabled rule as today); the existing "Nothing is written…" and the "why disabled" lines stay (not in the removal list); one muted line: "Book platform fees here only. Don't also log them as an expense."
5. **Remove from what users see** the "legacy system filtered…" sentence and the "₱198,148.29 … legacy system" sentence; keep both reasons as code comments.
6. **Rules that bind:** no colour-only signal; money through the existing `money()`; no `text-neutral-300/400` (T-514 guard; prefer the `text-muted` token); touch targets ≥ 44px; every existing `name`, rule, handler, hidden field and the hidden `differenceReason` mirror unchanged; the check → stale → post gating unchanged.
7. **Errors stay on the form.** `recordSettlementAction` error redirect goes to `/channel-settlements/record` (keeping `channel` and `day` in the nav if `redirectWithFlash`'s `Nav` allows those keys; else plain `/record`); `record/page.tsx` wraps `searchParams` in `withFlash` and renders `<FlashBanner flash={sp} />`. SUCCESS still goes to the overview. No keep-typing (out of scope; typed figures were already lost on error).
8. Accounts text per deduction (`accountLabel(...)` hint) stays.

## Tests (builder writes, red first where a behaviour changes)
- Field-name pin: the set of `name=` attributes and DEDUCTIONS names in the form equals the set captured from git HEAD before the change (the 6 hidden/visible ids, 6 deductions, `loanId`, rule-driven names via `nativeAttrs`).
- Rendered-text guard (comments stripped, like the T-542 guard): no `198,148`, no `legacy system`, no glyph; "Post settlement", the four section titles, the deductions muted line and the panel muted line are present.
- Unit test for `loanSectionOpen` (value → open; amount → open; loan on the channel's store → open; none → closed; cross-store loan only → closed).
- `SplitWorkspace` `stickyDetails` class test; CSS rule scoped inside the container-query block.
- Update only the existing assertions that read the old drawing or the old error redirect (grep "Post this settlement", "channel-settlements", `recordSettlementAction`). Re-measure any census that moves (touch-target, form-grid, t450 inventory, editable-record, action-link-sweep) — never hand-edit; report each old → new.

## Order and models
Spec doc `docs/tasks/511-settlement-upload-s6d-spec.md` (this plan, committed by me, path-specific) → Sonnet builder → Sonnet verifier (read-only code audit against the rulings + RENDER at 1440 and 390 on port 9028 with a throwaway `shareat_test_*` DB seeded with one channel, one waiting day, one loan: empty, after "Check the numbers", a difference past tolerance showing the acknowledgement, a real post, a refused post landing on /record with the banner; screenshots; Impeccable guidance) → Sonnet fixer if needed → frozen-tree gate (tsc, unit, targeted integration/unit around channel-settlements and the censuses) → hand back to BOSS (one message). Every Agent call passes `model`; stop the dev server before any build.

## Verification
`npx tsc --noEmit`; unit suite + census tests; the new tests; screenshots from the render; no console errors on /record.

## Known limits (accept)
Manual form still cannot name netted charges; no keep-typing after an error; `legend` is the section heading rather than an `h2`.

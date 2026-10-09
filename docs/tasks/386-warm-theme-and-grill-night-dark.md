# T-386: the ERP looks like the brand. SharEat Warm in light, Grill Night in dark

**Status:** SPEC 2026-10-09 (Opus planner). NOT BUILT.
**Ruling:** Ian, 2026-10-09: *"go with B, C as dark mode"*. The values are recorded in ADR-013 **Amendment 7** and
bible §13 **row 294**. ⛔ The values are RULED. This task builds them and does not re-pick them.
**Source:** the rendered sheet, Artifact `https://claude.ai/artifact/L7hn691wjL76rSV2BgPa1A` (boards 00, B and C).
**Model:** Sonnet per slice, with the tester first and then the builder. An amendment is written in plan mode (Opus).
**Migration:** none. Tokens, fonts, components and static assets only.
**Relation to T-334:** T-334 slice 1 (the tokens and the cookie theme) and slice 2 (the `Button`/`Input`/`Card`
contract) exist. This task **re-values** slice 1's tokens and **reshapes** slice 2's components. T-334 slice 3, the
sweep of 283 raw buttons, 790 inputs and 240 selects, stays T-334's job and lands on what this task builds.
⚠️ Do it after S3 here, so the sweep happens once.

## Goal
- Every screen sits on the cream canvas in warm ink, with Baloo 2 headings, Plus Jakarta Sans body text and the
  SharEat logo. Dark mode (the existing cookie toggle) shows Grill Night's charcoal.
- One kit gives each state a single look: a primary, secondary, ghost or danger button that is default, hover,
  focus, disabled or pending; a field that is default, focus, invalid or disabled; a status badge; a banner; a toast.
- Contrast is measured in both themes, and every figure in Amendment 7 is pinned by a test.

## v1 as requirement (bible §1.2d)
1. **What v1 does.** `ERP-rebuild/src/app/globals.css` is amber on white. `src/components/ui/status-badge.tsx` maps
   status to a tone. `bubble-toast.tsx` stamps "approved" or "void". `modals/FormModal.tsx` puts Cancel and then Save
   at the bottom right.
2. **The goal underneath.** Staff read a document's state at a glance and get a physical confirmation when money moves.
3. **Count.** StatusBadge has about 12 call sites in v1. v2 has 0 badges, 0 toasts and about 95 hand-rolled tables.
4. **Beat it.** One Badge that every status uses, with a dot and a word so colour is never the only signal. One
   toast system, not v1's two. Errors marked at the field, which v1 only half did.

## Slices

### S1: tokens, fonts, ground, logo (the half-day that changes every screen)
- `apps/erp/src/app/globals.css`: Amendment 7's table, light and dark, verbatim. Rewrite the header comments that
  the new values make false. `body { background: var(--canvas); color: var(--ink) }` (nothing consumed the tokens
  before; see the existing comment). ⛔ Keep `color-scheme: dark` in the dark block, for the reason that comment gives.
- `tailwind.config.ts`: colours for each new token (`field`, `field-border`, `muted`, `brand-ink`, `warning-ink`,
  `info`, `progress`, `closed`, plus `-soft` surfaces), all in the existing `color-mix` shape.
  `fontFamily.sans` = `var(--font-body)`, `fontFamily.display` = `var(--font-display)`.
- `layout.tsx`: `next/font/google` for Baloo 2 (600, 700) and Plus Jakarta Sans (400 to 700), both as CSS
  variables on `<html>`. Headings `h1`–`h3` use `font-display` through a base layer, not per page.
  Metadata title "SharEat ERP". Icons go in `apps/erp/public/` (copied from `Shareat Website/public/`: favicon.ico,
  icon-192.png, icon-512.png, apple-touch-icon.png, logo-icon.png); `metadata.icons` points at them.
- `components/shell/Sidebar.tsx`: the logo (32px) plus the wordmark "Shar**E**at", with the E in `text-brand-ink`.
  The collapsed rail shows only the logo.
- `global-error.tsx`: it has its own `<html>`, so give it the canvas and ink inline. The earlier comment's dark gap
  stays open (the boundary cannot read cookies).
- **Tests:** `tests/theme-tokens.test.ts` pins every Amendment 7 value and recomputes every contrast figure from the
  hex values (a test helper, not copied numbers). The negative: a change that moves `--field-border` back to
  `#eadfc6` must fail. Replace the test that pins the dark `--warning` gap open (ADR-013 Amendment 5 note); do not
  delete it. It becomes "`--warning-ink` dark clears 4.5:1 on the dark warning surface".
- **Seen (§9.4, render-first rule):** screenshots of `/sign-in`, `/expenses/new` and one report, in light and dark.

### S2: the kit reshaped (Button, Input, Card)
- `Button`: `rounded-full`; secondary hover `bg-canvas`; ghost variant added (Cancel). The size stays as the one
  geometry (Amendment 3; ⛔ no `size` prop). Danger is still outlined with the icon, now in `border-danger text-danger`.
- `SubmitButton` (new, `'use client'`): wraps `Button` and reads `useFormStatus()`. While pending it sets
  `aria-busy`, disables itself, shows a spinner and swaps its label ("Submitting…"). This is the fix for
  double-submits.
- `Input`: `rounded-[10px] bg-field border-field-border`. `invalid` sets a 2px `border-danger`.
  `focus-visible:ring-ink` is unchanged (Amendment 6).
- `Card`: `rounded-[14px] bg-surface border-surface-border`.
- **Tests:** update the pinned class literals in `ui-button.test.ts`, `ui-input.test.ts` and
  `touch-target-geometry.ts` deliberately (the files' own rules). The touch-target baseline may only improve.

### S3: the missing kit
- `Badge` plus `statusTone(status)`: one map from every document status in the schema to
  `info | warning | success | progress | danger | closed`. The test enumerates the schema's status enums, so a new
  status with no tone fails the build.
- `Banner` (`tone`, `role="alert"` for errors and `role="status"` otherwise, icon, optional "Go to field" link) plus
  `FlashBanner`, which renders `withFlash` keys. It replaces the hand-copied red, emerald and amber strings at the top
  of pages. That replacement is a sweep, so do it with T-334 slice 3, not here.
- `Select`, `Textarea`, `Checkbox`: native elements styled like `Input` (no Radix), with the same `invalid` contract.
- `Table` primitives (`Table`, `Th`, `Td`, `NumTd` with `tabular-nums` and right alignment). The header row sits on
  `bg-canvas`.
- `EmptyState` moved into `components/ui` with tokens. `reports/EmptyState` re-exports it.

### S4: field-level errors and the toast. ⚠️ Needs a ruling first; see Open questions
- The flash gains an optional `field` key. The page passes `invalid` to that field, and the banner links to it with
  `aria-describedby`.
- The `ok` flash renders as a toast (bottom right, 4s, `role="status"`). Errors never become toasts; they stay as
  banners.
- Stamp ("APPROVED" or "VOIDED") on approve and void, shown for 1.2s and skipped under `prefers-reduced-motion`.

## Not in scope
- C's 52px floor density, and any second control size (Amendment 3; Ian's call).
- Restyling individual pages. T-334 slice 3 does that, onto this kit.
- The dark-mode toggle UI. That is T-334's toggle slice, unchanged.

## Open questions (for Ian, before S4)
- `t386-q1-toast`: should success confirmations become a toast, or stay a banner at the top as now? (a) a toast for
  success, banners for errors · (b) everything stays a banner.
- `t386-q2-stamp`: keep v1's "APPROVED / VOIDED" stamp animation? (a) yes, on approve, verify and void · (b) no.

## Done when
- S1–S3 are merged through a PR with green CI (bible row 291), and the screenshots are attached in both themes.
- `theme-tokens.test.ts` recomputes every Amendment 7 figure, and each pinned value has a negative that fails.

# T-249 — DEF-239: an action link is a 16px tap target on a touch-first product

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane B**. Write the spec into this file **in plan mode**, send
> `[B] SPEC`, and stop until you receive `APPROVED`.

## The defect

**DEF-239** (`docs/DEFECTS-REGISTER.md`) — measured in the browser by lane C at `523be5b`:
`Add a sales channel →` renders **118×16px** and `Issue a PIN from Staff →` **127×16px**,
*identically at 390 and 1280*. From the DOM: `text-xs underline underline-offset-2`,
`display:inline`, zero padding, `font-size:12px`, `line-height:16px`, no responsive variant.

⛔ **This is not a T-243 regression and the spec must not treat it as one.** `git show 523be5b^`
shows the two hand-wired links T-243 replaced carried the **identical class**; T-243's invariant 3
promised to preserve them "without losing a pixel" and did. **The defect is the idiom, not the
task**, and it predates both.

⚠️ Nor is it the viewport-breakpoint trap: identical at both widths means it is a globally
undersized target, not a responsive failure. Do not reach for a breakpoint.

## The population — counted, and it decides the scope

`text-xs underline underline-offset-2` appears **4 times across 3 files**:

| File | What it is |
|---|---|
| `apps/erp/src/app/admin/stores/[id]/page.tsx:119` | the readiness remedy link (T-243) |
| `apps/erp/src/app/customers/[customerId]/page.tsx:336` | link |
| `apps/erp/src/app/customers/[customerId]/page.tsx:455` | link |
| `apps/erp/src/app/settings/expense-categories/page.tsx:127` | ⚠️ a `<button type="submit">`, not a link — a form action at the same size |

⭐ **Recommend the scope, do not assume it.** Fixing only the readiness panel leaves three
siblings inconsistent; fixing all four is a small sweep. Count elements, not files — one of the
four is a button, and this project has taken three defects in one day from per-file counting.

## The bar to hit, and why it is not a WCAG argument

**T-241 already decided this once**: the shared filter row deliberately took the **larger** of the
in-repo button shapes — 42px tall — *specifically so no screen would lose touch-target area*. That
reasoning was applied to buttons and never reached these inline action links. Ian's standing rule
is that the app runs as an APK on phones and tablets and **phone portrait is the canvas**.

⚠️ WCAG is weaker support than it looks here and the spec should not lean on it: SC 2.5.8 (Level
**AA**, 24×24) carries an **inline exception** for targets within a sentence, which is arguable
for these; SC 2.5.5 (Level **AAA**) is 44×44. Cite T-241's precedent and Ian's rule as the
governing bar; mention WCAG as corroboration, not as the argument.

## Constraints

- ⛔ Do not shrink anything else to compensate, and do not change the copy.
- The remedy must not move the links or change what renders while a check is green — T-243's
  invariant 4 (a remedy renders only while `!c.ok`) still holds.
- Whatever shape you choose, say how a **future** link avoids re-introducing this. A fourth
  hand-styled instance is how it got here.

## Verification

⭐ This is a rendered-size defect, so a green suite proves nothing. Your READY must hand the
orchestrator the exact browser steps, as T-243's did — and the numbers to check are the **rendered
box heights at 390**, not just that the links still work. The measurable pass is a real box, not a
class name in a diff.

## Required reading

- `docs/RULES.md`; `PROJECT_BIBLE.md` §3.3 (spec format) and §9 (definition of done)
- `docs/DEFECTS-REGISTER.md` DEF-239, and DEF-199 / `docs/tasks/241-filter-row-component.md` for
  the sizing precedent

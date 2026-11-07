# T-538 — Phone card titles wrap to two lines instead of being cut off

> **Revision 2 (BOSS, 7 Nov).** Revision 1's `-webkit-line-clamp` was built and measured as inert on
> this cell — it is a grid item, so Blink blockifies `display: -webkit-box` to `flow-root`. Planner
> ruling: **option 2**, `max-height: calc(2 * 1.4em)` + `overflow: hidden` — two lines, no ellipsis.
> Continued on the same branch and the same PR #172. See **Builder notes**.

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | Freebuff Buffy (Codebuff) |
| Branch | `wo/t538-phone-card-title-wrap` (created from `origin/main` `78ec1a7`) |
| Worktree | `C:\Users\ianla\webapps\wt-t538` |
| Risk class | **low** (one CSS rule) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

On a phone, ERP tables turn into cards. Each card's title (an item, supplier or staff name) is forced
onto one line and cut off with "…" at about 140px, so a manager cannot tell "Chili flakes" from
"Chili powder". Let the title wrap to **at most two lines**, then end. Source:
`docs/reviews/impeccable-audit-2026-11-03.md` finding P2 #12.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order")
- `docs/RULES.md`
- `docs/reviews/impeccable-audit-2026-11-03.md` (finding 12)
- `apps/erp/src/app/globals.css` (~lines 610-635, the `[data-phone-table-root] [data-card-slot=...]` rules)
- `apps/erp/tests/t450-phone-table-cards.test.ts` and `apps/erp/tests/t450-phone-table-coverage.test.ts`

## 3. What to build

1. In `globals.css`, change ONLY the `[data-phone-table-root] [data-card-slot="title"]` rule:
   remove `display: -webkit-box`, `-webkit-box-orient`, `-webkit-line-clamp`, `line-clamp` and
   `text-overflow`. Keep `white-space: normal !important; overflow: hidden; overflow-wrap: anywhere;`
   and add `max-height: calc(2 * 1.4em);` (line-height stays 1.4, so the cut falls exactly between
   lines 2 and 3). Keep `grid-column`, `grid-row`, `font-size`, `font-weight` and `line-height`
   exactly as they are.
2. Leave the `subtitle` rule unchanged (one line is fine there).
3. Not to build: no TSX changes, no other CSS rules.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/app/globals.css` | edit — the one title rule |
| `apps/erp/tests/t538-phone-card-title-wrap.test.ts` | new — the test below |

The repo copy of this work order (`docs/tasks/538-phone-card-title-wrap.md`) is always allowed.

⛔ Any file not in this table is off limits. If an existing test fails because of this change, do
NOT edit it. Write the test name and output under **Builder notes**, open the PR as a draft.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t538-phone-card-title-wrap.test.ts` — "the card title clamps at two lines" | Reading `globals.css`: the `[data-card-slot="title"]` rule has `max-height: calc(2 * 1.4em)`, `overflow: hidden` and `white-space: normal`, and no `nowrap` |
| same file — "the subtitle still stays on one line" | the `[data-card-slot="subtitle"]` rule still contains `white-space: nowrap` |

Plus, every time:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t538-phone-card-title-wrap.test.ts apps/erp/tests/t450-phone-table-cards.test.ts apps/erp/tests/t450-phone-table-coverage.test.ts
```

## 6. Done means

- [x] §3 built, inside the §4 file list only
- [x] §5 tests written and passing; typecheck clean
- [~] Smoketested at 390px — see Builder notes: a DOM/CSS harness (not the signed-in app), because the
      session forge is outside §4
- [x] This work order copied as `docs/tasks/538-phone-card-title-wrap.md` with real check output
- [x] One PR against `main`, title starting "T-538:"
- [x] Work order moved from `current\` to `done\` with the PR link at its top

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

⏱ Revision 2 built 2026-11-07 02:40-03:05 in `C:\Users\ianla\webapps\wt-t538` on
`wo/t538-phone-card-title-wrap`, on top of revision 1's commit `9ce0dcb`.
PR **#172** — https://github.com/ianlalusin/shareat-system/pull/172 (ready for review, not draft).

### What changed (revision 2)

One rule, §4 files only. The title rule kept its `grid-column`, `grid-row`, `font-size`,
`font-weight` and `line-height: 1.4`; `display: -webkit-box`, `-webkit-box-orient`,
`-webkit-line-clamp`, `line-clamp` and `text-overflow` are gone; `white-space: normal !important`,
`overflow: hidden` and `overflow-wrap: anywhere` stayed; `max-height: calc(2 * 1.4em)` is new. The
subtitle rule is untouched. No TSX.

### Checks (real output)

```
$ npm run typecheck
> shareat-system@0.1.0 typecheck
> tsc --noEmit
typecheck exit=0

$ npx vitest run apps/erp/tests/t538-phone-card-title-wrap.test.ts \
    apps/erp/tests/t450-phone-table-cards.test.ts \
    apps/erp/tests/t450-phone-table-coverage.test.ts

 ✓  unit  apps/erp/tests/t538-phone-card-title-wrap.test.ts (2 tests) 76ms
 ✓  unit  apps/erp/tests/t450-phone-table-cards.test.ts (13 tests) 410ms
 ✓  unit  apps/erp/tests/t450-phone-table-coverage.test.ts (6 tests) 3268ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
```

No existing guard moved: this change adds no TSX control, so the touch-target census and
`action-link-sweep` are untouched (unlike T-537).

### 390px measurement — the point of revision 2

Byte copy of the real `apps/erp/src/app/globals.css`, with the card DOM the enhancer really builds
(`phone-table-cards.ts`: `table[data-phone-cards] > tbody > tr[data-card-kind="summary"]`, a
`data-card-slot` per cell, `data-card-has-keys` when a key cell exists). Viewport **390px**, fresh
load, no inline styles, `Chrome/130.0.6723.191 Electron/33.4.11`. Title column measured **237.4px**
(narrower than revision 1's harness, which had no key cell — a harsher width, and it still cuts):

| Title | Width | Height | Rendered lines | `max-height` | Cut? |
|---|---|---|---|---|---|
| "Chili flakes" | 237.4px | **22.4px** | 1 ✓ | 44.8px | no — fits |
| "Turmeric powder, ground, organic, 250g bag from Kerala" | 237.4px | **44.8px** | 2 ✓ | 44.8px | no — exactly 2 |
| an unbroken 50-char word | 237.4px | **44.8px** | 2 ✓ | 44.8px | no — exactly 2 |
| "Chili flakes, dried, crushed, harvested from the highlands of Kashmir" | 237.4px | **44.8px** | **2 ✓** (was **112px / 5 lines** in revision 1) | 44.8px | **yes** — 3 line boxes laid out, `scrollHeight` 67 vs 44.8 box, clipped at the line boundary |
| card with an image + a 3-line title | 237.4px | 44.8px box | 3 painted ✗ | 44.8px | **no** — `overflow: visible` |

`line-height` is 22.4px (1.4 × 16px), so 2 × 1.4em = 44.8px cuts exactly between line 2 and line 3:
no half-line, no clipped glyphs. **Two lines max, no "…"** — the missing ellipsis is the planner's
ruling for option 2, not an oversight.

### Two things the planner should know

1. **Cards with an image are not cut.** `[data-card-slot="title"]:has([data-card-image])` (a separate
   rule, ~line 645) sets `overflow: visible`, so the `max-height` clips the box but the third line
   **paints outside it** — measured `scrollHeight` 67 vs a 44.8px box, and the text runs into the
   subtitle at the same y. That rule exists so the absolutely positioned 44px image is not clipped by
   the cell, so the fix is not "add `overflow: hidden` there" without re-checking the image. Not
   changed: §3 names one rule only. Affects only tables whose title cell carries a photo.
2. **The §5 guards assert declarations, so they cannot prove the cut renders.** Revision 1 shipped
   with every check green and did nothing. That is why the harness table is the evidence here, and
   why it is in this work order. The declarations match the measurement by a measured `max-height`,
   but a CSS-only guard is a drift alarm, not a behaviour test.

### Not covered

The signed-in real app pages (`/ap/suppliers` etc.) — forging a session needs the orchestrator
skill's `forge-session.ts` + throwaway `_test` database, outside §4. Also: `npm run dev` normally
uses port 9008, which **another lane's `next start` (worktree `wt-t511`) was holding** at the time of
this run, so the harness ran on 127.0.0.1:9139 and nothing was started on 9008. Harness deleted
afterwards; `git status` shows only the two §4 files.

Built by Freebuff Buffy (Codebuff) from a work order.

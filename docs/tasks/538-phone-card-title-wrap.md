Claimed by Freebuff Buffy (Codebuff), 2026-11-06 23:03

# ⛔ BLOCKED — T-538 builds as written, but the CSS does not clamp in a real browser

The change is implemented exactly as §3 specifies, and every §5 check is green. **But a browser
measurement at 390px shows a long card title still rendering 5 lines, not 2** — the goal is not
achieved. Evidence and a named cause are in Builder notes §3; the asked-for "…" never appears.

---

# T-538 — Phone card titles wrap to two lines instead of being cut off

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | Freebuff / Buffy (Codebuff) |
| Branch | `wo/t538-phone-card-title-wrap` (created from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t538` |
| Risk class | **low** (one CSS rule) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

On a phone, ERP tables turn into cards. Each card's title (an item, supplier or staff name) is forced
onto one line and cut off with "…" at about 140px, so a manager cannot tell "Chili flakes" from
"Chili powder". Let the title wrap to **at most two lines**, then end with "…". Source:
`docs/reviews/impeccable-audit-2026-11-03.md` finding P2 #12.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order")
- `docs/RULES.md`
- `docs/reviews/impeccable-audit-2026-11-03.md` (finding 12)
- `apps/erp/src/app/globals.css` lines ~610-635 (the `[data-phone-table-root] [data-card-slot=...]` rules)
- `apps/erp/tests/t450-phone-table-cards.test.ts` and `apps/erp/tests/t450-phone-table-coverage.test.ts` (existing tests for these cards)

## 3. What to build

1. In `globals.css`, change ONLY the `[data-phone-table-root] [data-card-slot="title"]` rule:
   remove `overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important;` and replace
   them with a two-line clamp:
   `white-space: normal !important; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere;`
   Keep `grid-column`, `grid-row`, `font-size`, `font-weight` and `line-height` exactly as they are.
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
| `apps/erp/tests/t538-phone-card-title-wrap.test.ts` — "the card title clamps at two lines" | Reading `globals.css`: the `[data-card-slot="title"]` rule contains `-webkit-line-clamp: 2` and `white-space: normal`, and does NOT contain `nowrap` |
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
- [ ] Smoketested: `npm run dev` in `apps/erp` (port 9008), browser at 390px wide, open a list page with long names (e.g. `/ap/suppliers`); long titles wrap to two lines then "…". Write what you saw in the PR — **☠️ THIS IS THE FAILURE. Measured in a browser: the long title renders 5 lines, not 2. See Builder notes §3.**
- [x] This work order copied as `docs/tasks/538-phone-card-title-wrap.md` with real check output under **Builder notes**
- [x] One PR against `main`, title starting "T-538:", body ending "Built by <app> <model> from a work order" — **opened as a DRAFT, per §8**
- [ ] Work order moved from `current\` to `done\` with the PR link at its top — **moved with "BLOCKED"**
- [x] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

### 1. What was built — exactly §3, nothing else

| File | Change |
|---|---|
| `apps/erp/src/app/globals.css` | only the `[data-phone-table-root] [data-card-slot="title"]` rule: the old `overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important;` replaced by `white-space: normal !important; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere;`. `grid-column: 2; grid-row: 1; font-size: 1rem; font-weight: 600; line-height: 1.4` untouched. The `subtitle` rule untouched. |
| `apps/erp/tests/t538-phone-card-title-wrap.test.ts` | new — the two §5 tests, `postcss`-parsed so a comment or a different selector naming `[data-card-slot="title"]` cannot satisfy them |

No TSX change, no other CSS rule. A temporary harness (`apps/erp/public/t538-*.{html,css}`) and its
throwaway static server were created for §3 below and **deleted**; `git status` shows only the two
files above.

### 2. The checks — all green

`npm run typecheck`:

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit

TYPECHECK_EXIT=0
```

`npx vitest run apps/erp/tests/t538-phone-card-title-wrap.test.ts apps/erp/tests/t450-phone-table-cards.test.ts apps/erp/tests/t450-phone-table-coverage.test.ts`:

```
 ✓  unit  apps/erp/tests/t538-phone-card-title-wrap.test.ts (2 tests) 52ms
 ✓  unit  apps/erp/tests/t450-phone-table-cards.test.ts (13 tests) 400ms
 ✓  unit  apps/erp/tests/t450-phone-table-coverage.test.ts (6 tests) 5143ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
```

No existing guard moved: `t450-phone-table-cards` asserts rendered card DOM (not the CSS), and
`action-link-sweep` counts TSX controls, of which this change adds none.

### 3. ☠️ The reason this is BLOCKED — measured in a browser, not argued

**The two §5 tests cannot catch this, and that is the finding.** Both assert *declarations in the
file*. The declarations are exactly what §3 asked for, so they pass — on CSS that never renders.
The test is a drift guard, not a behaviour guard.

**How it was measured.** This work order's smoketest needs a signed-in session, which a builder does
not have (see §4). So: a throwaway page loading a **byte copy of the real `globals.css`**, carrying
the cell shape the phone-card enhancer really produces (`apps/erp/src/components/ui/phone-table-cards.ts:69-86`:
`tr[data-card-kind="summary"]`, `data-card-has-keys` when the row has key cells, `data-card-slot` on
each cell), at a **390px** viewport, in **the packaged browser** —
`Chrome/130.0.6723.191 Electron/33.4.11`.

**What it measured, on a freshly loaded page with no inline styles:**

| Card | Title | Cell width | Rendered height | Lines |
|---|---|---|---|---|
| short | "Chili flakes" | 268px | 22px | **1** ✓ |
| medium | "Turmeric powder, ground, organic, 250g…" | 268px | 67px | **3** ✗ |
| unbroken | "Supercalifragilistic…" | 268px | 45px | **2** ✓ |
| long | "Chili flakes, dried, crushed, harvested from the highlands…" | 268px | **112px** | **5** ✗ |

The row really is the card grid — `display: grid`, `grid-template-columns: 44px 267.9px 16.9px` — so
the cell is a **grid item**, and the title cell computes **`display: flow-root`**, not
`-webkit-box`, even with `display: -webkit-box !important` forced inline. **Blink blockifies a grid
item's `display: -webkit-box` to `flow-root`**, and `-webkit-line-clamp` is inert without the legacy
box layout. The standard `line-clamp: 2` in the rule is no help either: in this engine
**`CSS.supports('line-clamp','2')` returns `false`** (only the `-webkit-` prefix exists), so that
declaration is dropped.

**The control that proves it is the context and not the declarations:** the *same rule*, matched by
the *same selector* on a `div`, a `span` and a `td` that are **not** grid items inside a card row,
clamps correctly — 268px wide, **45px = 2 lines**, `overflow: hidden`. So the five declarations are
right; the DOM they land on defeats them.

**Tried, and does NOT fix it — so nobody repeats these:**

| Attempt | Result |
|---|---|
| `display: -webkit-box !important` inline on the cell | computed `flow-root`, 5 lines |
| `-webkit-box-orient` + `-webkit-line-clamp` as `!important` | 5 lines |
| forcing `width: 268px !important` / `max-width: none !important` | 5 lines |
| taking the grid off the row (`tr { display: block }`) | 4 lines — still no clamp |
| clamping the inner `<a>` instead of the cell | the anchor computes `inline-flex` (a stronger existing rule, `globals.css:667`) and still renders 5 lines |

**Verified in the harness, not the app.** I did not build a session: the only sanctioned route
(`docs/SMOKETEST.md` §3) needs `forge-session.ts` / `make-test-dbs.mjs` / `run-with-db.mjs` from the
orchestrator skill plus a throwaway `_test` database — outside §4. **What this evidence does NOT
cover: a signed-in real page.** It is a byte-identical stylesheet against the real card DOM; if a
signed-in run disagreed, the run wins.

### 4. What the planner needs to decide — options, not built

1. **Clamp an inner wrapper, not the grid item.** Have the enhancer put the title text in its own
   element (`phone-table-cards.ts` is TSX-adjacent code outside §4) and clamp that; it is then not a
   grid item and the same five declarations work — the control above shows 2 lines.
2. **Two lines without the ellipsis**, on the cell as it is: `max-height: calc(2 * 1.4em)` +
   `overflow: hidden`. Deterministic, but it cuts mid-glyph instead of "…".
3. **Wait for the standard property.** `line-clamp` is in the rule already; when the engine supports
   it, this may start working with no further change — but that is not today's browser.

### 5. Housekeeping

`.env.local` was not needed (no `next dev` run for this task), so nothing was copied, and
`apps/erp/next-env.d.ts` was not touched.

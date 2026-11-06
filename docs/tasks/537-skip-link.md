Claimed by Freebuff Buffy (Codebuff), 2026-11-06 22:25

# T-537 — "Skip to content" link on every ERP page

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | Freebuff / Buffy (Codebuff) |
| Branch | `wo/t537-skip-link` (created from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t537` |
| Risk class | **low** (screens) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

A staff member using a keyboard (Tab key) must press Tab about 40 times to get past the sidebar
before reaching the page itself, on every ERP page. Add a "Skip to content" link that appears on the
first Tab press and jumps straight to the page content. Source: `docs/reviews/impeccable-audit-2026-11-03.md`
finding P2 #8 (WCAG 2.4.1).

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order")
- `docs/RULES.md`
- `docs/reviews/impeccable-audit-2026-11-03.md` (finding 8)
- `apps/erp/src/components/shell/AppShell.tsx` (the `return (...)` block at the end)
- `apps/erp/src/app/globals.css` around `.erp-workspace` (line ~289) to see the style conventions

## 3. What to build

1. In `AppShell.tsx`, inside `<SidebarProvider>`, add as the **very first** child (before
   `<div className="flex min-h-dvh">`):
   `<a href="#erp-main" className="erp-skip-link">Skip to content</a>`
2. In `AppShell.tsx`, give the existing `<main className="erp-workspace ...">` the attributes
   `id="erp-main"` and `tabIndex={-1}` (so focus lands on it). Change nothing else on that line.
3. In `globals.css`, add a `.erp-skip-link` rule: visually hidden until focused (position absolute,
   off-screen or clipped), and when `:focus-visible`, shown at the top-left over everything
   (high z-index), using existing colour tokens (`var(--...)` already used in this file), at least
   44px tall, with a visible focus ring. Also add `#erp-main:focus { outline: none; }` so the
   programmatic focus target does not draw a box around the whole page.
4. Not to build: no other page changes, no sidebar changes, no new component.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/components/shell/AppShell.tsx` | edit — the skip link and the `id`/`tabIndex` on `<main>` |
| `apps/erp/src/app/globals.css` | edit — the `.erp-skip-link` and `#erp-main:focus` rules |
| `apps/erp/tests/t537-skip-link.test.ts` | new — the tests below |

The repo copy of this work order (`docs/tasks/537-skip-link.md`) is always allowed.

⛔ Any file not in this table is off limits. **If an existing guard test fails because of the new
link** (for example `apps/erp/tests/action-link-sweep.test.ts` counts it and wants a new number),
do NOT edit that test or its baseline. Write the test name, the old and new number, and the output
under **Builder notes**, open the PR as a draft, and say so in the PR body. BOSS approves baseline
changes.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t537-skip-link.test.ts` — "the skip link is the first element and targets main" | Reading `AppShell.tsx` source: an `<a href="#erp-main"` with text `Skip to content` appears before `<Sidebar`, and `<main` carries `id="erp-main"` and `tabIndex={-1}` |
| same file — "the skip link is hidden until focused" | Reading `globals.css`: a `.erp-skip-link` rule exists, and a `.erp-skip-link:focus-visible` rule exists that makes it visible |

Plus, every time:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t537-skip-link.test.ts apps/erp/tests/action-link-sweep.test.ts apps/erp/tests/t450-phone-table-coverage.test.ts
```

## 6. Done means

- [x] Every step in §3 built, inside the §4 file list only
- [ ] Every §5 test written and passing; typecheck clean — **the new test passes and typecheck is
      clean, but one assertion of `action-link-sweep.test.ts` fails on its pinned total (1532 →
      1533). See Builder notes §2. `git checkout -- apps/erp/next-env.d.ts` was used once to revert
      a generated file `next dev` rewrote; it is not part of the diff.**
- [ ] Smoketested: `npm run dev` in `apps/erp` (port 9008), open any page, press Tab once, the link shows; press Enter, focus moves to the page content. Write what you saw in the PR — **partly: the app serves 200 but a signed-in session was not available to me, so the link is not in that HTML. The markup + CSS were driven in Chromium on a harness instead. See Builder notes §3.**
- [x] This work order copied as `docs/tasks/537-skip-link.md` with real check output under **Builder notes**
- [ ] One PR against `main`, title starting "T-537:", body ending "Built by <app> <model> from a work order" — **opened as a DRAFT, per §4**
- [ ] Work order moved from `current\` to `done\` with the PR link at its top
- [x] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies (no other branches, never work in the
shared checkout, never `worktree remove --force`/`rm -rf`, no invented numbers, no reference-repo
edits, no hard-coded business values, no bible/knowledge edits, no production server).

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

### 1. What was built — exactly §3, nothing else

| File | Change |
|---|---|
| `AppShell.tsx` | `<a href="#erp-main" className="erp-skip-link">Skip to content</a>` as the first child of `<SidebarProvider>`, before `<div className="flex min-h-dvh">`; `<main>` gained `id="erp-main" tabIndex={-1}` and nothing else on that line changed |
| `globals.css` | `.erp-skip-link` (absolute, `top/left: 0`, `z-index: 100`, `min-height: 44px`, `transform: translateY(-200%)`, tokens `--surface` / `--brand-ink`); `.erp-skip-link:focus-visible` (`transform: none` + 2px `--brand-ink` outline); `#erp-main:focus { outline: none; }` |
| `apps/erp/tests/t537-skip-link.test.ts` | new — the two tests in §5 |

`postcss` reads the real rules in the test rather than substring-matching the file, so a comment or
a different selector mentioning the class cannot satisfy it. The shell scan strips `/* … */` first:
`AppShell.tsx`'s own header comment contains the literal text ``<main>``, and a scan that reads
prose as markup would pass on a comment alone (it did, on the first run — see §2).

⛔ Two generated/temporary things were created and removed, and are **not** in the diff:
`.env.local` (copied in so `next dev` could boot, deleted after) and
`apps/erp/public/t537-harness.html` (the browser harness in §3, deleted after).
`apps/erp/next-env.d.ts` was rewritten by `next dev` (it repoints two `./.next/types/*` imports at
`./.next/dev/types/*`); it is **not** in §4, so it was reverted with `git checkout --` and the diff
contains only the three files above.

### 2. The checks, with real output

`npm run typecheck` → clean:

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit

TYPECHECK_EXIT=0
```

`npx vitest run apps/erp/tests/t537-skip-link.test.ts apps/erp/tests/action-link-sweep.test.ts apps/erp/tests/t450-phone-table-coverage.test.ts`:

```
 ✓  unit  apps/erp/tests/t537-skip-link.test.ts (2 tests) 114ms
 ✓  unit  apps/erp/tests/t450-phone-table-coverage.test.ts (6 tests) 3417ms
 ❯  unit  apps/erp/tests/action-link-sweep.test.ts (14 tests | 1 failed) 206ms
     ✓ accepted-baseline totals: 115 FAIL / 51 UNRESOLVED 1ms
     × the census TOTAL — every candidate, every bucket — matches what was actually measured 10ms
     ✓ no control is undersized or unresolved outside the accepted baseline 4ms
     ... (all other action-link-sweep assertions pass)

⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  apps/erp/tests/action-link-sweep.test.ts > T-262 / DEF-269 — every interactive control matches the accepted baseline > the census TOTAL — every candidate, every bucket — matches what was actually measured
AssertionError: expected 1533 to be 1532 // Object.is equality

- Expected
+ Received

- 1532
+ 1533

 ❯ apps/erp/tests/action-link-sweep.test.ts:514:28

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 21 passed (22)
```

**This is exactly the case §4 anticipated, and no test or baseline was edited. The numbers BOSS
needs to approve:**

| | Before | After |
|---|---|---|
| `results.length` (`action-link-sweep.test.ts:514`) | **1532** | **1533** |
| FAIL (`accepted-baseline totals`) | 115 | **115 — unchanged** |
| UNRESOLVED (`accepted-baseline totals`) | 51 | **51 — unchanged** |

The one new candidate is the new `<a>` in `AppShell.tsx`, and it is a **PASS at 44px**, not a new
defect: `computeControl()` calls `explicitHeightPx()`, which falls through to
`parseCssMinHeights()` (step 2b) for any class carrying a `min-height` — and `.erp-skip-link` is
declared `min-height: 44px`. So **`touch-target-baseline.json` needs no new entry**, and the
"no control is undersized or unresolved outside the accepted baseline" assertion still passes.
`grep -c AppShell apps/erp/tests/touch-target-baseline.json` → `0`, before and after.

⛔ `next-env.d.ts` was briefly in the working tree during the smoketest below and is deliberately
excluded from the commit.

### 3. Smoketest — what I actually saw, and the half I could not do

**`npm run dev` works on this machine today** (worth logging: `docs/SMOKETEST.md` §0 records
DEF-401 as "`next dev` is dead on this machine" and prescribes `next start`):

```
> next dev -p 9008
▲ Next.js 16.3.2 (Turbopack)
- Local: http://localhost:9008
✓ Ready in 6.5s
```

`curl http://localhost:9008/` → **200**, `<title>Dashboard — Shareat System</title>`.

⛔ **But `Skip to content` is not in that HTML, and that is correct, not a bug**:
`AppShell` returns bare `{children}` when `currentSession()` is empty, so with no session there is
no sidebar and no skip link. `grep -c 'id="erp-main"'` → `0`.

**So the signed-in half is NOT done, and I am not claiming it.** I did not build a session: the only
sanctioned route (`docs/SMOKETEST.md` §3) runs `forge-session.ts`, `make-test-dbs.mjs` and
`run-with-db.mjs` from the orchestrator skill's `tools/` directory plus a throwaway `_test`
database — files and a database outside this work order's §4 list, so I stopped rather than widen
the scope. **Someone with a session should confirm the two clicks in the real app.**

**What I did measure, and honestly labelled:** the markup from §3 step 1 and the CSS from §3 step 3,
pasted verbatim into a throwaway page (`apps/erp/public/t537-harness.html`, since deleted; the shell
chrome was stubbed with five links, tokens copied from `:root`) and driven in the packaged Chromium
on 9008. This tests the **DOM order and the CSS**, nothing about the app's data or auth.

| Step | Measured |
|---|---|
| Before any key | `top: -94`, `transform: translateY(-94.4px)`, `height: 47`, `visibleInViewport: false` — parked, takes no space |
| First **Tab** | `document.activeElement` is `<a href="#erp-main">Skip to content` — the FIRST focusable element, no sidebar link reached first ✓ |
| Focused appearance | `matches(':focus-visible'): true`, `top: 0`, `left: 0`, `width: 146`, `height: 47` (≥44), `transform: none`, `z-index: 100`, outline on `rgb(212, 9, 9)` = `--brand-ink`, background `rgb(255, 253, 248)` = `--surface` ✓ |
| Press **Enter** | `location.hash: #erp-main`, `document.activeElement` is `MAIN#erp-main` ✓, its `outline-width: 0px` (`#erp-main:focus` working), and the skip link is off-screen again ✓ |

⚠️ One measurement trap worth recording for the next builder: the first attempt pressed Tab on a
window whose `document.hasFocus()` was `false`, and reported the link focused but still at
`top: -94` — i.e. it looked like `:focus-visible` had failed. It had not; the page simply did not
have OS focus. The run above was taken only after clicking the page and confirming
`document.hasFocus() === true`, and it is that run the table reports.

### 4. Findings to log (not my files to edit)

1. **`npm run dev` on 9008 starts and serves today** (`Ready in 6.5s`, `/` → 200) while
   `docs/SMOKETEST.md` §0 still records DEF-401 as making `next dev` unusable. Either DEF-401 is
   fixed and the doc is stale, or it is intermittent. Reported, not edited.
2. `apps/erp/next-env.d.ts` is regenerated on every `next dev`, flipping `./.next/types/*` to
   `./.next/dev/types/*`. A builder that runs the app and then `git add -A` would commit it. Not a
   defect in this task's area — logged because it will bite the next builder.

Claimed by DeepSeek deepseek-flash, 2026-11-07 13:14 (Asia/Manila)

# T-545 — Make the dialog Close button big enough for a finger (DEF-815)

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t545-dialog-close-touch-size` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t545` (the builder creates it, and works only there) |
| Risk class | **low** (one class list) |
| Numbers reserved | migration: none · DEF: DEF-815 (already logged, do not write the register) · bible row: none |

## 1. Goal

Every pop-up dialog in the ERP has a Close "×" button in its top corner that is only 32 × 32 px
(`h-8 w-8`). On a tablet or phone that is too small to hit reliably; the project's rule is 44 px
(48 px preferred) on touch screens. Make the button 44 px on touch devices while keeping it compact
with a mouse. Source: `docs/reviews/impeccable-audit-2026-11-03.md` finding P2 #7; DEF-815.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `apps/erp/src/components/ui/Dialog.tsx` around lines 66-80 (the Close button)
- `apps/erp/src/app/globals.css` — search for `pointer: coarse` to see how the project already
  makes controls bigger on touch screens, and for `data-erp-size` (the button opts out of the
  global size rule with `data-erp-size="free"`)

## 3. What to build

1. In `Dialog.tsx`, change ONLY the Close button's classes so it is `h-8 w-8` with a mouse and at
   least 44 × 44 px on a touch screen. Use the same technique the project already uses for coarse
   pointers (a Tailwind variant or a CSS rule keyed on `(pointer: coarse)` — follow what you find in
   `globals.css`; if a utility or variant already exists, use it rather than adding a new one).
   Keep the icon at 18 px and keep `aria-label="Close"`.
2. If the technique you find lives in `globals.css` and needs one small rule for this button, you
   may add it there, scoped to a new class name used only by this button.
3. New test `apps/erp/tests/t545-dialog-close-touch.test.ts`: reads `Dialog.tsx` (and `globals.css`
   if you added a rule) and asserts the Close button carries the coarse-pointer sizing (44 px or
   more) and still has `aria-label="Close"`.
4. Not to build: no other buttons, no layout change to the dialog header, no change to how the
   dialog opens or closes.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/components/ui/Dialog.tsx` | edit — the Close button's classes only |
| `apps/erp/src/app/globals.css` | edit — only if a scoped rule is needed (step 2) |
| `apps/erp/tests/t545-dialog-close-touch.test.ts` | new |

The repo copy of this work order (`docs/tasks/545-dialog-close-touch-size.md`) is always allowed.

⛔ Any other file is off limits. **Guard tests you will probably move — do NOT edit them:** the
touch-target census / baseline (`tests/touch-target-geometry.ts` and the tests that use it), and
`apps/erp/tests/action-link-sweep.test.ts`. If one fails, write the test name, old and new numbers
and output in the PR body. Claude approves.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t545-dialog-close-touch.test.ts` | Close is ≥ 44 px on touch and still labelled |

Plus, every time — paste the real summary lines:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t545-dialog-close-touch.test.ts
```
```bash
npx vitest run --project unit
```

## 6. Done means

- [ ] §3 built inside the §4 list
- [ ] §5 tests passing; typecheck clean; full unit suite summary pasted
- [ ] Worktree completeness check and the pre-push `git diff --stat` check done (BUILDER-PROMPT.md)
- [ ] This work order copied as `docs/tasks/545-dialog-close-touch-size.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-545:", ending "Built by <app> <model> from a work order"
- [ ] Work order moved from `current\` to `done\` with the PR link at its top
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 and `BUILDER-PROMPT.md` NEVER list applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-07, from `origin/main` at `cba144f`, in worktree
`C:\Users\ianla\webapps\wt-t545` on branch `wo/t545-dialog-close-touch-size`.

### What changed (2 files + the test)

`apps/erp/src/components/ui/Dialog.tsx` — the Close button's class list gains `erp-dialog-close` and
keeps `h-8 w-8`, `aria-label="Close"`, the 18 px icon and its `ref.current?.close()` handler. Nothing
else in the file moved.

`apps/erp/src/app/globals.css` — one rule in the existing "Touch targets" section, using the same
plain-CSS technique as `.shell-nav-row` (Tailwind 3.4 has no pointer variant — the file says so):

```css
@media (pointer: coarse) {
  .erp-dialog .erp-dialog-close {
    height: 44px;
    width: 44px;
  }
}
```

⚠️ **Why `h-8 w-8` stays and the selector is two classes.** The first attempt replaced `h-8 w-8` with
the class alone. The touch-target census (`apps/erp/tests/action-link-sweep.test.ts` over
`touch-target-geometry.ts`) then read the button at **20 px** — it sizes a control from its Tailwind
classes and falls back to the font size when it cannot resolve one — and failed with:

```
NEW FAIL not in baseline: components/ui/Dialog.tsx 20px (floor 24px)
```

The work order forbids editing that census, and the honest fix is not to fight it: keep the mouse
size in a class it understands (`h-8 w-8` = 32 px, above its 24 px floor), and let the coarse-pointer
rule override it on touch. A single-class rule only *ties* with `.h-8` and would lose on source order,
so the selector is `.erp-dialog .erp-dialog-close` (two classes) — it wins whatever order Tailwind
emits its utilities in.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```
exit 0, clean.

`npx vitest run apps/erp/tests/t545-dialog-close-touch.test.ts`

```
 ✓ |unit| apps/erp/tests/t545-dialog-close-touch.test.ts (3 tests) 19ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

`apps/erp/tests/action-link-sweep.test.ts` (the touch-target census / baseline the order named) —
**no change needed, no number moved**:

```
 ✓ |unit| apps/erp/tests/action-link-sweep.test.ts (14 tests) 94ms
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

`npx vitest run --project unit --maxWorkers=6` (this 16-core / 16 GB Windows box cannot run the
project at default parallelism without mass 5 s timeouts — measured today on the sibling T-540 build:
49 failed files at 16 workers vs 6 at 6 workers). JSON summary:

```
Tests  total 11461  failed 19  passed 11438  pending 4
Test files with a failing test: 7
```

**The 7 failing files, and why none is this PR's code:**

| File | Failing | Nature |
|---|---|---|
| `tests/unit/deploy-pos-failed-build.test.ts` | 8 | fails identically alone — `spawnSync('bash', …)`, no usable bash on this box; reads `.github/workflows/deploy.yml`, untouched here |
| `tests/unit/t455-s9a-ops.test.ts` | 5 | same bash dependency, same untouched files |
| `tests/unit/glossary-trap-names.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/no-committed-secrets.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** (verified earlier today) |
| `tests/unit/position-defaults-callers.test.ts` | 2 | `STACK_TRACE_ERROR`; **passes alone** |
| `apps/erp/tests/t343-s5-5s-number-boxes.test.ts` | 1 | `STACK_TRACE_ERROR`; its other failures earlier today were 5 s render timeouts |
| `packages/db/tests/t402-s1b-catalogue.test.ts` | 1 | `STACK_TRACE_ERROR` |

`STACK_TRACE_ERROR` is vitest's placeholder for a worker that died without carrying a stack — the RAM
ceiling, not an assertion.

### Guard tests

**None moved.** The touch-target census and its baseline are green unchanged (14/14) — see the note
above on keeping `h-8 w-8`. No other census counts a dialog.

### Smoketest

**Not done — and this is a visual change, so say so plainly.** No signed-in ERP session is available
to this builder, so the 44 px button was not seen on a tablet. What is proven: the class is on the
button (test), the coarse-pointer rule is 44 × 44 (test), the icon is 18 px (test), and the census
still reads the button at 32 px for a mouse. The reviewer should check it on a touch viewport.

### Commits

- `T-545: the dialog Close button is 44px under a finger`
- `T-545: test the Close button's touch size, and keep the work-order copy`

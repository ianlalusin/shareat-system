# Claimed by DeepSeek deepseek-flash, 2026-11-11 10:29 (Asia/Manila)

# T-560 — Put stray pixel text sizes back on the standard type scale

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t560-text-size-scale` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t560` (the builder creates it, and works only there) |
| Risk class | **low** (class names only) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

About 46 places in the ERP use one-off pixel text sizes (`text-[10px]`, `text-[11px]`, `text-[13px]`,
`text-[15px]` …) instead of the design system's type scale, so small text looks slightly different from
page to page. Move them onto the standard Tailwind sizes. Source:
`docs/reviews/impeccable-audit-2026-11-03.md` finding P3 #16.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `apps/erp/tailwind.config.ts` (the font-size scale in use) and `docs/reviews/impeccable-audit-2026-11-03.md` finding 16

## 3. What to build

1. In every `.ts`/`.tsx` file under `apps/erp/src/` **except `apps/erp/src/app/pos/`** (the POS screens are
   being built by another team right now — do not touch them), replace arbitrary text sizes with the nearest
   scale size:
   - `text-[10px]`, `text-[11px]`, `text-[12px]` → `text-xs`
   - `text-[13px]`, `text-[14px]` → `text-sm`
   - `text-[15px]`, `text-[16px]` → `text-base`
   Only the `text-[NNpx]` token changes. Keep any prefix (`sm:text-[13px]` → `sm:text-sm`). Change nothing else.
   If a replacement leaves the same size class twice in one className, remove the duplicate.
2. New test `apps/erp/tests/t560-text-size-scale.test.ts`: scans `apps/erp/src` (excluding `app/pos/`) and fails
   listing file:line for any `text-[<number>px]`.
3. Not to build: no changes under `apps/erp/src/app/pos/`, no `globals.css` or Tailwind config edits, no other classes.

## 4. Files you may touch

| File | Change |
|---|---|
| any `.ts`/`.tsx` under `apps/erp/src/` outside `app/pos/` that contains `text-[NNpx]` | edit — that token only |
| `apps/erp/tests/t560-text-size-scale.test.ts` | new |

The repo copy of this work order (`docs/tasks/560-text-size-scale.md`) is always allowed.

⛔ Anything else is off limits. **Guard tests you may move — do NOT edit them:** any UI-token or class census
under `apps/erp/tests/` or `tests/unit/`, and tests asserting exact class strings. If one fails, write the test
name and output under **Builder notes** and in the PR body; Claude approves.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t560-text-size-scale.test.ts` | no arbitrary pixel text size remains outside the POS |

Plus, every time — paste the real summary lines:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t560-text-size-scale.test.ts
```
```bash
npx vitest run --project unit
```

## 6. Done means

- [ ] Every occurrence outside `app/pos/` replaced; count before/after in the PR
- [ ] §5 tests passing; typecheck clean; full unit suite summary pasted
- [ ] Worktree completeness check and the pre-push `git diff --stat` check done (BUILDER-PROMPT.md)
- [ ] This work order copied as `docs/tasks/560-text-size-scale.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-560:", ending "Built by <app> <model> from a work order"
- [ ] Work order moved to `done\` with the PR link; entry added to `BUILD-AUDIT-LOG.md` ("BUILT — awaiting audit")
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 and the BUILDER-PROMPT.md NEVER list applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

**Replaced:** 53 arbitrary pixel sizes in 19 files under `apps/erp/src`, all outside `app/pos/`
(which has none of these tokens anyway): `text-[10px]`×4, `text-[11px]`×24, `text-[12px]`×1 →
`text-xs`; `text-[13px]`×12, `text-[14px]`×1 → `text-sm`; `text-[15px]`×4 → `text-base`;
`text-[26px]`×1 → `text-2xl`; `text-[28px]`×6 → `text-3xl`. **After: 0** outside the POS (the new
test proves it). No replacement produced the same size class twice in one `className`, so no
duplicate had to be removed. Every diff line changes one token and nothing else
(`git diff --stat`: 19 files, 53 insertions, 53 deletions).

**Spec gap I had to fill — please confirm (BOSS):** §3.1's table stops at 16px, but the tree also
carried `text-[26px]` (1: the store name in `components/dashboard/StoreBars.tsx`) and
`text-[28px]` (6: the `font-display` dashboard headings in `app/page.tsx`, `ChannelDonut.tsx`,
`StoreBars.tsx`), while §3.2's test bans *any* `text-[<number>px]`. Nearest steps on Tailwind's
default scale (`apps/erp/tailwind.config.ts` defines no `fontSize`, so default steps apply):
26 → `text-2xl` (24px), 28 → `text-3xl` (30px). Leaving them would have made the §5 test fail; I did
not weaken the test.

**Guard tests that moved — NOT edited, per §4 ("guard tests you may move — do NOT edit them").
Claude approves these two:**

1. `apps/erp/tests/action-link-sweep.test.ts` — the accepted-baseline census pins
   **113 FAIL / 50 UNRESOLVED** (asserted at :208-242, entries in
   `apps/erp/tests/touch-target-baseline.json`). It now measures **114 FAIL / 49 UNRESOLVED**:
   ```
   AssertionError: expected { fail: 114, unresolved: 49 } to deeply equal { fail: 113, unresolved: 50 }
   NEW FAIL not in baseline: app/page.tsx 20px (floor 24px)
   baseline UNRESOLVED no longer reproduced (now resolvable?): app/page.tsx — ancestry truncated — no font size resolvable
   ```
   Cause: the "Set it under Employer numbers" link in `app/page.tsx` sat inside a
   `text-[13px]` span. An arbitrary size has no line-height, so the sweep could not resolve it
   (UNRESOLVED); `text-sm` carries line-height 20px, which resolves to a 20px box under the 24px
   floor. **The control did not get smaller — the sweep can now measure it.** The baseline entry
   needs to move from UNRESOLVED to FAIL and the pinned totals to 114 / 49.
2. `apps/erp/tests/t343-s6c-screen-labels.test.ts:80` — pins the muted-secondary element by its
   exact class string: `MUTED_TOKENS = 'block font-mono text-[11px] text-neutral-500
   dark:text-neutral-400'`. The sweep made those spans `text-xs`, so G1 now reports every
   capability key as stray:
   ```
   AssertionError: raw key(s) found outside any muted secondary element: record_sale, submit_sales_day, verify_sales_day, …
   ```
   The pin needs `text-xs` in place of `text-[11px]`.

3. `apps/erp/tests/t343-s6b-admin-users-labels.test.ts:209` — the same exact-string pin
   (`MUTED_TOKENS = 'block font-mono text-[11px] text-neutral-500 dark:text-neutral-400'`), so its U1
   case reports the same stray capability keys. It did not appear in my local run because that
   file's `beforeAll` hit its own 30s timeout first on this loaded machine; CI hit the assertion.
   The pin needs `text-xs` there too.

**Checks (real output, worktree `wt-t560`, real `npm ci`, `origin/main` = `6252b22`):**

```
npx vitest run apps/erp/tests/t560-text-size-scale.test.ts
 ✓ |unit| apps/erp/tests/t560-text-size-scale.test.ts (2 tests) 109ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

```
npm run typecheck
> shareat-system@0.1.0 typecheck
> tsc --noEmit
(no output — clean)
```

```
npx vitest run --project unit        (default 5s timeouts, machine under load)
 Test Files  52 failed | 567 passed (619)
      Tests  126 failed | 12146 passed | 33 skipped (12305)
 Duration  703.26s
```
Almost every one of those 126 is `Test timed out in 5000ms` in files this change does not touch
(the known local-only failures the work order names). To separate load from real breakage, the ERP
suite was re-measured with the per-test timeout raised on the command line only (no test edited):
```
npx vitest run apps/erp/tests --project unit --testTimeout=30000
 Test Files  10 failed | 263 passed (273)
      Tests  12 failed | 5014 passed | 21 skipped (5047)
```
Same 10 files run on an **unmodified `origin/main`** worktree (`wt-t541b`, commit `cb96683`;
`6252b22` is docs-only on top): `7 failed | 3 passed (10)`, `6 failed | 104 passed`. The 6 failures
common to both are the 3 `beforeAll` hook timeouts (`staff-positions-action`, `t343-s6b`,
`t438-hire-action`) and timeouts in `t343-s5-5s-number-boxes`, `t343-scheduler-status`,
`t441-s1-upload-rules`, `t502-s4-item-import` — pre-existing on this machine, not this diff. The
only failures this branch adds are the two guard pins above (4 tests); `t440-s2` G3b and one
`t343-scheduler-status` case are 30s timeouts that appear only under load (baseline passes them in
a quieter run).

**Smoketest:** not run. T-560 §6 does not ask for one and the token swap cannot change behaviour;
`npm run dev` on 9008 is shared with other lanes.

**CI (PR #221, run 42949798134):** the `typecheck, test, build` job fails **only** in the Unit tests
step, on those three pinned guard files:
```
 Test Files  3 failed | 616 passed (619)
      Tests  5 failed | 12295 passed | 5 skipped (12305)
```
action-link-sweep ×2, t343-s6c ×2, t343-s6b ×1. **Typecheck passed**; the Build step was skipped
because Unit tests stopped the job. No other test failed in CI.

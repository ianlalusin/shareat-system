Claimed by DeepSeek deepseek-flash, 2026-11-07 12:47 (Asia/Manila)

> **Worktree deviation:** the work order names C:\Users\ianla\webapps\wt-t542, but that directory already exists on this machine with a .git of its own and is NOT registered in shareat-system's worktree list (an orphan from an earlier attempt). It was left untouched. This build uses C:\Users\ianla\webapps\wt-t542b on the branch the work order names, wo/t542-dev-notes-out-of-screen-text, cut fresh from origin/main.

# T-542 — Take developer markers and task codes out of on-screen text

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t542-dev-notes-out-of-screen-text` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t542` (the builder creates it, and works only there) |
| Risk class | **low** (wording only) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

Some ERP screens show staff internal developer markers — `⛔`, `⭐`, and codes like `(T-130)`,
`(DEF-129)`, `(T-394)` — inside the help text. Staff don't know what they mean, and they make the
screens look unfinished. Remove the markers and codes from **rendered text only**, keeping the
sentences. Source: `docs/reviews/impeccable-audit-2026-11-03.md` finding P3 #15.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `docs/reviews/impeccable-audit-2026-11-03.md` finding 15

## 3. What to build

1. Visit each location below. **Only change text that is rendered to the user**: JSX text between
   tags, or string literals passed as rendered props/values (e.g. `hint="..."`, `blurb="..."`, a
   ternary that returns display text). **Never** change code comments (`//`, `/* */`, `{/* */}`,
   JSDoc). Some entries marked (?) may be inside a `{/* */}` comment: check, and if it's a comment,
   leave it and note that under Builder notes.
2. Edits:
   - Delete a leading `⛔ ` or `⭐ ` from the sentence. If it was the only emphasis and the next words
     are already in `<strong>`, nothing else changes.
   - Delete a parenthesised code like ` (T-130)`, ` (DEF-129)`, ` (T-394)`, ` (DEF-116, DEF-118)`,
     including the space before it. If the code is part of the sentence ("T-184's ..."), rewrite
     the minimum so the sentence still reads naturally without the code, and list it under Builder notes.
   - Do not change any other word. Do not add text.
3. Locations (paths under `apps/erp/src/app/`; lines are approximate, search near them):
   ap/page.tsx:43 · budgets/page.tsx:74 · channel-settlements/SettlementForm.tsx:345, :498 ·
   cutover/page.tsx:56, :194 · cutover/opening/page.tsx:391, :276 (?) · cash-requests/[id]/page.tsx:96 ·
   commissary/catalogue/page.tsx:78, :80 · commissary/orders/page.tsx:63 ·
   commissary/discrepancies/page.tsx:99, :110 · customers/page.tsx:57, :159 ·
   customers/[customerId]/page.tsx:242, :342 · customers/[customerId]/AutoAllocateCollectionForm.tsx:291 ·
   findings/page.tsx:183, :263 · findings/scorecard/page.tsx:161 · attendance/[dayId]/page.tsx:181, :239-240, :359 ·
   attendance/page.tsx:84, :122 · ap/suppliers/page.tsx:61 · clock/page.tsx:336, :374 (?), :440 (?) ·
   admin/stores/[id]/page.tsx:170 · ap/invoices/[id]/page.tsx:339
4. New test `apps/erp/tests/t542-no-dev-markers-on-screen.test.ts`: for each file you changed (a
   constant list in the test), strip comments (`//...` lines, `/* ... */` and `{/* ... */}` blocks)
   from the source, then assert the remaining text contains no `⛔`, no `⭐`, and no
   `/\((?:T|DEF)-\d{3}[^)]*\)/`.
5. Not to build: no other files, no wording changes beyond step 2, no layout changes.

## 4. Files you may touch

| File | Change |
|---|---|
| the files listed in §3 step 3 | edit — rendered text only |
| `apps/erp/tests/t542-no-dev-markers-on-screen.test.ts` | new |

The repo copy of this work order (`docs/tasks/542-dev-notes-out-of-screen-text.md`) is always allowed.

⛔ Any other file is off limits. **Guard tests you may move — do NOT edit them:** tests that assert
exact on-screen sentences (some `apps/erp/tests/*.test.ts` match page text with `toContain(...)`).
If one fails because a marker or code was removed from a string it expects, write the test name and
the failing line under **Builder notes** and in the PR body. BOSS approves the test text change.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t542-no-dev-markers-on-screen.test.ts` — "no developer markers in rendered text" | markers and codes are gone from what staff see |

Plus, every time — paste the real summary lines:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t542-no-dev-markers-on-screen.test.ts
```
```bash
npx vitest run --project unit
```

## 6. Done means

- [ ] Every rendered marker/code removed; every skipped (comment) location listed
- [ ] §5 test passing; typecheck clean; full unit suite summary pasted
- [ ] This work order copied as `docs/tasks/542-dev-notes-out-of-screen-text.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-542:", ending "Built by <app> <model> from a work order"
- [ ] Work order moved from `current\` to `done\` with the PR link at its top
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-07, from `origin/main` at `6a4ccc1`, in worktree
`C:\Users\ianla\webapps\wt-t542b` on branch `wo/t542-dev-notes-out-of-screen-text`.

**Worktree deviation.** The order names `C:\Users\ianla\webapps\wt-t542`, but that directory already
existed on this machine with a `.git` of its own and is **not** registered in `shareat-system`'s
worktree list (an orphan from an earlier attempt). It was left untouched; this build used `wt-t542b`
on the branch the order names.

### What changed — 17 files, 32 rendered markers

Every change is one of three edits, applied to rendered text only: delete a `⛔ ` / `⭐ ` marker,
delete a trailing ` (T-nnn)` / ` (DEF-nnn)`, or drop an icon from a ternary that returns display text.

| File | Removed |
|---|---|
| `ap/page.tsx:55` | `(T-130)` |
| `ap/suppliers/page.tsx:61` | `⭐` |
| `admin/stores/[id]/page.tsx:183` | `⛔` |
| `ap/invoices/[id]/page.tsx:381` | `(T-196)` |
| `attendance/page.tsx:84,122` | `⭐` ×2 |
| `attendance/[dayId]/page.tsx:164,181,194,239,240,359,370` | `⛔` ×5, `⭐` ×1, the icon ternary ×1 |
| `budgets/page.tsx:74` | `⛔` |
| `cash-requests/[id]/page.tsx:96` | `⭐` |
| `channel-settlements/SettlementForm.tsx:345,498` | `⛔` ×2 |
| `commissary/catalogue/page.tsx:78,80` | `⭐`, `(DEF-129)` |
| `commissary/discrepancies/page.tsx:110,158` | `⛔` ×2 |
| `customers/page.tsx:57,163` | `⛔`, `⭐` |
| `customers/[customerId]/page.tsx:246,248,351,509` | `⛔` ×2, `(T-330)`, `⭐` |
| `customers/[customerId]/AutoAllocateCollectionForm.tsx:291` | `⛔` (in `hint="..."`) |
| `cutover/opening/page.tsx:275` | `(T-394)` |
| `findings/page.tsx:183,263` | `⛔` ×2 (one in `blurb="..."`) |
| `findings/scorecard/page.tsx:161` | `⭐` |

**Markers the order listed that are inside comments — left alone, as §3 rule 1 requires:**
`clock/page.tsx:336,374,440` (all inside `{/* … */}`; the file has no rendered marker at all, so it
is **not** in the changed list), `commissary/orders/page.tsx:63` (inside `{/* … */}` — no change to
that file), `cutover/page.tsx:56,194` (both inside `{/* … */}` — no change to that file).

**Rendered markers found in a changed file that the order's line list did not name, and removed
because §5's test scans the whole file:** `attendance/[dayId]/page.tsx:194,370` (`⛔`),
`commissary/discrepancies/page.tsx:158` (`⛔`), `customers/[customerId]/page.tsx:248` (`(T-330)`).
`ap/invoices/[id]/page.tsx`'s listed `:339` carries no marker today; the only rendered one in the
file is `:381` `(T-196)`, which was removed.

⚠️ **One judgement call, flagged for review.** `attendance/[dayId]/page.tsx:164` was
`{isBlockingAnomaly(a) ? '⛔' : '⚠️'} {ANOMALY_LABEL[a] ?? a}` — an icon chosen by a ternary, not a
sentence prefix. It now reads
`{!isBlockingAnomaly(a) && '⚠️ '}{ANOMALY_LABEL[a] ?? a}`: a blocking anomaly prints its label with no
glyph, an advisory one keeps `⚠️` and its existing "— advisory, does not block sign-off" note. The
blocking explanation ("The blocking items above must be settled…") is unchanged. This is the only
change that alters an icon rather than deleting a marker character; if BOSS wants both states to keep
a glyph, that is a new wording decision, not a marker removal.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```
exit 0, clean.

`npx vitest run apps/erp/tests/t542-no-dev-markers-on-screen.test.ts`

```
 ✓ |unit| apps/erp/tests/t542-no-dev-markers-on-screen.test.ts (2 tests) 16ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

`npx vitest run --project unit --maxWorkers=6` (this 16-core / 16 GB Windows box cannot run the
project at default parallelism without mass 5 s timeouts — measured today on the sibling T-540 build:
49 failed files at 16 workers vs 6 at 6 workers). JSON summary:

```
Tests  total 11450  failed 24  passed 11422  pending 4
Test files with a failing test: 12
```

**The 12 failing files, and why none is this PR's code:**

| File | Failing | Nature |
|---|---|---|
| `tests/unit/deploy-pos-failed-build.test.ts` | 8 | fails identically alone — `spawnSync('bash', …)`, no usable bash on this box; reads `.github/workflows/deploy.yml`, untouched here |
| `tests/unit/t455-s9a-ops.test.ts` | 5 | same bash dependency, same untouched files |
| `tests/unit/glossary-trap-names.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/no-client-supplied-actor.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/no-committed-secrets.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** (verified twice today) |
| `tests/unit/position-defaults-callers.test.ts` | 2 | `STACK_TRACE_ERROR`; **passes alone** (verified today) |
| `tests/unit/t336-canonical-position-defaults.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `tests/unit/t375-no-typed-sales-figures.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `packages/db/tests/t402-s1b-catalogue.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `apps/erp/tests/t440-s2-live-check-guard.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** (42 tests green) |
| `packages/domain/tests/t502-s1-service-readers.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `packages/domain/tests/unit/t511-s4-stage.test.ts` | 1 | `STACK_TRACE_ERROR` |

`STACK_TRACE_ERROR` is vitest's placeholder for a worker that died without carrying a stack — the
same signature produced by the RAM ceiling, not by an assertion. Three of them were re-run alone and
all 50 tests passed (`glossary-trap-names`, `no-client-supplied-actor`, `t440-s2-live-check-guard`).

Targeted render tests for the screens this PR touches, run separately:

```
 ✓ t343-s6c-screen-labels.test.ts (11)  ✓ t350-channel-payout-change-render.test.ts
 ✓ t351-settlement-preview-render.test.ts  ✓ t343-s5-1c-commissary-refusals.test.ts
 ✓ t348-page-description.test.ts
 Test Files  5 passed (5)
      Tests  56 passed (56)
```

### Guard tests

**None moved.** No census, `action-link-sweep`, `t348-page-description-sweep` or page-container number
changed — the diff removes characters from existing strings and changes no element, control or
`PageDescription` count.

### Smoketest

**Not done — and this one matters more than usual, because it is a visible-wording change.** No
signed-in ERP session is available to this builder, so no screen was seen in a browser; the tests read
source and the typecheck is clean. What a reviewer should eyeball: the anomaly list on
`/attendance/[dayId]` (the icon change above), and that the sentences read naturally where a marker
was deleted mid-paragraph.

### Commits

- `T-542: remove developer markers and task codes from on-screen text`
- `T-542: test that rendered text carries no markers, and keep the work-order copy`

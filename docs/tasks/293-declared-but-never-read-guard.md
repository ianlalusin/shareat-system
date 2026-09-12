# T-293 — is there a cheap guard for "declared, registered, and unreachable"?

> **Status: ASSESSMENT WRITTEN, 2026-09-12 — no code changes proposed for approval, one narrow
> build recommended below (§7). This document IS the deliverable; RULES §4 / bible row 163.**
> ⭐ **The most valuable finding is not a gap — it's that a general mechanism for one of the five
> shapes already exists, already caught one of the five, and was never wired to anything.** See §3.

Source: `docs/DEFECTS-REGISTER.md` DEF-320's disposition. Five instances of "built, registered,
tested, green, and unreachable" in one day: DEF-299, DEF-260, DEF-314, DEF-316, DEF-320.

## 1. What each of the five actually is, precisely

| Defect | What's declared | The unreachable unit |
|---|---|---|
| DEF-299 | `sweepOrphanedFiles` (fixed 09-12, now `runOrphanFileSweep`) | a whole exported **function** |
| DEF-260 | `activateTerminal` (`attendance/terminals.ts:115`) | a whole exported **function** |
| DEF-314 | `postEntry`'s optional `periodOverride` field | one **property of an input object**, not the function itself — `postEntry` has ~46 callers |
| DEF-316 | `stores.stock_model` | a **database column** — not TypeScript at all |
| DEF-320 | 4 of `PURPOSE_LIMITS`'s 5 keys | **string-literal members** of a const map, not the map itself, which is imported and used constantly |

⭐ **This table is the headline of the whole assessment.** These are not five instances of one
shape. They are four different *kinds* of "unreachable" (function / object-field / schema-column /
map-member), and a mechanism built for one kind is structurally blind to the other three — not
under-tuned, blind, because it isn't looking at that kind of thing at all.

## 2. Census — what the four existing guards actually cover, and what they'd have caught

Read all four in full (`tests/unit/{scheduler-jobs-have-callers,system-transaction-callers,
auth-transaction-callers,domain-actions-have-callers}.test.ts`) rather than going by name.

| Guard | Population it scans | Caller check | Would it catch any of the five? |
|---|---|---|---|
| `scheduler-jobs-have-callers` (T-236/275) | exported `async function run<Name>(...)` in `packages/domain/src/**`, first param NOT org/tx-shaped | called from `scripts/*.ts` | **No.** Anchored on the literal `run` prefix. DEF-299's function was named `sweepOrphanedFiles` at the time — never enters this population regardless of caller status. Not DEF-260/314/316/320's shape either (not a `run*` job entry). |
| `system-transaction-callers` (T-251a/DEF-295) | N/A — not a population scan at all | is `systemTransaction()` called **only** from a fixed 7-file allowlist | **No — wrong problem entirely.** This is a closed-allowlist guard for ONE named privileged function (too many callers, not zero). Zero conceptual overlap with "a declared thing nothing reaches." |
| `auth-transaction-callers` (DEF-288) | same shape as above, for `authTransaction()` | same | **No**, same reason. |
| `domain-actions-have-callers` (T-227/DEF-198 family) | exported functions in `packages/domain/src/**` shaped **`(tx, …, actor: Actor, …)`** | referenced (name match, not even a call) anywhere under `apps/**` | **No.** Verified by reading the actual source: `activateTerminal(tx: Tx, input: { terminalId: string })` — **has no `actor` parameter at all**, so it never enters this guard's population. `postEntry(tx: Tx \| null, input: PostEntryInput)` is the same shape — no top-level `actor: Actor` param (it's nested three levels down inside `input.periodOverride.actor`), so `postEntry` isn't in this population either, and even if it were, the guard checks whether the *function* is called, not whether one *optional field* of its input is ever populated. |

**Concrete proof, not an argument — I ran all four against the real tree, today, with DEF-260,
DEF-314, DEF-316 and DEF-320 all still open and unfixed:**

```
Test Files  4 passed (4)
     Tests  19 passed (19)
```

All green. **This is the "old guard + planted unreachable thing = GREEN" proof the briefing asked
for, using the real instances rather than a synthetic plant** — stronger evidence than a fabricated
one, because there is no question of whether the plant was realistic.

## 3. ⭐ The finding that changes the question: a general mechanism for the *function* shape already exists

`scripts/production-caller-census.mjs` — found by `git grep`, then read in full — is **exactly**
"a general guard for a declared thing nothing reaches," already built, for the function-shaped
half of the population:

- Scans **every** exported function/const-arrow across the **whole repo** (854 files, 1,719
  exported functions as of today — not one package), classifying each as production-reachable /
  test-only / no-references-anywhere.
- Has real controls: 9 negative controls (must-be-reachable), 1 positive control (must-be-test-only),
  scan-size floors — the exact discipline this project's other guards use, already applied here.
- **It already caught DEF-260.** `docs/discovery/32-production-caller-census.md`, commissioned
  2026-09-10, lists `activateTerminal` as one of 59 "test-only" exports at line 345 of that doc —
  the same day DEF-260 was filed, by the same shape of reading. I re-ran the script just now
  (fresh, controls passing, 854 files) and `activateTerminal` is still there, in `testOnly`,
  unchanged, two days later.
- **§6 of that same discovery document already asked and answered this exact question** on
  2026-09-10: *"a mechanical 'zero production callers' check would fire 111 times, be ~90% wrong,
  and be suppressed within a day"* — and it already recommended the fix: **"a ratchet, not a rule.
  Freeze today's census as a checked-in baseline of names. The build fails only when a NEW export
  joins the zero-caller set... Recommendation: schedule the pass, ratchet the count, and do not
  build the lint rule."**
- **That recommendation was never built.** `docs/production-caller-baseline.txt` exists (the
  `--names` output, committed 2026-09-10) but `git grep -rn "production-caller-baseline"` returns
  **zero files that read it.** It is a frozen artifact nothing diffs against. I ran the script's
  `--names` mode again today and diffed it against that stale baseline by hand:

  ```
  + checkValuesMatch, closeYear, describeSources, requirePageAccess, retireStorePosition, setPositionDefault   (6 new zero-caller exports since 09-10)
  - singleRoomViolation, sweepOrphanedFiles   (2 that got real callers since and correctly dropped off)
  ```

  Four of the six additions (`closeYear`, `requirePageAccess`, `retireStorePosition`,
  `setPositionDefault`) are already independently known and tracked in
  `domain-actions-have-callers.test.ts`'s `EXEMPT` list — meaning a ratchet would have shown
  **agreement** with what other lanes already found by hand, not noise. `sweepOrphanedFiles`
  dropping off on its own (once `runOrphanFileSweep` gave it a real caller) is the live proof that
  a *regenerated* baseline self-corrects, where a hand-maintained one would not.

**So the honest framing is not "this project has no mechanism for this pattern." It has one, for
one of the four shapes, already proven, already right once, sitting unused for two days while four
more instances of the wider pattern were found by hand through four unrelated routes.**

## 4. The false-positive population, named before any design (per the briefing's own order)

For a *widened, rule-shaped* guard ("every exported symbol needs a caller"), not a ratchet:

1. **Public package-boundary exports.** `packages/domain/src`'s own `domain-actions-have-callers`
   guard already measured this precisely: ~400 exports, ~157 with no `apps/` caller, because most
   of `packages/*` exists to be consumed by *other packages*, not by `apps/`. Reporting all 157 is
   reporting noise — the guard's own header says so.
2. **Type-only exports** (interfaces, type aliases) — referenced only in type positions
   (`import type`), invisible to a value-reference scan, and a huge fraction of any package's
   surface.
3. **Referenced only by STRING, never by identifier** — DEF-320's exact shape.
   `PURPOSE_LIMITS['onboarding_document']` cannot be found by searching for the identifier
   `onboarding_document`; the only trace is the string literal `'onboarding_document'` wherever a
   caller sets a `purpose` field. Tracing that requires following a typed field's value across
   every call site, not matching an identifier — a fundamentally different, much harder analysis.
4. **Referenced only from tests** — the shape the existing census already handles correctly (it is
   the entire point of the `testOnly` bucket), but a naive "does anything reference this name"
   check without a test/production split would silently pass `sweepOrphanedFiles`-shaped defects as
   "referenced," which is exactly wrong.
5. **Re-exports.** `system-transaction-callers.test.ts`'s own history records this: a barrel
   `export { X } from './y'` is textually a reference to `X` but not a caller. Both existing
   allowlist guards had to special-case it; the production-caller census also special-cases it
   (`reexport` classification, excluded from "reachable").
6. **Database columns and schema members** — DEF-316's shape. Not TypeScript symbols at all; no
   existing guard, and no straightforward extension of one, looks at a Drizzle column definition
   and asks "does any repo function's `.set(...)`/`UPDATE` ever write this."

## 5. Cheap, expensive, or impossible — answered per shape, not as one verdict

| Shape | Example | Verdict | Why |
|---|---|---|---|
| **A — exported function, zero non-test callers anywhere** | DEF-260, DEF-299 (as it was) | **Cheap.** Mechanism already built, proven, whole-repo. Missing piece is a thin ratchet test wiring the existing script's `--names` output to the existing (stale) baseline file — the exact pattern all four existing guards already use for their own `EXEMPT`/`REQUIRED_CALLERS` lists. |
| **B — database column, no writer anywhere** | DEF-316 | **Expensive, not attempted.** A wholly separate mechanism: parse `packages/db/schema/*.ts` column definitions, then scan `packages/db/src/repo/**` for a `.set({col: ...})`/raw-SQL write per column. Its own false-positive class: system-managed columns (`created_at`/`updated_at` via `defaultNow()`), columns written only via a migration's `DEFAULT` or a trigger, columns written by raw SQL strings a naive scan of the query builder would miss entirely. |
| **C — string-literal member of a typed union/map never passed** | DEF-320 | **Expensive, not attempted.** Requires tracing literal string values assigned to one typed parameter across every call site — value-flow analysis, not identifier-reference matching. The existing census's own `DECL` regex doesn't even recognise `PURPOSE_LIMITS` as a declaration in the first place (its pattern only matches consts whose value is a function/arrow/generic — `PURPOSE_LIMITS: Record<...> = { ... }` is a plain object literal and never enters the scan at all). Two independent reasons this shape is invisible to shape A's mechanism, not one. |
| **D — one optional property of a large input type never populated at any call site** | DEF-314 | **Closest to genuinely impractical.** Would require, for every domain function taking a rich input object, enumerating every property of that type and checking whether *any* of its (often dozens to hundreds of) call sites ever sets it — real data-flow analysis across module boundaries, at a scale this repo's textual scanners (all four existing guards, plus the census) do not attempt anywhere today. Buildable in principle with a full type-checker-based tool; not buildable cheaply, and not recommended here. |

**A single general guard covering all five is not available.** The five instances are a census of
*how many different ways something can be unreachable*, not five symptoms of one gap.

## 6. The number, not the adjective

- **Hours for the one thing that IS cheap (shape A, wiring the existing census as a ratchet):**
  ≈3-4 hours — write a `tests/unit/production-caller-ratchet.test.ts` that shells out to (or
  reimplements calling) `production-caller-census.mjs --names`, diffs against a regenerated
  baseline, fails only on a name **newly** joining the zero-caller set, mirrors the stale-exemption
  rule the other four guards already enforce. The script itself needs no changes — it already
  passes its own controls today (854 files / 1,719 exports / controls green).
- **How many of the five it would catch:** **2 of 5** — DEF-260 (already proven: it's in the
  census's `testOnly` list today) and DEF-299-as-it-was (same shape, same mechanism, would have
  been caught the same way before it was fixed). **0 of 5 more** from shapes B/C/D without building
  three separate, unbudgeted mechanisms.
- **Hours for B, C, D:** not estimated precisely here — each is its own investigation before it is
  its own build, per RULES §4. Order-of-magnitude: B (schema-column-write coverage) is a day-or-two
  effort with its own false-positive tuning pass; C (string-literal-flow tracing) and D
  (optional-field population tracing) are each closer to a multi-day tooling project than a task
  slice, and D specifically may not be worth building even at that cost given how narrow its
  population (properties of rich input objects) is likely to be relative to the effort.

## 7. Recommendation

⭐ **Build the cheap one. Don't build the other three as part of this task; name them as separate,
Ian-level decisions instead.**

1. **Do**: wire `production-caller-census.mjs` as a ratchet test, regenerating
   `docs/production-caller-baseline.txt` itself (never hand-edited, matching DEF-240's lesson every
   other guard here already learned) and failing only on a name newly joining the zero-caller set.
   This is shape A, it is proven, and it is the one piece of this whole pattern where "cheap" is not
   a guess — the mechanism already exists and already worked once.
2. **Report, don't build**: DEF-316 (schema column) and DEF-320 (string-literal map member) each
   need their own scoped assessment before a build — they are different enough from each other and
   from shape A that bundling them into "the T-293 guard" would repeat DEF-295/DEF-304's own lesson
   (a guard whose claimed scope is wider than what it scans).
3. **Say so and stop**: DEF-314's shape (D) is not recommended for mechanical detection at all,
   at any near-term cost. The cheaper, correct move for that specific defect is the one its own row
   already names — a documentation fix (bible rows 193/196 stating the override is currently
   unreachable from the UI) plus Ian's decision on whether the screen was ever scoped, not a guard.

## Out of scope (this document only recommends; nothing here is built)

- The ratchet test itself — a build slice, pending approval.
- Any fix to DEF-316, DEF-320, or DEF-314's underlying gaps.
- Any change to the four existing guard files, `production-caller-census.mjs`, or
  `docs/production-caller-baseline.txt`.
- `packages/core/src/env.ts`, `scripts/**` (beyond reading), `tests/unit/config-contract.test.ts`,
  `apps/erp/**`, the stores domain, `packages/db/schema/access.ts`,
  `packages/domain/src/people/**`, migration `0146` — untouched, per the briefing.

## Done when

This document is the deliverable. Send as SPEC; stop; await APPROVED before any build slice.

See `docs/DEFECTS-REGISTER.md` DEF-299, DEF-260, DEF-314, DEF-316, DEF-320;
`docs/discovery/32-production-caller-census.md` (§6 especially — the prior, unbuilt recommendation);
`scripts/production-caller-census.mjs`; `docs/production-caller-baseline.txt`;
`tests/unit/{scheduler-jobs-have-callers,system-transaction-callers,auth-transaction-callers,
domain-actions-have-callers}.test.ts`.

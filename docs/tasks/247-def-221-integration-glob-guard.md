# T-247 — DEF-221: an integration test placed the obvious way never runs, and is credited anyway

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-247`) for the commit, date and outcome —
> the roadmap is the maintained record. Lane D, spec written in plan mode. Sent as `[D] SPEC`;
> nothing below is built yet.

## Goal

`apps/erp/tests/integration/**` matches no vitest include glob — it is excluded from the unit
project (`**/tests/integration/**`) and not included by the integration project (which only takes
`tests/integration/**`, `tests/invariants/**`, `packages/**/tests/integration/**`). A test file
placed there the obvious way — mirroring the already-working `packages/**/tests/integration/**`
convention — is collected by no project, never runs, and CI reports green. Close today's concrete
gap and make the next one impossible to ship silently.

## Scope

1. `vitest.config.mts` — one line added to the integration project's `include`
2. `tests/unit/integration-glob-guard.test.ts` — new file, the durable guard
3. `docs/tasks/247-def-221-integration-glob-guard.md` — this file

No other lane's files. `docs/DEFECTS-REGISTER.md` disposition wording goes to the orchestrator, as
with T-244.

## Contract

`vitest.config.mts`'s integration project gains one include entry:
`'apps/**/tests/integration/**/*.test.ts'`, alongside its existing three. No exclude changes on
either project. No new exported runtime symbol — the guard is a test file, not a library module.

## 1. The decision: include AND guard, not either alone

The task explicitly asks for a position on include-alone vs. guard-alone vs. both.

- **Include alone** closes today's named gap but leaves the failure mode — a `tests/integration/`
  directory the config doesn't know about — free to recur at the next nesting a lane doesn't
  think to check. The register's own remedy text already argues the guard is "better... because
  it catches the next directory too."
- **Guard alone** converts today's silent failure into a loud one, which is real progress, but it
  leaves `apps/erp/tests/integration/` — the exact, symmetric counterpart to
  `packages/**/tests/integration/**`, which already works — permanently unusable. DEF-221's own
  title is "placed the obvious way," which reads as an argument that the obvious way should work,
  not merely fail loudly forever.

**Both.** The include closes the concrete, demonstrated need (an app-level integration test has a
working home). The guard is what makes this task's own fix durable — it protects every directory
this config doesn't yet know about, including ones nobody has hit yet.

## 2. The include fix — verified not to move today's floor

```ts
// vitest.config.mts, integration project
include: [
  'tests/integration/**/*.test.ts',
  'tests/invariants/**/*.test.ts',
  'packages/**/tests/integration/**/*.test.ts',
  'apps/**/tests/integration/**/*.test.ts',   // NEW
],
```

`vitest.config.mts` is shared state across three lanes, so per the task's own warning this is
checked before building, not after:

- **Unit project unaffected.** Its exclude, `**/tests/integration/**`, has no `apps/` prefix — it
  already keeps any `tests/integration/` directory out of unit regardless of depth. Confirmed by
  reading the exclude pattern; it is depth-agnostic by construction.
- **Integration project's currently-collected set is unaffected today.** `find apps -path
  '*/tests/integration/*' -name '*.test.ts'` (and the equivalent `git ls-files` filter the guard
  itself uses) returns **zero files**. The new include glob has nothing to match yet — it only
  opens a destination for a file placed there from now on. Re-verified as part of the build
  sequence (§4) with a real command, not left as a read-only claim.
- **No other lane's globs move.** Only the integration project's `include` array changes; the
  unit project's `include`/`exclude` and the integration project's `exclude` are untouched.

## 3. The guard — `tests/unit/integration-glob-guard.test.ts`

Built on two precedents already in this codebase rather than inventing a third approach:

- **File discovery via `git ls-files -z --cached --others --exclude-standard`**, not a directory
  walk — the exact technique and reasoning `tests/unit/scheduler-jobs-have-callers.test.ts` uses
  (`apps/erp/.next` would otherwise be read as real source; `--others --exclude-standard` still
  sees a file written minutes ago that isn't staged).
- **Importing the real config rather than re-deriving a copy of its glob list** — the same
  principle `tests/unit/toc-freshness.test.ts` applies by importing `scripts/gen-toc` directly
  instead of hand-copying its logic. `import config from '../../vitest.config.mts'` gets the
  actual, currently-live `include`/`exclude` arrays for the `integration` project — so the guard
  can never itself drift from the config it is checking.

Logic:

1. List every tracked-or-untracked-but-not-ignored file whose path contains a `tests/integration/`
   segment anywhere and ends in `.test.ts` (matches the exact suffix every include glob in this
   config uses).
2. Convert the integration project's own `include` and `exclude` glob strings to `RegExp` with a
   small, purpose-built converter — literal segments escaped, `*` → one path segment, `**` → zero
   or more segments. This is exactly the vocabulary every pattern in `vitest.config.mts` uses;
   nothing broader is implemented, so nothing is shipped untested.
3. Fail, naming the offenders, if any candidate file is not matched by `include`, or is matched by
   `exclude`.
4. A floor test asserts real `tests/integration/` files exist before trusting an empty violation
   list — `reference_sweep_needs_nonzero_control`, this project's own named landmine for exactly
   this shape of check (a scan of nothing passes trivially).

## 4. Non-negotiable: watch the guard fail before believing it

Build order, in this sequence, each step's real output captured for READY:

1. Write the guard file.
2. Plant a canary: `apps/erp/tests/integration/__def221-canary__.test.ts`, one test, deliberately
   `expect(true).toBe(false)`.
3. Run `unit` + `integration` projects **before any fix** — both green. This is the proof DEF-221
   is real: a file with a guaranteed-failing assertion sits in the tree and nothing runs it.
4. Run the new guard alone — must fail, naming the canary. This is "watched failing," the task's
   own non-negotiable.
5. Widen the include in `vitest.config.mts` (§2).
6. Re-run the guard — green (the canary is now covered).
7. Re-run the `integration` project with the canary present — must now fail for real, on the
   planted assertion. Proves the fix works end-to-end: the file is actually collected and actually
   executes, not merely matched by a string.
8. Delete the canary. Final full run on a clean tree.

## Out of scope, and why

- **Any other config file.** `vitest.config.mts` only, per Scope.
- **Moving existing files.** No file needs to move — the gap is a missing destination, not a
  misplaced one; nothing currently lives in the affected directory.
- **A general "does every test file belong to exactly one project" audit.** The register's finding
  and the task's own framing are specifically about `tests/integration/`-named directories the
  config doesn't reach; broadening to every possible glob-overlap question is a different,
  larger task with its own false-positive surface (`tests/golden/`, `tests/unit/`, etc., which
  this guard does not touch).

## Done when

`npm run typecheck -- --incremental false` clean · the 8-step sequence in §4 run with real output,
including the two required "red" states (baseline canary-invisible, and guard-catches-canary) ·
`npm test` green on a clean tree (canary removed) · self-reviewed line by line · confirmed the
zero-existing-files claim in §2 with a real command, not assumed.

---

### FOR IAN

DEF-221 was a config gap: a test file dropped into `apps/erp/tests/integration/` — the natural
place, matching how every package already does it — silently never ran, and the build stayed
green. Fixed two ways: the obvious destination now actually works, and a permanent guard makes the
*next* unreachable directory (any app, any depth) fail loudly instead of silently, so nobody has to
remember this rule by hand again.

---

### Model

Spec on Opus (plan mode). Build is Sonnet-able: one config line, one guard file following two
established in-house patterns almost verbatim, no new business logic.

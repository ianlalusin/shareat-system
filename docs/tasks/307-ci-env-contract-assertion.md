# T-307 — assert CI's own environment block satisfies the app's startup contract

> **STATUS: APPROVED, BUILT.** Written and built by lane B (webapps-4e), 2026-09-14, approved by
> system32-85. Reserved 2026-09-13 by system32-85 (docs/DEFECTS-REGISTER.md DEF-329).

## Goal

Nothing in this repo checks that `.github/workflows/ci.yml`'s `verify` job's `env:` block — the
values every integration run and the eventual `npm run build` actually boot against — is a
consistent, startup-valid example of the contract `packages/core/src/env.ts` enforces. DEF-328 was
a one-character mismatch between two of those hand-maintained placeholders that took CI red for a
day and was invisible to typecheck and to the unit suite (neither loads server env); only a person
reading `gh run view --log-failed` found it. This task adds one fast, offline unit test so the next
such mismatch fails `npm run test` in seconds instead of surfacing as a red integration run a day
later. Full analysis: DEF-329 (not re-derived here).

## Scope

One new file: `tests/unit/ci-env-contract.test.ts`. Nothing else.

## Contract being asserted

`ci.yml`'s `verify` job's `env:` block, fed verbatim into `@shareat/core/env`'s real `env()` (the
same function `apps/erp` calls at startup), must:
1. Parse cleanly against `serverSchema` — every required field present and well-formed.
2. Pass `checkValueContracts` with zero failures — `APP_TIMEZONE` agrees with `BUSINESS_TIMEZONE`,
   and `FIREBASE_PROJECT_ID` agrees with `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (both are set
   simultaneously in this job, unlike production — T-292 Finding 2 — so this is the one place in
   the whole system where that check runs against real, not synthetic, values).

## Mechanism

Dependency-free, matching `tests/unit/deploy-migrate-uses-system-db-url.test.ts`'s precedent: read
the real YAML as text, indentation-scope to the `verify` job's `env:` block (the workflow also has
an unrelated top-level `env:` for `NODE_VERSION`, and an eight-space-indented one under
`services.postgres` — must not be picked up by accident), parse flat `KEY: value` lines, unwrap
quoted scalars, set `process.env` to **exactly** that object (never merged with the ambient
environment — merging would let a variable set only on the developer's machine stand in for one
missing from `ci.yml`, so the test could pass locally while the CI run it is modelling would still
fail; the strict replacement is what makes the assertion mean "these values, alone, boot the
app"), `vi.resetModules()`, dynamically re-import `@shareat/core/env` (same pattern
`tests/unit/env.test.ts` already uses), call `env()`.

## Invariants / tests

1. Sanity: the extractor found a real, non-trivial set of keys (guards against the block coming
   back empty and every other test in the file trivially "passing").
2. The real block, today, boots `env()` clean — zero throw. **This alone proves little**: DEF-328
   is already fixed, so this test passes on the first run regardless of whether the mechanism
   works. The two controls below are the actual value of the file.
3. CONTROL — clone the block, reintroduce DEF-328's exact shape (mismatched project ids), assert
   `env()` throws matching the consequence sentence unique to that branch of
   `checkValueContracts` (`/rejected as unverifiable/`) — not `/FIREBASE_PROJECT_ID/`, which is
   also a substring of `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and would match for the wrong reason.
4. CONTROL — same treatment for `APP_TIMEZONE` vs `BUSINESS_TIMEZONE`, matched on `/BUSINESS_TIMEZONE/`
   (a token that appears only in that check's failure message).

## Pre-existing coverage, checked rather than assumed

DEF-315's row states `env.test.ts` "validates variables individually and never their
relationships." **Checked: no longer true, and the register is being amended by system32-85 to
reflect this** (not this task's job to edit it) — `tests/unit/env.test.ts:170-215` (added by
T-292, this task's own sibling) already asserts both `checkValueContracts` relationships,
including a DEF-328-shaped mismatch test. What was still missing, and what DEF-329 actually names,
is that every one of those tests runs against hand-typed literals the test file constructs itself,
never against `ci.yml`'s real values. This task's new test is the first thing in the repo that
reads `ci.yml` and asserts on it. `tests/unit/config-contract.test.ts` similarly exercises
`checkValuesMatch` only against inline literal arguments, never any file.

## Relationship to DEF-336 / T-308 — settled 2026-09-13, not reopened here

Not bundled. `docs/tasks/308-*.md` ("Why this is NOT bundled into T-307") is the record: T-307
asserts CI's configuration is internally correct; T-308 asserts CI ran at all. Two different
failure modes, two guards.

## Generalization question: does this mechanism reach `deploy.yml:13-18`?

No, not for free — structurally, not just as a matter of effort. This test's engine needs a real
*value* to run through `serverSchema`/`checkValueContracts`; `ci.yml`'s block has literal strings
because they're throwaway CI values, safe to commit. `deploy.yml:13-18` is a prose comment naming
GitHub *Secrets* — their values are never in the repo (that's the point of a Secret) and never
appear in the file as anything but `${{ secrets.NAME }}`. There is no value there to feed through
`loadServerEnv()`; the defect is a different kind of drift — a hand-written list of *names*
disagreeing with the `secrets.*` tokens the file actually references. What generalizes is the
spirit, not the plumbing: a second, standalone unit test that greps `deploy.yml` for
`secrets\.([A-Z0-9_]+)` tokens, greps the comment for the names it claims, and asserts the two sets
agree both ways — no YAML parsing, no `env.ts` involvement. Filed separately by system32-85 with
this assessment attached, confirmed as a two-part staleness (4 of 11 named secrets never read as
`secrets.*` in the file, and the comment's own "do not exist yet" premise is stale — deploys have
been succeeding). Not built here.

## Out of scope

- Editing `ci.yml`, `deploy.yml`, `.env.example`, `packages/core/src/env.ts`.
- The `deploy.yml` checklist-vs-usage guard described above.
- Correcting DEF-315's stale `env.test.ts` claim in the register (system32-85's own edit).
- Re-wiring `datetime.ts` to consume `env().APP_TIMEZONE` (T-292's own out-of-scope note).

## Done when

`tests/unit/ci-env-contract.test.ts` exists (only new file); `npm run test` green including its 4
assertions; `npm run typecheck` clean; nothing else modified.

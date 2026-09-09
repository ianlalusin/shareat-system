# T-247 — DEF-221: an integration test placed the obvious way never runs, and is credited anyway

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane D** (`fix-hasactiveadmin-super-admin`, was `ianla-0a`). Write
> the spec into this file **in plan mode**, send `[D] SPEC`, and stop until you receive `APPROVED`.

## The defect

**DEF-221** (`docs/DEFECTS-REGISTER.md:291`) — `apps/erp/tests/integration/**` matches **no vitest
include glob**. The integration project takes `tests/integration/**`, `tests/invariants/**` and
`packages/**/tests/integration/**` only. `apps/erp/tests/` holds unit files, and nothing says an
integration file may not be put beside them — so one placed there never runs, and is counted as
passing.

This is DEF-081's shape one directory over: a green run that never executed the file. It was found
by lane D placing T-232 slice 1's server-action test, which lives at `tests/integration/` for
exactly this reason.

⭐ **It nearly bit again today.** T-243's new route guard was placed in `apps/erp/tests/` — which
*is* covered, by the unit project's `apps/**/*.test.ts`. One directory lower and the guard would
have been credited without ever executing. The lane reasoned it out correctly; the config should
not require that reasoning.

## The shape of the fix — the register already argues for one

> Either add `apps/**/tests/integration/**` to the integration project's include, or — **better** —
> a unit guard that fails when any `*.test.ts` sits under a `tests/integration/` directory the
> config does not include, **because the guard catches the next directory too.**

Take a position on whether it is the guard alone, the include alone, or both, and say why. ⚠️ Note
the unit project currently **excludes** `**/tests/integration/**`, so adding an include to the
integration project without thinking about that exclusion is how a file ends up in neither or both.

## Non-negotiable for this task specifically

⛔ **The guard must be watched failing before it is believed.** A guard that has never gone red is
the exact defect this task exists to fix — proving it by writing a deliberately misplaced file,
seeing the guard catch it, and removing it. T-243 did this and it is the standard here.

⚠️ `vitest.config.mts` is **shared state**: three lanes run tests against this tree. It is yours for
this task and no other lane may touch it; if your change would alter which files any *other*
project collects, say so in the spec before building.

## Required reading

- `docs/RULES.md`, then `PROJECT_BIBLE.md` §3.3 and §9
- `docs/DEFECTS-REGISTER.md:291` (DEF-221) and the DEF-081 row it cites
- `vitest.config.mts` — read the comments; DEF-081's history is written into them

# T-244 — DEF-237's inner bug: a `super_admin`-only organisation is not "adminless"

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane D** (`ianla-0a`). Lane D writes the spec into this file
> **in plan mode**, sends `[D] SPEC`, and stops until it receives `APPROVED`. Nothing is
> approved yet.
>
> ⛔ **This task is deliberately the SMALLER HALF of DEF-237.** The grant-lifecycle question —
> what happens to already-elevated managers — is **Ian's decision and is not built here.**
> This spec ends with the two options written up for him, not with one of them chosen.

## The half that is built here

**DEF-237** (`docs/DEFECTS-REGISTER.md:307`) contains a plain bug that is wrong under *either*
lifecycle answer Ian picks:

> `hasActiveAdmin` (`packages/db/src/repo/access.ts:63-70`) matches the **literal** `'admin'`, so a
> **`super_admin`-only organisation counts as adminless** and elevates the next manager it appoints
> with the whole of `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` (`packages/auth/src/capabilities.ts:777`)
> — which includes `manage_users`.

A well-run organisation whose only administrator is a `super_admin` trips it. Nobody has to decide
anything to call that wrong.

### ⚠️ Three things that must be checked, not assumed

1. **`hasActiveAdmin` has other callers.** `packages/auth/src/roles.ts:97` is the elevation path.
   Find every other one and state, per caller, whether "counts a `super_admin`" is the right
   reading there — a lockout guard asking "would this leave nobody in charge?" may want the broad
   answer, and may already have it.
2. **`packages/db/src/repo/organizations.ts:63` is deliberately broader** and says so in its own
   comment. Do not "unify" the two without an argument; read that comment first.
3. **Two existing assertions expect `false`** — `packages/auth/tests/integration/authorize.test.ts:454`
   and `:511`. If this change flips them, that is a finding to report in the spec, not a test to
   quietly edit. Say which behaviour is right and why.

## The half that is NOT built here — write it up for Ian

DEF-237's remaining question, per the register row and `docs/HANDOFF-TODAY.md`:

- **Option 1** — revoke the elevated set when an organisation gains an active administrator.
- **Option 2** — mark those rows conditional at grant time; `authorize` ignores them once the
  condition lapses (`packages/auth/src/authorize.ts:105` is `matrixAllows || personHasActiveGrant`).

For each: what it costs, what it breaks, what it means for a manager mid-shift who loses powers,
and whether it needs a migration. **Recommend one, in one paragraph.** Then stop — bible §0.4 says
push back hard, and §14 says only the planner decides.

⚠️ **Not urgent, and say so in the spec.** T-242's rank ladder already makes this non-escalating,
production holds one person, so exposure today is zero. Rushing it is how a real lifecycle
decision becomes a patch.

## Required reading before writing the spec

- `docs/RULES.md`, then `PROJECT_BIBLE.md` §3.3, §9, §7 and §13 rows **115, 116, 186**
- `docs/DEFECTS-REGISTER.md:307` (DEF-237) and `:303` (DEF-234, for how row 186 was reached)
- `docs/tasks/242-def-234-removal-requires-rank.md` — the task that made this non-escalating

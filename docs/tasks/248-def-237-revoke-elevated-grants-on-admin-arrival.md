# T-248 — DEF-237: an elevated manager's grants end when an administrator arrives

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane D**, to be picked up **after T-247**. Write the spec into this
> file **in plan mode**, send `[D] SPEC`, and stop until you receive `APPROVED`.

## ⭐ Ian decided this. The shape is settled; do not re-open it.

**Ian, 2026-09-09 — Option 1: revoke the elevated set when an organisation gains an active
administrator.** Recorded as **bible §13 row 188**, which is now the authority. Read that row
before this file: it carries his reasoning, the rejected alternative, and the cost he accepted.

The rejected alternative — conditional grants that `authorize` ignores once the condition lapses —
is **not to be re-proposed**. It reintroduces at the grant layer the fuzzy check-time predicate
that **row 115** removed at the role layer.

## What is being built

`assignRole` (`packages/auth/src/roles.ts:96-108`) applies `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
(`packages/auth/src/capabilities.ts:777` — the derived admin-yes/manager-no set, `manage_users`
included) to a manager appointed while the organisation has no active administrator. Those land as
`person_grants` rows and **nothing has ever revoked them.**

This task adds the second moment: **when an organisation gains an active administrator, the grants
that were handed out because it had none are revoked.**

⚠️ **T-244 already shipped the inner half** (`495cf07`): `hasActiveAdmin` now counts `super_admin`,
so a super-admin-run organisation no longer elevates anyone in the first place. That narrows what
this task has to clean up — it does not replace it. Managers elevated *before* T-244, and managers
elevated in genuinely adminless organisations, still hold their grants.

## The questions the spec must answer — measure, do not assume

1. **Which arrivals count?** `assignRoleAsActor`, `assignRole`, `createFirstAdmin`, an unrevoke —
   enumerate every path by which an organisation can go from no-active-administrator to having one,
   and say which fire the revocation. Missing one leaves the defect alive on that path.
2. **Which grants are revoked — and how do you know they were the elevated ones?** ⛔ This is the
   trap. A manager may hold `manage_users` because it was **hand-granted** (bible row 116's
   explicit-tick path, `elevateManager`) rather than auto-elevated. Revoking that would be a
   silent, unrequested demotion of a deliberate decision. Say how the two are told apart at
   revocation time, using what the rows already record — and if they cannot be told apart today,
   that is a **BLOCKED** finding worth more than a guess.
3. **What does the revocation record?** T-239 established that a revocation says *why*
   (`revoke_reason`). This one has a good reason available: name it.
4. **Idempotence and ordering.** Two administrators arriving in the same transaction, an
   arrival in an organisation with no elevated managers, an arrival that is itself immediately
   revoked.
5. **The mid-shift cost Ian accepted** (row 188): the capability disappears the instant the write
   commits. Do not soften it with a grace period — that would be a different decision. Do state in
   the spec what a manager mid-action actually sees.

## Migration

**None expected** — row 188 records this as a write path against `person_grants`, which already
exists. If your spec concludes otherwise, say so as a QUESTION before building; the migration slot
is allocated per cycle by the orchestrator, not by the lane.

## Required reading

- **`PROJECT_BIBLE.md` §13 row 188** (Ian's decision), then **row 115** (why grants are settled at
  a moment, never re-derived) and **row 116** (the explicit-tick path that must survive this)
- `docs/DEFECTS-REGISTER.md` DEF-237
- `docs/tasks/244-def-237-has-active-admin-super-admin.md` §6 — your own options write-up, which is
  what Ian ruled on
- `docs/RULES.md`, `PROJECT_BIBLE.md` §3.3 (spec format) and §9 (definition of done)

# T-322 — the two legacy constraint names come out of the collision catch

> ### **Status: SPEC — written 2026-09-17 by `system32-85` (Opus planner). NOT BUILT. Reserves T-322. ⛔ BLOCKED ON A MECHANICAL TRIGGER, see below — do not start it early.**
>
> ⭐ **This task exists because a code comment is not a trigger.** T-321 release N left two legacy
> constraint names in `SCAN_VALUE_UNIQUE_CONSTRAINTS` with a comment saying they are *"a TRANSITION,
> not a permanent feature — remove them once every environment is confirmed past 0153, so they do
> not become cruft nobody dares delete."* **The comment names its own failure mode and then provides
> nothing to prevent it.** Found by the auditor on T-321's release-N review, 2026-09-17.
>
> ⚠️ **And the comment is read by the wrong person.** Whoever next edits `credentials.ts` sees it;
> whoever deploys `0153` does not. This file is the half that the deployer can act on.

## Why this exists

`packages/domain/src/attendance/credentials.ts` matches a uniqueness violation by Postgres error
code `23505` plus `constraint_name` against a set of three:

```ts
ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE,   // the name 0153 creates
'attendance_credentials_card_live_unique',        // legacy, pre-0153
'attendance_credentials_token_live_unique',       // legacy, pre-0153
```

The two legacy names exist **only** to keep the catch working in the window where code and schema
disagree — an unmigrated developer machine, or an app rolled back onto a release built before
`0153` while the database has already moved past it (`deploy.yml` keeps the last three releases
precisely so that rollback is possible). ⛔ **Once no such environment can exist, they are dead
weight that quietly widens what the catch will claim as a credential collision.**

## ⛔ The trigger — mechanical, binary, and NOT a date

**Start this task only when `0153` is confirmed applied in production.** That is observable, not a
judgement call:

```sql
select 1 from drizzle.__drizzle_migrations where created_at = 1799292707084;
```

⚠️ **`1799292707084` is `0153`'s journal `when`** — re-derive it from
`packages/db/migrations/meta/_journal.json` at the time rather than trusting this line (DEF-039).

⛔ **AND ONE MORE CONDITION, which is the one people will skip:** every release still reachable by
a rollback must already contain the tolerant catch. `deploy.yml:157` keeps the last **three**
releases, so the condition is that `0153`'s release plus the two before it all carry it. **Release N
is what makes that true** — it is the release that put the tolerance in ahead of the migration. In
practice: wait until at least three deploys have happened since release N.

## Scope

- `packages/domain/src/attendance/credentials.ts` — remove the two legacy literals from
  `SCAN_VALUE_UNIQUE_CONSTRAINTS` and the transition comment above it.
- The unit test pinning the matcher — it hard-codes the two legacy names deliberately, so it must
  change in the same commit or it fails. ⭐ **That coupling is intentional**: the test is what stops
  the names being deleted by accident, so deleting them *on purpose* should have to touch it.

## ⛔ Before you decide the legacy names are unused — the coverage inverts at `0153`

**The obvious check gives the wrong answer.** Grep for the two legacy names and you will find them
exercised by real-database tests — `packages/domain/tests/integration/attendance-credentials.test.ts`
(the card name) and `…-fingerprint-token-collision.test.ts` (the token name). ⚠️ **That was only
true BEFORE `0153`.** Once both indexes are dropped, those same tests raise the **new** name, and
**no integration test exercises either legacy name against a real database at all** — they cannot,
because you cannot make a dropped index raise.

⭐ So at the moment you run this task, the honest answer to *"what proves these two names are still
needed?"* is: **nothing at the integration level — only the hand-built error shapes in the matcher's
unit test, plus the rollback argument in the trigger above.** ⛔ **Do not read that absence as
evidence they are unused.** It is the expected state, and it is exactly the reasoning that would
lead someone to delete them one release too early.

## Out of scope

- The new constant, the index, `resolveScan`, and anything in `0153`.
- Widening the match to bare `23505`. ⛔ Deliberately named: the constraint name is what stops an
  unrelated future unique constraint on this table inheriting a credential-specific message.

## Done when

- The set holds exactly one name, taken from `ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE`.
- The matcher unit test still passes, updated in the same commit, and still asserts the negative
  cases (wrong code, wrong constraint name, non-object).
- Integration tests pass against a **migrated** database. ⚠️ Any test that relied on a pre-0153
  database to exercise a legacy name is now testing a state that cannot occur — retire it rather
  than leaving it green against a fiction.

## Needs from Ian

**Nothing** — but he is the one who knows when production has had three deploys since release N, so
whoever picks this up should confirm the trigger with him rather than inferring it from the
repository alone.

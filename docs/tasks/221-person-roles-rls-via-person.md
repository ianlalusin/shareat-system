# T-221 — `person_roles` RLS: the `via_person` form (DEF-183)

> **Status**: specced 2026-09-06. Closes **DEF-183**'s open half. Small, schema-only, no UI.
> Picked up because DEF-183's register row and `docs/HANDOFF-TODAY.md` both say the same
> thing: *"the proper fix is a migration"*, and *"the next access migration is its home."*
> This task exists to be that home.

## Why this exists

`person_roles` is one of three access tables created together in migration `0014`. Two of
them (`person_store_scope`, `person_grants`) carry no `org_id`, so their RLS policies derive
the org **through the person the row names**:

```sql
EXISTS (SELECT 1 FROM persons p WHERE p.id = <table>.person_id AND p.org_id = app_current_org())
```

`person_roles` carries its **own** `org_id`, so its policy asks a different question:

```sql
org_id = app_current_org()
```

Both end in `= app_current_org()` and read as equivalent. **They are not.** The first asks
*"does this row's subject belong to my org?"*; the second asks *"is this row labelled with my
org?"* — and a row labelled with **my** org while naming **another org's** person satisfies the
second perfectly. The FK to `persons` is satisfied too, because that person genuinely exists.

That was **proved**, not reasoned: a T-219 test written to expect a refusal reported *"promise
resolved instead of rejecting."* T-219 closed it **at the call site** (`assignRoleAsActor`), which
is a real fix for the one caller that exists. RULES §6.3 asks for more: *"the database enforces
the rules, not the service layer."* A second caller — the ETL, a script, a fix at 11pm — meets no
guard at all today.

## ⭐ What I checked before writing this, and one thing it turned up

The registry's stated reason for `person_roles` being `org_column` is:

> *"Carries org_id directly (a person can hold different roles in different orgs, e.g. Ian
> holding several franchises' admin — bible row 114 A.4)."*

**If that were reachable, this task would be wrong** — the `via_person` clause forbids exactly
that row. So it was checked rather than assumed, and it is **not reachable**:

| Checked | Finding |
|---|---|
| `packages/db/schema/sessions.ts` | **No `org_id` column.** A session does not carry an org of its own |
| `sessionsRepo.findLiveByTokenHash` | Selects `orgId: persons.orgId` — the session's org **is** the person's home org, by construction |
| Org switcher anywhere in `packages/` / `apps/` | **None exists.** `currentOrgId` in the report pages is a display prop |
| `authorize()` axis 3a | `activeRoleForPerson(tx, actor.personId, actor.orgId)` — and `actor.orgId` can only ever be `persons.org_id` |

So a `person_roles` row whose `org_id` differs from its person's org **can never be read by
anybody**: `authorize()` looks the role up under the person's own org, where it does not exist.
It is dead data with zero readers, which is exactly why DEF-183's severity is limited.

⚠️ **This makes the registry's reason a claim with nothing executable behind it** — yesterday's
named shape (DEF-175/176/180/182), in the one file whose job is to be believed about isolation.
Filed as **DEF-187**. This task corrects the sentence; it does not build the org switcher.

## Goal

The database refuses a cross-org role assignment, in the same shape as the two sibling tables,
so that the rule survives a second caller — and so that a **fourth** access table cannot
re-create the hole by copying the weaker policy.

## Scope — files this task may create or modify

| File | Change |
|---|---|
| `packages/db/migrations/0129_def183_person_roles_via_person.sql` | **new** — the policy replacement |
| `packages/db/migrations/meta/_journal.json` | **new entry** — idx 129, `when` 1797219107084 |
| `packages/db/src/rls/registry.ts` | `person_roles` entry: corrected reason + `personKeyedAccess` marker; `RlsEntry` gains the optional field |
| `packages/db/tests/integration/rls.test.ts` | new `describe` — DEF-183 refusal tests + the fourth-table guard |
| `docs/DEFECTS-REGISTER.md` | DEF-183 row → closed at the DB; **new DEF-187** |
| `docs/tasks/221-*.md` | this file |

⛔ **Out of scope, deliberately**: `packages/auth/src/roles.ts`. T-219's call-site check stays.
Two guards for one rule is correct here — the DB one is the control, the call-site one produces
a *good error message* instead of a bare 42501 in front of a user.

## Contract

### 1. The policy — both conjuncts, in both clauses

```sql
DROP POLICY "person_roles_org_isolation" ON "person_roles";
CREATE POLICY "person_roles_via_person" ON "person_roles" FOR ALL
  USING (
    "org_id" = app_current_org()
    AND EXISTS (SELECT 1 FROM "persons" p
                WHERE p."id" = "person_roles"."person_id" AND p."org_id" = app_current_org())
  )
  WITH CHECK ( ...the same expression... );
```

**Why both conjuncts, rather than replacing the `org_id` check with the `EXISTS`:**

- Dropping `org_id = app_current_org()` would admit the *mirror* row — my own org's person, given
  a role in **another** org. That is worse than the bug being fixed: it is a privilege grant
  pointing out of the tenant, not a dead row.
- Keeping both makes the two questions *both* answered: the row is labelled with my org **and**
  its subject belongs to my org. For this table those are independent facts.

**Why `USING` too, and not only `WITH CHECK`** (the handoff names `WITH CHECK` alone): a policy
whose `USING` is weaker leaves an already-written bad row readable and updatable by the org that
labelled it. More importantly, the sibling policies use the **same expression in both clauses**,
and the register's ⛔ hazard is precisely that someone copies a policy shape without reading it.
Four policies that are literally the same shape is the cure; three-plus-one-that-is-nearly-the-same
is the disease. The policy is **renamed** to `person_roles_via_person` for the same reason — the
name now states the form, and a reader comparing the four sees four matching names.

### 2. The migration fails loudly if a violating row already exists

Installing a stricter `USING` makes any pre-existing violating row invisible to the app role —
which would hide evidence rather than surface it. The migration therefore counts them first and
`RAISE EXCEPTION`s with the count if any exist.

Expected count is **zero** in every environment: v2 migrated no history, `assignRole` had no
callers before T-219, and `scripts/dev-seed.ts` inserts the person and its role under the same
`org.id` (checked). This is a guard against being wrong about that, not an expected branch —
and blocking beats a silent drop, the same call DEF-059 and T-122 invariant 7 both made.

### 3. The fourth-table guard — the generalisable half

A comment does not stop the hazard the register names. The guard enumerates, from the schema
itself, **every table defined in `packages/db/schema/access.ts` that has a `person_id` column**,
and asserts each one's live policy contains the person-org `EXISTS` in **both** `qual` and
`with_check`, read from `pg_policies`. A fourth access table added to that file is covered the
day it is added, with no one having to remember this rule.

⚠️ **Stated honestly**: this covers a fourth access table added to `access.ts`. One added to a
*different* schema file is not caught — the `personKeyedAccess` marker on the registry entry is
what carries the rule there, and a marker can be forgotten. This is a narrowing of the hazard,
not its elimination, and it should be described that way in the register.

The guard needs a **floor assertion** (it must find at least the three known tables) — a guard
that enumerates nothing passes vacuously, which is the one failure mode a coverage guard may not
have. Same reasoning as `tests/unit/rls-registry.test.ts`'s own floor test.

## Invariants

1. Under org A's principal, inserting `person_roles (person_id = <org B's person>, org_id = <org A>)`
   is **refused** — `42501`, not a silent success.
2. The mirror is refused too: `(person_id = <org A's person>, org_id = <org B>)`.
3. The legitimate row — person and `org_id` both org A — still inserts, and still reads back.
4. T-121 invariant 13 still holds: org A reads only its own role rows (the existing tests stay green).
5. Every person-keyed table in `access.ts` has the `EXISTS` clause in both `qual` and `with_check`.
6. The enumeration in 5 finds at least 3 tables.
7. The system principal (superuser) still sees every org's rows — the migrator and audit must not break.

## Tests

`packages/db/tests/integration/rls.test.ts`, one new `describe`, reusing the file's existing
two-org fixture (`orgA` / `orgB`, `alice` in A, `bob` in B) and its `asOrg()` helper.

Each refusal test asserts the **SQLSTATE is `42501`**, not merely that a promise rejected — a
constraint violation, a typo'd column and a policy denial all reject, and only one of them is
this feature working. (DEF-077's own test in this file makes the same distinction.)

⭐ **Every test is watched fail first, against the pre-migration policy**, and the failure must be
*"resolved instead of rejecting"* — the same signature that found DEF-183. A test that only ever
passed proves nothing (RULES §3.2).

## Out of scope — with reasons

| Not doing | Why |
|---|---|
| A composite FK `(person_id, org_id) → persons (id, org_id)` | **Strictly stronger** than RLS — it binds `postgres`, the ETL and every script, which RLS does not. But it needs a new unique index on `persons`, and it hard-forecloses the multi-org model at the *data* level rather than the session level. That is Ian's call, not a HOW decision. **Raised as an open question, with a recommendation** |
| Building the org switcher / multi-org sessions | Bible row 114's franchise-admin story. Not this task; see Open questions |
| Changing `authorize()` or `roles.ts` | T-219's guard is correct and stays |
| Retrofitting the other RLS policies | Only the access tables are in DEF-183's claim |

## Open questions — for Ian

1. ⭐ **Which model does "Ian holds a franchise's org-admin" (bible row 114) take?**
   **(A)** one person row per org — roles always match the person's org, this migration is right
   forever; or **(B)** one person, roles in several orgs, reached through an org switcher — in
   which case this migration must be reverted when the switcher is built. **Recommendation: (A).**
   It is what the running system already does, it is what T-219 chose at the call site, and (B)
   needs four other changes (a session org column, the switcher, `findLiveByTokenHash`,
   `authorize` axis 1) of which the RLS policy is the smallest and cheapest to redo.
2. **Should the composite FK be added on top?** It would make the invariant hold for `postgres`
   and the ETL too, not only for app sessions. **Recommendation: yes, but as its own task**, and
   only once (1) is answered — under (B) it is wrong.

## Done when

typecheck clean · the new tests watched fail first, then pass · `npm run test:integration` green
on an isolated lane DB · `npm run build` exit 0 with the dev server stopped · registry reason
corrected · DEF-183 row updated and DEF-187 filed · self-reviewed line by line · committed with a
message saying *why* · **`FOR IAN` block naming the two open questions above.**

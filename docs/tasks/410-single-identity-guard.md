# T-410: Guard test: one person, one id, behind every credential

**Status:** **DONE 2026-10-16, merged a879264 (PR #28).** | Earlier: SPEC DRAFT 2026-10-15 (Opus planner). Not built. **No migration.** ≈0.75 lane-day, two slices.
**Haiku lane** (tests only, every rule and list is written below; no production code changes). One question for Ian.

## Goal

Ian's ruling (row 322): one human is one account. The app sign-in (PIN, email) and the clock (card, fingerprint) all
lead back to the same `persons.id`. v2 already works this way. This task adds the tests that keep it so: the build
goes red the day someone adds a second "users" or "accounts" table, or a credential that does not lead to a person.

## Source

- Worklist `docs/plans/2026-10-14-ian-answers-worklist.md` #8; bible §13 row 322 (and row 165, §7.1); review item 5a.
- Code read 2026-10-15: `packages/db/schema/persons.ts` (`persons`, `person_identities.person_id` → `persons.id`);
  `packages/db/schema/sessions.ts` (`person_credentials.person_id` → `persons.id`, kinds `pin | firebase | biometric`;
  `sessions.person_id` → `persons.id`, `sessions.credential_id` → `person_credentials.id`);
  `packages/db/schema/attendance-credentials.ts` (`employment_id` → `employments.id`, whose `person_id` → `persons.id`;
  kept a separate table so a terminal mirror never carries a PIN verifier, migration 0085);
  `packages/db/schema/clock-terminals.ts` (`firebase_uid` of a **device**, not a human).
  Enumeration pattern to copy: `packages/db/tests/integration/rls.test.ts:394-410` (`is(value, PgTable)` loop).
- **T-391 confirmed by reading, not assumed:** `packages/etl/src/master-data/snapshot.ts:152-224` reads only `stores`,
  `stores/*/items|suppliers|arCustomers|staff` and `staffIdentities`; it never reads v1's `users` or local-user
  records, so v1's two account ids never arrive. `packages/etl/src/master-data/staff-plan.ts:226-283` turns a
  `staffIdentities` group into ONE human (`Human.ref = group id`), and same-name records across stores go to the
  `staff-same-person` sheet for a person to answer. Already proven by
  `packages/domain/tests/integration/t391-s5-staff-apply.test.ts:400` (a group is one person with an employment per
  store) and `:443` (no `person_credentials`, `attendance_credentials` or `person_identities` row is imported).

## Research (row 283)

**v1's method.** Two account records per worker: a local user (PIN, `accountId`) and a Firebase sign-in user, linked by
hand; plus `staffIdentities` groups to say two store staff records are one human.
**v1's goal.** Know who did what, whichever door they came in by.
**Where v1 misses it.** The ids differ, so "who" depends on which door, and the link can be missing.
**v2 design that beats it.** Already built: one `persons.id`, every credential keyed to it. What is missing is a guard;
a rule that lives only in a bible row is broken the first time a feature (diner accounts, OCR users, a POS v2 login)
needs "a user table" and nobody remembers row 322.

## Rulings (planner)

- **R1. The identity allowlist** (a constant in the test, each entry with its one-line reason):
  `persons` (the spine) · `person_identities` · `person_credentials` · `sessions` · `attendance_credentials` ·
  `clock_terminals` (a device principal; its `provisioned_by` is a person).
- **R2. What counts as identity-like** (any one triggers): table name matches
  `/(^|_)(users?|logins?|identit(y|ies)|credentials?|principals?|members?|auth)(_|$)/`; or a column named one of
  `external_id, firebase_uid, uid, password, password_hash, pin_hash, secret_hash, lookup_hash, token_hash, match_token,
  verifier`. GL `accounts` and `money_accounts` do not match (no `users?`/`auth` token) and need no exemption.
  A non-identity table that matches gets an entry in a second constant, `NOT_IDENTITY`, with a reason; today that set is
  expected to be empty, and the tester stops and reports if it is not.
- **R3. Every allowlisted credential table resolves to `persons.id`** in at most one hop: a NOT NULL FK straight to
  `persons.id`, or to `employments.id` (whose `person_id` is a NOT NULL FK to `persons.id`). `persons` itself is the
  target; `clock_terminals` is exempt from R3 (a device), named as such.
- **R4. Two halves, because migrations are hand-authored (ADR-012):** a unit half over the Drizzle schema, and an
  integration half over the migrated database (`information_schema.columns` + `pg_constraint`), so a table that exists
  only in SQL is caught too.
- **R5. The failure message is the rule.** On a new match: *"<table> looks like a second identity table. Bible row 322:
  one person, one id. Key it to persons.id and add it to the allowlist with a reason, or add it to NOT_IDENTITY with a
  reason."*
- **R6. T-391 read set is pinned.** A small ETL test asserts the master-data snapshot reads exactly the collections
  listed above, so adding v1 `users` to the load fails a test and someone decides on purpose.

## Invariants (each with a named mutant; the tester shows each red once by a temporary edit, then reverts)

1. Every table in R1 exists and resolves per R3. *Mutant: R3's one-hop rule changed to accept any FK target (a
   fixture credential table keyed to `stores.id` then passes) → red once restored.*
2. No table outside R1 and `NOT_IDENTITY` matches R2. *Mutant: a throwaway `pgTable('app_users', …)` defined inside
   the test file and passed to the checker → red with the R5 sentence.*
3. Same as 2 on the live DB. *Mutant: `create table app_users(id uuid)` inside the test's own transaction, rolled
   back → red.*
4. An allowlisted credential table whose FK is nullable fails R3. *Mutant: checker run on a fixture table with a
   nullable `person_id` → red.*
5. The master-data snapshot read set equals the pinned list. *Mutant: fake client records an extra `users` read → red.*

The checker is a pure function `identityViolations(tables)` inside the test file, so mutants 2 and 4 feed it fixture
tables without touching the real schema.

## Slices

| Slice | What | TESTER writes | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Schema half + DB half (R1-R5) | `packages/db/tests/unit/t410-single-identity.test.ts`; `packages/db/tests/integration/t410-single-identity-db.test.ts` | none (tests only; if a test finds a real violation, stop and report, do not fix) | 0.5 |
| **S2** | T-391 read set pinned (R6) | `packages/etl/tests/t410-v1-read-set.test.ts` (reuse the fake client shape from `t391-s2-extract.test.ts`) | none | 0.25 |

Tests are expected green on first run (the property already holds); each mutant must be shown red in the lane log.

## Out of scope

- Letting the same fingerprint/card open the app (review 5a's additive option; needs ADR-015 O5 and its own spec).
- Any change to credential tables, sign-in, or the T-391 load.
- Diner (customer app) identity: when it lands it must be a `persons` row plus `person_identities`; this guard is what
  will enforce that (row 331 / worklist #23).

## Done when

S1-S2 merged; invariants 1-5 green, each mutant shown red once; unit and the db + etl integration suites green.
The orchestrator adds one line under row 322's consequences in the bible ("guarded by T-410"), as the planner.

## Risks

- **False positives** from R2's name pattern on a future harmless table: handled by `NOT_IDENTITY` with a reason,
  which is the point (a person must decide).
- **The DB half needs a migrated lane database**; it runs in the integration suite, not unit.

## Questions for Ian (the recommended option is built)

- **Q1. When the customer app gets its own sign-in, should diners be people in the same list as staff?**
  (a) Yes: a diner is a `persons` row (marked as a diner), so one human who is both staff and a diner is one account.
  (b) No: a separate diner-accounts table (this guard would then need an exception). **Recommended (a)**: it keeps
  row 322 true everywhere and makes worklist #23 (linking a customer to a diner) simpler.

# T-355: new tables are born read + insert only for the app role (DEF-489)

**Status:** DONE 2026-09-29 — APPROVED 2026-09-29 (orchestrator, after an independent Opus spec audit; amendments S1–S4 at the end bind — R3 is SPLIT OUT, not built). **Model:** Sonnet, tester then builder.
**Migration:** `0169_t355_def489_default_privileges_read_insert.sql`. The journal entry is idx 169, `when` =
1800675107084 (0168's `1800588707084` + 86_400_000).
**Why now:** Ian, 2026-09-29 (bible §13 row 242): *"DEF-489 go with (a), fix before launch"*.
**Runs after** T-354 (0168). It touches no domain or app code. Line numbers were checked at HEAD `a47e0a7`.

## Why
DEF-489 (`docs/DEFECTS-REGISTER.md`, the DEF-489 row):
- `packages/db/migrations/0011_row_level_security.sql:72` is a standing default:
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "shareat_app"`.
  Every table created since has been born with app-role UPDATE and DELETE. That is how `audit_log` got the grant
  0168 had to revoke (`0168:75`).
- T-354's guards are keyed on live triggers. A new history table shipped with no trigger and no REVOKE is invisible to
  every guard, and §15.11 (no layer may be the only one) is then met by RLS alone.
- Option (a), ruled by Ian: narrow the default to SELECT + INSERT. A table that needs UPDATE/DELETE gets an explicit
  grant. It fails closed: a forgotten grant is a loud 42501 in the integration suite, because the harness runs as
  `shareat_test_runner`, a member of `shareat_app` (`tests/integration/setup.ts:85-90`).

## Rulings (planner, 2026-09-29)

- **R1: default privileges belong to a grantor, so 0169 must run as 0011's grantor, and it proves that it does.**
  - `ALTER DEFAULT PRIVILEGES` without `FOR ROLE` changes only the entry of `current_user`. It affects only objects
    that `current_user` later creates. A REVOKE run by any other role is a silent no-op.
  - Measured: every migration runs as one role per environment, and that role owns every table.
    - Locally and in CI it is `postgres` (`.github/workflows/ci.yml:124`).
    - In production it is `doadmin`. `deploy.yml:150` runs `db:migrate` with `SYSTEM_DATABASE_URL`, and
      `docs/ops/README.md:43` records that `doadmin` ran 0011.
    - Nothing in the tree changes a table's owner (grep `OWNER TO`: zero hits).
  - So 0169 uses plain `ALTER DEFAULT PRIVILEGES` with no `FOR ROLE`. Naming a role would hard-code one environment.
  - It ends with a **DO-block post-assertion** that raises when either of these holds:
    - (i) any `pg_default_acl` row, from any grantor and in any namespace (global `0` included), with
      `defaclobjtype = 'r'`, still gives `shareat_app` a privilege other than SELECT or INSERT;
    - (ii) `current_user` has no `public`/`'r'` row that gives `shareat_app` both SELECT and INSERT. That row is
      missing when the migrator is not 0011's grantor.
  - A mismatch therefore fails the deploy loudly, and the migrator's transaction rolls the migration back. It never
    passes in silence.
  - Use `aclexplode(defaclacl)` and `'shareat_app'::regrole`. The assertion reads a catalog, not an RLS table, so
    T-354 R6's blind-pre-flight lesson does not apply.
- **R2: the sequences default is a separate row and stays as it is.** 0011 has **no** sequences default. `:70` is a
  one-off grant on the sequences that existed then. The default is `0088_t181_mirror_outbox.sql:160`
  (`USAGE, SELECT ON SEQUENCES`), added for DEF-089, and 0169 does not touch it. USAGE covers `nextval`, so a new
  `serial` table still inserts.
- **R3: existing tables keep their grants, except six that are append-only by trigger.**
  - Narrowing a default never touches existing objects. 0011:68 and the old default already granted SIUD to every
    table that exists today, and `audit_log` is SELECT + INSERT since 0168.
  - The candidates were the 15 tables behind T-354's 18 ALWAYS triggers (`packages/db/src/triggers/registry.ts:44-165`).
  - For **seven** of them, the trigger refuses app-level UPDATE and/or DELETE unconditionally, whatever the row's
    state. T-354 R4's reasoning applies to these unchanged: a privilege lock gives a loud 42501 at the statement, it
    is a third lock (privilege, then RLS, then trigger), and it satisfies §15.11. `audit_log` is already done.
    **0169 revokes the other six:**

    | Table | Revoke | Why this is safe (measured) |
    |---|---|---|
    | stock_movements | UPDATE, DELETE | The trigger refuses both on every row (`0063:90-99`). No app UPDATE or DELETE exists (grep of repo/domain). |
    | trade_order_messages | UPDATE, DELETE | Refused on every row (`0072:69-79`). No app UPDATE or DELETE. |
    | attendance_punches | UPDATE, DELETE | Refused on every row (`0082:143-153`). A correction is a new punch. |
    | etl_source_documents | UPDATE, DELETE | Refused on every row (`0009:33-46`). ETL lands through `systemTransaction` (owner) with `onConflictDoNothing` (`repo/etl.ts:205`), which needs no UPDATE. |
    | missed_month_adjustments | UPDATE, DELETE | UPDATE is refused on every row (`0161:188-197`). A direct DELETE is refused, and only the FK cascade may remove a row (`0161:199-211`). Postgres runs RI cascades as the **referencing table's owner**, so the app role's DELETE privilege is never consulted. Leg C1 proves this. |
    | attendance_adjustments | DELETE only | `repo/attendance-adjustments.ts:108-114` (`markSuperseded`) is a legitimate app UPDATE that the trigger permits. DELETE is always refused. |

  - The other nine (`journal_entries`, `journal_lines`, `stock_usage_records`, `count_sessions`, `trade_discrepancies`,
    `store_attendance_config`, `attendance_days`, `fiscal_periods`, plus `audit_log` already done) guard **state
    transitions**. The app legitimately UPDATEs or DELETEs draft or open rows there, so they keep both.
  - Every existing test that asserts one of these triggers' messages uses the admin `TEST_DATABASE_URL` connection,
    not the app role. The REVOKE does not change them. Checked:
    - `stock-ledger.test.ts:23,151-158`
    - `attendance-punches.test.ts:31,106-112`
    - `attendance-adjustments.test.ts:38,170-173`
    - `low-stock.test.ts:21,339-340`
    - `t345-missed-month.test.ts:61,1176-1225`
    - `etl-run.test.ts:33,556-566`
- **R4: the checklist gains one step, in two places.** It goes in ADR-012 §5 (the authority) and in
  `packages/db/migrations/README.md`'s short form (which mirrors it). Wording is in BUILDER item 3.
  `onConflictDoUpdate` needs UPDATE too, and the step says so.
- **R5: what guards against a re-widening.** Three layers:
  - The live leg D3 reads `pg_default_acl` after every CI migrate-from-zero.
  - The static leg G1 fails on any migration numbered 0169 or later whose text grants UPDATE, DELETE or ALL
    `ON TABLES` through default privileges.
  - 0169's own post-assertion stops the deploy that would apply a bad migration in the same run.
  - No registry marker is needed. The snapshot fixture (E1) is the record of which old tables have which privileges.

## BUILDER items

1. **The migration.** New file `packages/db/migrations/0169_t355_def489_default_privileges_read_insert.sql`, per ADR-012 §5.
   - **Header:** DEF-489, bible row 242, and Ian's quote. Then these points:
     - Default privileges are per grantor (R1).
     - Environments and roles: postgres in CI and locally, doadmin in production.
     - Existing tables are untouched except R3's six.
     - The sequences default at 0088:160 is unchanged (R2).
     - From now on, every new table that the app mutates needs an explicit `GRANT UPDATE[, DELETE]` in its own
       migration.
   - **Body, in this order:**
     - `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE UPDATE, DELETE ON TABLES FROM "shareat_app";--> statement-breakpoint`
     - The six REVOKEs in R3's table order (`REVOKE UPDATE, DELETE ON "<t>" FROM "shareat_app";`, and
       `REVOKE DELETE` for `attendance_adjustments`), each ending `--> statement-breakpoint`.
     - Last, the R1 post-assertion as one `DO $$ … $$;` with no trailing breakpoint. Each RAISE message names DEF-489
       and says what to check: *"the migrating role must be the role that ran 0011; see docs/ops/README.md"*.
   - No data changes.
2. **Journal.** `packages/db/migrations/meta/_journal.json`: append
   `{ "idx": 169, "version": "7", "when": 1800675107084, "tag": "0169_t355_def489_default_privileges_read_insert", "breakpoints": true }`.
3. **Checklist.** Two edits, same wording:
   - `docs/decisions/ADR-012-hand-authored-migrations.md` §5: insert after step 4 (`:145-148`), as sub-step
     **4a**, so the existing numbers stay put.
   - `packages/db/migrations/README.md`: after step 4 (`:38-41`).
   - The wording: *"**Grant what the app mutates.** A new table is born SELECT + INSERT for `shareat_app` (0169,
     DEF-489). If the app UPDATEs, DELETEs, or upserts (`onConflictDoUpdate`) it, add
     `GRANT UPDATE[, DELETE] ON "<t>" TO "shareat_app"` in the same migration. An append-only table gets neither.
     A forgotten grant is a 42501 in the integration suite, which runs as a member of `shareat_app`. Never
     re-widen the default: T-355's G1 and D3 go red."*
4. **Stale comment.** `scripts/provision-test-role.mjs:18-22` says future tables inherit "the same grants". Change it
   to: future tables inherit SELECT + INSERT only (0169); UPDATE/DELETE are granted per table. This is a comment
   only, with no code change.
5. **RLS registry reasons.** `packages/db/src/rls/registry.ts`: append one sentence to the `reason` of each of the six
   R3 tables (`:101`, `:168`, `:568`, `:791`, `:810`, `:854`). The sentence has the same shape as `audit_log`'s at
   `:302`: *"UPDATE[/DELETE] also REVOKEd from the app role (0169, T-355), so an attempt is a loud 42501."*
6. **Ops note.** `docs/ops/README.md`: add a section, "Default privileges (T-355)", with three bullets:
   - The migrator must be the role that ran 0011 (doadmin in production).
   - If 0169's assertion fires on deploy, nothing was applied. Read `select defaclrole::regrole, defaclobjtype,
     defaclacl from pg_default_acl` as the admin role, and bring it to Ian.
   - Never add UPDATE/DELETE back to the default.

**BUILDER paths:** `packages/db/migrations/0169_t355_def489_default_privileges_read_insert.sql` (new),
`packages/db/migrations/meta/_journal.json`, `docs/decisions/ADR-012-hand-authored-migrations.md`,
`packages/db/migrations/README.md`, `scripts/provision-test-role.mjs` (comment only), `packages/db/src/rls/registry.ts`
(reasons only), `docs/ops/README.md`.
⛔ Not any applied migration (0011 and 0088 included), not the register or the bible, and no test or fixture file.

## TESTER paths
- **New file.** `packages/db/tests/integration/t355-default-privileges.test.ts` holds D1-D3, N1-N3, E1-E2, V1-V3
  and C1.
  - Real Postgres through `TEST_DATABASE_URL`, with the `_test` name guard (`t354-immutability-triggers-always.test.ts:26`).
  - Import `APP_ROLE` from `../../src/rls/registry`, and copy the `asOrg` helper (`t354…test.ts:253`).
  - The **migrating role** is `select tableowner from pg_tables where schemaname='public' and tablename='journal_entries'`.
  - N1-N3 and C1 run inside `sql.begin`. They `SET LOCAL ROLE <migrating role>` before any DDL. They check each target
    under `tx.savepoint`, so they never hit 25P02, and they roll back by throwing a sentinel.
  - ⛔ If the connection cannot `SET ROLE` to the migrating role, the file **fails** with a sentence. It never skips.
- **New fixture.** `packages/db/tests/fixtures/t355-pre-0169-app-privileges.json`.
  - Generate it **before the builder runs**, from the live test database at 0168.
  - One entry per `public` relation with `relkind in ('r','p','v','m')`. Each entry is the sorted list of
    `has_table_privilege('shareat_app', rel, p)` that are true, for p in SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
    REFERENCES and TRIGGER.
  - Record in the TESTER report: the entry count, and the proof that every entry is exactly
    `[DELETE, INSERT, SELECT, UPDATE]` except `audit_log` (`[INSERT, SELECT]`). If any other table differs, **stop
    and report it**. That would be an existing finding.
- **New unit test.** `packages/db/tests/t355-default-privileges-static.test.ts` holds G1. It reads the files only and
  needs no database.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| D1 | `pg_default_acl` rows granting `shareat_app` with `defaclobjtype='r'` | Exactly one row, `defaclrole` = the migrating role, namespace `public`, privileges exactly {SELECT, INSERT} | The same row holds {SELECT, INSERT, UPDATE, DELETE} |
| D2 | The sequences default (0088:160) | One `'S'` row, the same grantor, privileges {USAGE, SELECT} | Green (guard: R2) |
| D3 | Re-widen guard, any grantor, any namespace (global `0` included), `'r'` | No row gives `shareat_app` UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER. Positive control: in a rolled-back tx, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO shareat_app` makes the same query return ≥1 row | The 0011 row matches (UPDATE, DELETE) |
| N1 | A table created by the migrating role (`create table t355_probe(id int primary key, v int)`) | `has_table_privilege` for `shareat_app` is true for SELECT and INSERT, false for UPDATE and DELETE | UPDATE and DELETE are true |
| N2 | As `shareat_app` on the probe | INSERT succeeds. UPDATE and DELETE each reject with `code === '42501'` | UPDATE and DELETE succeed (`count 1`) |
| N3 | Positive control: as the migrating role, `GRANT UPDATE, DELETE ON t355_probe TO shareat_app`, then as `shareat_app` | UPDATE and DELETE each `count 1` | Green (proves N2 is the grant, not something else) |
| E1 | Snapshot compare, every fixture relation | Live privileges = the fixture's, deep-equal, for EVERY table — no exceptions (S1: R3 is not built here; T-356 later amends this leg to an exact delta map) | The six ruled tables still hold the revoked privileges |
| E2 | The fixture is not vacuous | Its count = the count recorded in the TESTER report, and ≥ 127. Every fixture name exists live | Red until the fixture exists (the file is absent). Then green |
| V1 | `has_table_privilege` on R3's six | stock_movements, trade_order_messages, attendance_punches, etl_source_documents and missed_month_adjustments: SELECT and INSERT true, UPDATE and DELETE false. attendance_adjustments: SELECT, INSERT and UPDATE true, DELETE false | All true |
| V2 | App role (`asOrg`, own org, a real seeded row) UPDATE, then DELETE, of a `stock_movements` row and of an `attendance_punches` row | Each rejects with `code === '42501'`. Positive control: the admin `sql` UPDATE of the same row still raises the trigger's own message (`/append-only/`) | The trigger error (P0001 / 23001), not 42501 |
| V3 | App role on `attendance_adjustments` | DELETE rejects `42501`. An UPDATE of `superseded_by_adjustment_id` alone (the `markSuperseded` shape) succeeds | DELETE raises the trigger's 23001. UPDATE is green (guard) |
| C1 | RI cascade runs as the owner (the property R3 relies on for missed_month_adjustments) | In a rolled-back tx, as the migrating role: create `t355_parent(id int pk)` and `t355_child(id int pk, p int references t355_parent on delete cascade)`. Grant `shareat_app` SELECT and DELETE on the parent, REVOKE DELETE on the child, and seed one of each. As `shareat_app`, DELETE the parent: `count 1`, and the child row is gone | Green (a Postgres property; a guard) |
| G1 | Static: every `packages/db/migrations/NNNN_*.sql` with NNNN ≥ 0169 | No match for `/ALTER\s+DEFAULT\s+PRIVILEGES[^;]*\bGRANT\b[^;]*\b(UPDATE\|DELETE\|ALL)\b[^;]*\bON\s+TABLES\b/i` after SQL comments are stripped. Positive control: the same matcher on `0011_row_level_security.sql` returns ≥1 match | The file is absent. Once it exists, it is green (no file ≥ 0169 widens). Its control proves it can fail |

Existing suites stay green UNCHANGED. They guard that no app path needed the revoked privileges:
- `t354-immutability-triggers-always.test.ts` (A1-A5 on `audit_log`, `:368`), `audit-log-rls.test.ts` (L4, `:107`),
  `rls.test.ts` and `restricted-role.test.ts`;
- `stock-ledger.test.ts`, `attendance-punches.test.ts` and `attendance-adjustments.test.ts` (the supersede path runs
  as the restricted role);
- `low-stock.test.ts` (the order thread), `t345-missed-month.test.ts`, `etl-run.test.ts` and `migration-journal.test.ts`.
- **The full integration suite**, because any table that the app mutates is created before 0169 and keeps its grants.
  A red here means R3 revoked something an app path uses. That is a spec defect: report it, do not re-grant.

## §9.4
None on screen. 0169 changes privileges only. No UI, action or domain path changes, and the app never UPDATEs or
DELETEs the six revoked tables (R3, grepped). What substitutes:
1. Apply from zero on a scratch database (ADR-012 §5.8). Record `count(*)` and `max(created_at)` from
   `drizzle.__drizzle_migrations`.
2. On that scratch DB, paste the raw output of
   `select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl`.
   It must show `shareat_app=ar/…` on the `'r'` row.
3. On the scratch DB, prove the post-assertion by hand. In a rolled-back transaction:
   - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO shareat_app`, then paste the DO block's
     RAISE when you re-run it;
   - separately, `SET ROLE` to a fresh throwaway role (created in that transaction), run the block, and paste the
     grantor-mismatch RAISE.
4. Boot the app on 9008. Do one save that writes a stock movement (a stock adjustment or a delivery receive) and one
   attendance supersede. Screenshot both saved states. This proves INSERT, and the one kept UPDATE, still work as
   the app role.

## Out of scope
- **Changing any existing table's grants beyond R3's six.** Narrowing the nine state-transition tables needs a
  column-level or policy design. That is a separate task if ever wanted.
- **A per-table "who may mutate" registry.** The E1 fixture plus explicit grants in each migration is the record (R5).
- **Stopping the owner from `GRANT`ing anything back.** Owners can. G1 and D3 catch it only when it is done as a
  default, and E1 only for the pre-0169 tables.
- Editing 0011 or 0088 (RULES §1 rule 9).
- Running anything against production. The deploy applies 0169, and the post-assertion is the check.

## Done when
- D1, D3, N1, N2, E1, V1, V2 and V3 (DELETE) go red→green. E2 and G1 go red (file absent) → green, with their
  positive controls shown firing. D2, N3, C1 and V3 (UPDATE) stay green.
- Every existing suite named above is green unchanged, and so is the full integration suite (RULES §2 DoD).
- `migration-journal.test.ts` is green, and 0169 applies from zero. Typecheck is clean. The §9.4 substitutes are pasted.
- The builder edited no test or fixture file.
- **Orchestrator:** DEF-489 → `fixed`, citing the commit. Note on the register row that R3 also revoked six existing
  append-only tables.

## Questions for Ian
None. Ian ruled option (a). R3's revokes on six existing tables follow T-354 R4's accepted reasoning, and each one
was checked against every app write path. They are technical and reversible by one GRANT.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-29)
- **S1 — R3 (the revokes on six EXISTING tables) is NOT built in T-355.** It goes beyond Ian's ruling (bible row
  242: "existing tables keep their grants either way") and, as written, was unsafe: `stock_movements` UPDATE is
  needed by `onHandForUpdate` (`packages/db/src/repo/stock-ledger.ts:86-91`, `select … for update`, called by
  `packages/domain/src/stock/transfers.ts:74` as `shareat_app`) — Postgres requires UPDATE privilege for
  `FOR UPDATE`/`FOR SHARE`, so every transfer dispatch would 42501. Drop R3, V1–V3 and C1 from this task; E1/E2's
  snapshot then expects NO existing table to change. The corrected R3 (stock_movements DELETE only; the other five
  as listed; attendance_adjustments DELETE only; a transfer dispatch added to §9.4) is a follow-up, **T-356, only if
  Ian says yes.**
- **S2 — before merge, read prod's `pg_default_acl` as doadmin (read-only); IAN RUNS IT (row 243)** so a stray grantor's row is found by a
  query, not by the first deploy aborting (it would abort safely: `deploy.yml:129` `set -euo pipefail`, before the
  symlink swap at `:152`). Ian/ops runs it; the builder writes the query into the spec's §9.4.
- **S3 — split the assertion's RAISE text:** check (i) "a stored default still grants UPDATE/DELETE to shareat_app
  (grantor <role>)"; check (ii) "the migrating role is not 0011's grantor".
- **S4 — ANSWERED:** Ian said yes to T-356 (row 243).

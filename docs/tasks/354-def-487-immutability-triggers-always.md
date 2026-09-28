# T-354: history-guard triggers fire in replica mode too (DEF-487)

**Status:** DONE 2026-09-29 (migration 0168; full suite green). APPROVED 2026-09-28 (orchestrator, after an independent Opus spec audit; amendments M1–M3 at the end bind). **Model:** Sonnet, tester then builder.
**Migration:** `0168_t354_def487_immutability_triggers_always.sql`. The journal entry is idx 168, `when` = 1800588707084
(0167's `1800502307084` + 86_400_000).
**Why now:** Ian, 2026-09-28 (bible §13 row 241): "yes fix def 487 before launch".
**Runs after** T-350 S3 (`fc9a1d4`, migration 0167). It touches no domain or app code, so it overlaps no open lane.
Line numbers were checked at HEAD `f69a9ff`.

## Why
DEF-487 (`docs/DEFECTS-REGISTER.md`, the DEF-487 row):
- Every trigger in the database was created plain, so `tgenabled = 'O'`. Measured on `shareat_test_t343s5_builder`,
  all 57 non-internal triggers are `O`.
- An `O` trigger does not fire while `session_replication_role = 'replica'`. The auditor ran a superuser
  `DELETE FROM audit_log` inside `SET LOCAL session_replication_role = 'replica'`, and the row was removed. Outside
  replica mode the same DELETE raises 23001.
- Replica mode is what logical-replication apply workers use. It is also the usual trick in hand-rolled bulk loads
  ("turn off FKs and triggers").
- The fix: `ENABLE ALWAYS` every trigger whose only job is to stop history being rewritten or erased.

**The register row says "12" history guards. There are 18.** The six it missed are
`missed_month_adjustments` ×2, `stock_usage_void_terminal_trg`, `count_sessions_commit_once_trg` and
`trade_discrepancies` ×2.

The row also lists three smaller items from the same review:
1. The app role's UPDATE or DELETE on `audit_log` succeeds silently with 0 rows. There is no UPDATE/DELETE policy under
   FORCE RLS, so the trigger never runs.
2. 0167's pre-flight row guard is blind for a migrator without BYPASSRLS.
3. `rls.test.ts:404`'s live-policy guard skips `audit_log`'s actor check.

## Rulings (planner, 2026-09-28)

- **R1: which triggers become ALWAYS.** The test: does the trigger's only job refuse a rewrite or erase of a row that
  is already history (posted, frozen, committed, resolved, voided, or append-only)? And does it decide only from that
  row's OLD/NEW (plus, for `journal_lines`, its parent entry's status)? If both are yes, it becomes ALWAYS.
  - None of the 18 reads a GUC. Measured: `app.reversal_posting` is read by `journal_lines_check_account_eligible`,
    not by either `*_posted_immutable` function (`0005:77`). So a logical-replication replay of a legitimate
    transition passes, because the same function already allowed it at the origin. Examples: posted→reversed at
    `0005`; the attendance-day unfreeze at `0106:33-37`; config supersede at `0081`; the missed-month FK cascade at
    `0161:199-205`, where `pg_trigger_depth() > 1` holds whatever the trigger's mode.

  **ALWAYS (18):**

  | Table | Trigger | Created |
  |---|---|---|
  | journal_entries | journal_entries_posted_immutable | 0003:309 |
  | journal_lines | journal_lines_posted_immutable (INSERT leg included, DEF-031) | 0004:77 |
  | stock_movements | stock_movements_append_only_trg | 0063:97 |
  | stock_usage_records | stock_usage_posted_immutable_trg | 0067:150 |
  | stock_usage_records | stock_usage_void_terminal_trg | 0067:166 |
  | count_sessions | count_sessions_commit_once_trg | 0068:180 |
  | trade_discrepancies | trade_discrepancies_defer_once_trg | 0071:92 |
  | trade_discrepancies | trade_discrepancies_resolution_terminal_trg | 0071:118 |
  | trade_order_messages | trade_order_messages_append_only_trg | 0072:77 |
  | store_attendance_config | store_attendance_config_immutable | 0081:159 |
  | attendance_punches | attendance_punches_append_only | 0082:151 |
  | attendance_days | attendance_days_frozen_immutable | 0083:122 |
  | attendance_adjustments | attendance_adjustments_append_only | 0084:101 |
  | etl_source_documents | etl_source_documents_immutable | 0009:44 |
  | fiscal_periods | fiscal_periods_fill_immutable_trg | 0160:106 |
  | missed_month_adjustments | missed_month_adjustments_no_update_trg | 0161:195 |
  | missed_month_adjustments | missed_month_adjustments_no_direct_delete_trg | 0161:209 |
  | audit_log | audit_log_append_only | 0167:91 |

- **R2: the other 39 stay origin (`O`), deliberately.**
  - **Derivation. A replay or restore must NOT re-run these (11).**
    - The mirror outbox enqueuers (0088/0100/0112): `employments_mirror_enqueue`,
      `employment_positions_mirror_enqueue`, `persons_mirror_enqueue`, `store_attendance_config_mirror_enqueue`,
      `attendance_days_mirror_enqueue` and `attendance_credentials_mirror_enqueue`. A replica would re-enqueue Firestore
      writes.
    - `stores_seed_foundation_money_accounts` (0029). It would seed the money accounts a second time over restored
      ones.
    - `stores_opening_date_propagate_trg` (0163:240).
    - `fixed_assets_in_service_a_fill_ins_trg` and `fixed_assets_in_service_a_fill_upd_trg` (0163).
    - `person_grants_fill_store_id_trg` (0159).
    - The restored row already carries the derived value, and recomputing it later could differ.
  - **Validators of NEW data against other rows' CURRENT state or the clock (28):**
    - Journal: `accounts_postable_no_children`, `journal_lines_account_eligible`, `journal_entries_period_open`,
      `journal_lines_period_open`, `journal_lines_party_requirement`, `journal_entries_balance_check`,
      `journal_lines_balance_check`.
    - Inventory: `stock_movements_check_period_open_trg`, `stock_movements_check_not_frozen_trg`,
      `stock_movements_reversal_matches_trg`, `stock_movements_no_negative_on_hand_trg`,
      `stock_layer_consumptions_ties_trg`, `stock_locations_single_room_guard_trg`,
      `stock_locations_deactivation_guard_trg`, `stock_usage_operating_location_trg`,
      `count_session_locations_one_active_trg`, `delivery_lines_shortage_explained_trg`.
    - Items: `items_block_slab_recategorise_trg`, `items_check_parent_slab_unit_trg`.
    - Orders, expenses and wastage: `trade_orders_submit_hardening_trg`, `expenses_require_verified_invoice`,
      `order_wastage_allocations_sum_100_trg`.
    - Periods and assets: `fiscal_periods_order_guard_ins_trg`, `fiscal_periods_order_guard_upd_trg`,
      `fixed_assets_in_service_b_guard_trg`.
    - Attendance and catch-up: `attendance_punches_validate`, `attendance_adjustments_validate`, `missed_month_adjustments_guard_trg` (BEFORE INSERT, 0161:170).
    - Why they stay origin: reloading a genuine historic row after a period closed or an account was archived would
      fail them.
    - The residual risk is new invalid rows written in replica mode. That is **out of scope** (see below). DEF-487 is
      about history being rewritten or erased.

- **R3: every consumer of replica mode or trigger bypass, checked.**

  | Path | Effect of ALWAYS |
  |---|---|
  | Cutover purge (`packages/db/src/cutover/purge.ts:355`) | It TRUNCATEs, which fires no row trigger. **Unaffected.** Its row DELETEs (`:358` on `fiscal_periods`, `:367` on `fixed_assets`) already run in origin mode and touch no ALWAYS trigger that refuses them: `fiscal_periods_fill_immutable` is UPDATE-only. |
  | `repo/cutover.ts:289-296` | Deletes DRAFT entries and their lines only, in origin mode. **Unaffected.** |
  | ETL (`packages/etl`) | Writes landing tables and none of the 18. It runs in origin mode. `etl_source_documents` is already append-only in origin mode. **Unaffected.** |
  | Test fixtures' TRUNCATEs (`packages/*/tests`) | TRUNCATE fires no row trigger. **Unaffected.** |
  | `session_replication_role` / `DISABLE TRIGGER` anywhere in code, scripts or ops docs | **Zero hits** (grep, whole tree, excluding node_modules). |
  | Full `pg_dump` / `pg_restore`, and DO managed backups (physical) | Triggers are created in post-data, after the rows load. `pg_dump` records `ENABLE ALWAYS` and restores it. **Unaffected, and the protection survives a restore.** |
  | Data-only `pg_restore --disable-triggers` | Uses `ALTER TABLE … DISABLE TRIGGER ALL` (superuser/owner), which disables ALWAYS triggers too. **Still works.** It is an explicit, visible DDL act. This task does not (and cannot) stop an owner doing that. |
  | Logical-replication apply | Legitimate transitions replay cleanly (R1). The 11 derivation triggers stay silent on the subscriber, which is correct. |

- **R4: the `audit_log` app-role hole is closed with `REVOKE UPDATE, DELETE ON audit_log FROM shareat_app`, NOT with
  permissive UPDATE/DELETE policies.**
  - A `USING (true)` or org-scoped UPDATE/DELETE policy would make tampering loud (23001). But it would also leave the
    trigger as the only lock for the app role. Bible §15.11 says no layer may be the only one for a given risk.
  - `USING (true)` would also let one org probe another org's row ids by the error it gets back.
  - REVOKE is loud too: 42501 `insufficient_privilege` at the statement. It keeps the registry's "no policy = no
    access" sentence true, and it adds a third lock (privilege, then RLS, then trigger).
  - Measured: nothing re-grants. 0011:68/72 grant once, `provision.sh` and `provision-test-role.mjs` grant no table
    privileges, and `repo/audit-log.ts:38` only INSERTs.
  - This is the first REVOKE in the tree. The migration header says why.

- **R5: one trigger registry is the source of truth, like the RLS registry.** The new file is
  `packages/db/src/triggers/registry.ts`. It classifies EVERY non-internal public trigger as `always` or `origin`, with
  a one-line reason for each. The live guard (T-legs) fails when a trigger exists that is not classified, or when the
  live `tgenabled` differs from its class.
  - So the next trigger a lane adds must be classified the day it lands. That is the same mechanism as
    `rls/registry.ts` and `cutover/classification.ts`.
  - Schema files get **no** per-trigger NOTE for `ENABLE ALWAYS` (ADR-012 §5.3 covers what a trigger does, not its
    firing mode). The registry is the one place.

- **R6: 0167's pre-flight guard is not edited.** It is applied and never edited (RULES §1 rule 9). It fails closed:
  a hidden row makes `ADD COLUMN … NOT NULL` raise 23502. The lesson is recorded for future migrations: a pre-flight
  `EXISTS` on a FORCE-RLS table is blind for a migrator without BYPASSRLS. **0168 carries no row pre-flight.** It
  changes no data.

- **R7: the actor-check guard is a registry marker, not a column-name heuristic.**
  - 141 FK columns reference `persons` under names other than `person_id` (measured). Guarding all of them is a
    separate audit.
  - Instead, `RlsEntry` gains an optional `actorPersonColumn`, and `audit_log` sets it to `'actor_person_id'`.
    `rls.test.ts` gets a sibling block to T-221 that enumerates the marker.

## BUILDER items

1. **The migration.** New file `packages/db/migrations/0168_t354_def487_immutability_triggers_always.sql`, per
   ADR-012 §5:
   - **Header:** name DEF-487 and bible row 241, list R1-R4 in brief, and state these points:
     - ALWAYS closes replica mode. It does not stop `DISABLE TRIGGER`.
     - `pg_dump` carries the ALWAYS state.
     - This is the tree's first REVOKE, and why (R4).
   - **Body:** 18 statements, `ALTER TABLE "<table>" ENABLE ALWAYS TRIGGER "<trigger>";--> statement-breakpoint`, in
     R1's table order. Then `REVOKE UPDATE, DELETE ON "audit_log" FROM "shareat_app";` as the last statement (no
     trailing breakpoint).
   - No DO blocks and no data changes.
2. **Journal.** `packages/db/migrations/meta/_journal.json`: append
   `{ "idx": 168, "version": "7", "when": 1800588707084, "tag": "0168_t354_def487_immutability_triggers_always", "breakpoints": true }`.
3. **The trigger registry.** New file `packages/db/src/triggers/registry.ts`:
   - `export type TriggerMode = 'always' | 'origin';`
   - `export interface TriggerEntry { table: string; mode: TriggerMode; kind: 'history_guard' | 'derivation' | 'validator'; reason: string }`
   - `export const TRIGGER_REGISTRY: Record<string /* tgname */, TriggerEntry>`, with all 57 from R1/R2.
     `mode === 'always'` if and only if `kind === 'history_guard'`.
   - A JSDoc stating the R1 test verbatim, and naming the guard file.
   - Not exported from the package index unless the guard needs it from there. Import it by relative path, as
     `rls.test.ts` does with `rls/registry`.
4. **The RLS registry marker.** `packages/db/src/rls/registry.ts`:
   - Add `actorPersonColumn?: string` to the entry type, with a JSDoc: the INSERT/ALL policy's WITH CHECK must prove
     this column's person is in `app_current_org()` (DEF-183 pattern).
   - Set `actorPersonColumn: 'actor_person_id'` on `audit_log` (`:285`).
   - Extend its `reason` (`:288-292`) with this sentence: "UPDATE and DELETE are also REVOKEd from the app role (0168,
     T-354), so an attempt is a loud 42501, not a silent 0-row success."
5. **Ops note.** `docs/ops/README.md`: add a short section, "Restores and replica mode (T-354)". Three bullets:
   - A full restore keeps ALWAYS.
   - A data-only restore needs `--disable-triggers` as owner, and that deliberately bypasses the history guards, so
     restore only into an empty database.
   - Never `SET session_replication_role = replica` against a live database.

**BUILDER paths:** `packages/db/migrations/0168_t354_def487_immutability_triggers_always.sql` (new),
`packages/db/migrations/meta/_journal.json`, `packages/db/src/triggers/registry.ts` (new),
`packages/db/src/rls/registry.ts`, `docs/ops/README.md`.
⛔ Not any applied migration (0167 included, R6), not any `schema/*.ts` (R5), not the register or the bible, and no
test file.

## TESTER paths
- **New file.** `packages/db/tests/integration/t354-immutability-triggers-always.test.ts`: T1-T5, P1-P6, D1-D2 and A1-A5.
  - Real Postgres through `TEST_DATABASE_URL`, with the `_test` name guard from `audit-log-rls.test.ts:18-22`.
  - Every P/D leg runs inside `sql.begin` with `SET LOCAL session_replication_role = 'replica'`, and rolls back by
    throwing a sentinel at the end.
  - ⛔ If `select rolsuper from pg_roles where rolname = current_user` is false, the file **fails** with a sentence.
    It never skips: a skipped replica leg is the vacuous pass this task exists to end.
  - Fixtures: reuse `journal.test.ts`'s posted-entry seeding, and `audit-log-rls.test.ts:40-55`'s `orgAndPerson` and
    `seedRow` shape.
- **Ruled edits.** Each one corrects a behaviour. None weakens a test. Record each in the TESTER report.
  - `packages/db/tests/integration/audit-log-rls.test.ts:108-114`: the app-role half now expects UPDATE and DELETE to
    reject with `code === '42501'` (retitle to match). The owner half (`:115-123`, 23001) is unchanged.
  - `packages/db/tests/integration/rls.test.ts`: add a new `describe` after the T-221 block (`~:380-440`), "T-354 —
    every actor-marked table's INSERT policy proves the actor's org". It holds X1 and X2. No existing assertion is
    touched.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| T1 | Registry floor | `TRIGGER_REGISTRY` has ≥57 entries, exactly 18 with `mode:'always'`, and the 18 names equal R1's table | The import fails, because `triggers/registry.ts` does not exist (state that this is the red) |
| T2 | Completeness vs live DB | Every `pg_trigger` row with `not tgisinternal` on a `public` table is a key in the registry with the matching `table`, and every registry key exists live (no stale entries) | As T1 |
| T3 | Mode vs live DB | For every entry, live `tgenabled` = `'A'` when `always` and `'O'` when `origin` | As T1; once it imports, all 18 read `'O'` |
| T4 | Naming net | Every live trigger whose name matches `/immutable\|append_only\|no_update\|no_direct_delete\|commit_once\|terminal\|defer_once/` is `always` | As T1 |
| T5 | Over-flip guard | The six `*_mirror_enqueue` triggers and `stores_seed_foundation_money_accounts` are live `'O'` | Green (guard) |
| P1 | replica · DELETE one line of a POSTED journal entry | Rejects with `/its lines are immutable/`; the line is still there | The DELETE succeeds (1 row) |
| P2 | replica · DELETE a POSTED `journal_entries` row | Rejects with `/cannot be deleted/` | Succeeds. FK triggers are also silent in replica mode, so it orphans the lines |
| P3 | replica · INSERT a balanced line pair onto a POSTED entry | Rejects with `/lines may only be inserted while an entry is draft/` | Inserts |
| P4 | replica · UPDATE `stock_movements.quantity` | Rejects with `/stock_movements is append-only/` | Succeeds |
| P5 | replica · DELETE an `attendance_punches` row | Rejects (the append-only message) | Succeeds |
| P6 | replica · superuser DELETE of an `audit_log` row (the auditor's repro) | `code === '23001'`; the row is still there | Deletes it |
| D1 | replica · INSERT a `stores` row | Zero foundation money accounts are created for it (derivation stays origin) | Green (guard) |
| D2 | replica · UPDATE a `persons` row with an employment | No new mirror-outbox row | Green (guard) |
| A1 | App role (`asOrg`) UPDATE of its OWN org's `audit_log` row | `code === '42501'` | A silent `count 0` |
| A2 | App role DELETE of the same | `code === '42501'` | A silent `count 0` |
| A3 | App role INSERT (own org, own actor) | Succeeds | Green (guard) |
| A4 | App role SELECT of own-org rows | Returns the row | Green (guard) |
| A5 | `has_table_privilege('shareat_app','audit_log', p)` | false for UPDATE and DELETE; true for SELECT and INSERT | UPDATE and DELETE are true |
| X1 | (rls.test.ts) Marker floor | The entries with `actorPersonColumn` number ≥1 and include `audit_log` | 0 entries, because the field does not exist (a type error or an empty list; state which) |
| X2 | (rls.test.ts) For each marked table | Its INSERT or ALL policy's `with_check` matches `/FROM persons/`, the column name, and `/p\.org_id = app_current_org\(\)/` | As X1 |

Existing suites stay green UNCHANGED. They are the guard that legitimate origin-mode transitions still pass:
- `journal.test.ts` (reversal, posted→reversed);
- the T-345 missed-month cascade tests;
- the attendance unfreeze tests;
- `cutover-purge.test.ts` and `t347-cutover-purge-shells.test.ts`;
- `audit-log-rls.test.ts` except the ruled edit.

## §9.4
None on screen. No UI, action or domain path changes, and the app role never UPDATEs or DELETEs `audit_log`. What
substitutes:
1. Apply 0168 from zero on a scratch database (ADR-012 §5.8). Record `count(*)` and `max(created_at)` from
   `drizzle.__drizzle_migrations`.
2. On that scratch DB, run `pg_dump --schema-only` if it is on PATH. Paste the count of `ENABLE ALWAYS TRIGGER` lines,
   which must be 18. That proves a backup carries the fix.
3. Re-run the auditor's repro by hand in a rolled-back transaction on the scratch DB (P6), and paste the real 23001
   output.
4. Boot the app on 9008 and load one page that writes an audit row (T-350's payout-account change). Screenshot the
   saved state. This proves the REVOKE did not break the INSERT path.

## Out of scope
- **New invalid rows written in replica mode.** Validators and deferred balance checks stay origin (R2). A writer that
  can set replica mode is an owner or superuser who can also `ALTER TABLE`. The orchestrator records this as a
  `reported` residual on DEF-487, not a new task.
- **Stopping `ALTER TABLE … DISABLE TRIGGER`** by an owner. An event trigger would need a superuser, and DO managed
  Postgres does not offer one.
- A generic actor-column audit across the 141 FK columns to `persons` (R7).
- Editing 0167 (R6).
- Any change to trigger function bodies.

## Done when
- T1-T4, P1-P6, A1, A2, A5 and X1-X2 go red→green. T5, D1-D2, A3 and A4 stay green.
- Every existing suite named above is green unchanged, apart from the one ruled `audit-log-rls` edit.
- `migration-journal.test.ts` is green, and 0168 applies from zero.
- Typecheck is clean, the full integration suite passes (RULES §2 DoD), the §9.4 substitutes are pasted, and the
  builder edited no test file.
- **Orchestrator:** DEF-487 → `fixed`, citing the commit. Correct the register row's "12" to 18, and correct its "pg_restore sets replica
  mode" wording per R3.

## Questions for Ian
None. Every call here is technical, and each one is ruled above.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-28)
- **M1.** T1–T4 must not statically import the not-yet-existing `triggers/registry.ts` (collection failure would hide
  every other leg's red/green). Use `await import()` inside T1–T4, or put T1–T4 in their own file.
- **M2.** P1/P6 "row still there" is vacuous after the sentinel rollback, and a check inside an aborted tx hits 25P02.
  Run the target statement under `tx.savepoint`, record today's red as the DML SUCCEEDING (`count 1`), and check the
  row inside the transaction.
- **M3.** X2 must assert its enumerated set of `actorPersonColumn` entries is NON-EMPTY (0 today → vacuous pass). X1's
  red is an empty list, not a type error — say so.
- Notes: R1's `pg_trigger_depth() > 1` wording overclaims on a logical-replication subscriber (unreachable in
  practice); ETL does INSERT into `etl_source_documents` (harmless: that trigger is UPDATE/DELETE only); the rls.test
  heuristic is at `:401`.

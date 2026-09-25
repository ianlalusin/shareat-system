# T-347: DEF-437 — the cutover purge cannot clear a shell row the schema's own CHECKs guard

**Status:** APPROVED 2026-09-25 (orchestrator, after independent Opus spec review; its changes folded in as Amendment R1). **Builds after T-343 S5 and after T-346 S2** (T-346 adds `fixed_assets.in_service_*`

> **Decisions (Ian, 2026-09-25):** Q1: prepaid items are PURGED at cutover and re-entered in T-134. Q2: disposed fixed assets are DELETED at cutover.
and their shape CHECK + history guard; this task must satisfy both). **Migration: yes, one**, slot `0164` (orchestrator
claims; T-346 holds 0162/0163). Journal `when` = previous + 86 400 000.
**Closes:** DEF-437 (`docs/DEFECTS-REGISTER.md:644`), plus four same-root shapes found by this sweep (§2; orchestrator registers).
**Model:** Sonnet, both roles. TESTER writes first and records red; BUILDER second; paths disjoint (§5).

---

## 1. Goal (bible §1.2d)
1. **v1 at source.** Ian's brief (ADR-007:13-15): wipe everything *"except ... fixed assets (name only, amount can be configured
   on Jan 2027)"*. v1 assets never reach v2 by ETL: `packages/etl/src` has no fixed-asset converter (only `audit/report.ts`
   mentions them). The v2 register is filled by hand in the pilot, then shelled on 1 January and valued from the T-134 B2 walk-round.
2. **Goal:** on 1 January every asset that physically exists survives as a named shell waiting for its value; nothing else changes.
3. **Live data.** `shareat_dev` holds 0 fixed assets (T-346 §1.3), so nothing has ever exercised the path. The orchestrator counts
   production `fixed_assets` / `prepaid_items` by status and reconciled customers/suppliers before the November rehearsal.
4. **v2 bar.** The purge clears each shell row in ONE statement into a state the schema accepts, proves the clear happened,
   and a rehearsal finds any refusal before January, not on it.

## 2. Evidence (static read, HEAD `1e7862c`)
The script clears one column per UPDATE (`scripts/cutover-purge.ts:229-233`); its post-conditions only count shell rows
(`:251-254`), never check a column was cleared. `cutover-purge.test.ts` tests TRUNCATE directly and greps the script (`:108`);
it never runs the shell step. Every shape below fails a real purge:

| # | Table (class) | Constraint | Fails when |
|---|---|---|---|
| A | `fixed_assets` (keep_shell) | `valuation_shape_check` (`0019:48-51`) | any non-shell row: `SET cost = NULL` with status unchanged (DEF-437) |
| B | `fixed_assets` | `disposal_pair_check` (`0019:52-55`) allows only `active` or `disposed` | **ANY `pending_valuation` row, ever.** The shell the classification promises (`classification.ts:576-578`) cannot exist; `valuateShell` (`repo/fixed-assets.ts:342`) is unreachable, and no test inserts one |
| C | `fixed_assets`, `status='disposed'` | A + B | a disposed asset can be neither valued (cost NULL) nor a shell. It no longer exists on 1 January |
| D | `prepaid_items` (keep_shell) | `total_cost`, `coverage_start_date`, `coverage_months` NOT NULL (`0026` table body) | **every row**, any status: 23502. No shell state exists |
| E | `customers`, `suppliers` (keep_shell) | `*_reconciled_shape_check` all-three-or-none (`0042:82-85`, `0043:51-54`) | any reconciled row: the first per-column UPDATE leaves two of three set |
| F | `fixed_assets` after T-346 | `in_service_shape_check` (shell ⇒ both NULL) + `..._b_guard` (T-346 §3.3, R1) | met only if the shell UPDATE clears both columns AND runs after `journal_entries` is truncated |
| G | any keep_shell table, FORCE RLS | policy `org_id = app_current_org()` | if the purge connects as a non-superuser owner, UPDATE/DELETE match **zero rows silently** and every post-condition still passes (`0011:10-24`). `.env.example:29` uses `postgres` today |
| — | `stored_files.linked_to` | none (`0032:31`) | safe |

## 3. Design
### 3.1 Engine out of the CLI: `packages/db/src/cutover/purge.ts` (new)
`planPurge(sql, asOf)` (read-only: order, counts, rows to drop per shell table) and `applyPurge(tx, plan)` (the transaction body,
TRUNCATE unchanged). `scripts/cutover-purge.ts` becomes argument parsing + ceremony + report, calling both. Reason: the test
must run the SAME code the operator runs, on a scratch DB. Add `--report <path>` (default unchanged) so tests do not write `docs/reviews/`.

### 3.2 Classification: a shell says what state it lands in, and which rows are gone
`KeepShellEntry` gains optional `set?: Readonly<Record<string, string | boolean>>` (literal values, bound as parameters) and
`dropWhere?: { column: string; in: readonly string[] }` (rows that describe something that no longer exists).
- `fixed_assets`: `dropWhere: { column: 'status', in: ['disposed'] }`; `set: { status: 'pending_valuation', needs_review: false }`
  (the default terms it flagged are cleared); `clearColumns` = today's four + T-346's `in_service_on`, `in_service_source`.
- `prepaid_items`: **reclassify `purge`** (recommendation, Ian Q1). With cost, start and term all cleared, the shell keeps only a
  name and category, which is a re-entry anyway; T-134 creates the opening item. Nothing references `prepaid_items`. Avoids a
  second nullable-money ripple through `repo/prepaid.ts`, `domain/prepaid`, the amortisation run and `/prepaid`.
- `customers`, `suppliers`, `stored_files`: unchanged entries; fixed by 3.3 alone.

### 3.3 `applyPurge` shell step, after TRUNCATE and date-scoped deletes (order is load-bearing: F's guard reads posted entries)
Per shell table: (1) `delete ... where <dropWhere>` if any; (2) ONE `update t set c1 = null, ..., cN = null, <set...>`.
Post-conditions (inside the transaction, added to `problems`): shell rows after = before − dropped (planned count);
**zero rows where any clearColumn is non-null; zero rows where a `set` column differs from its value** (catches G and a
no-op clear); keep tables byte-identical by `md5(string_agg(t::text, '' order by t::text))`, not only by count.

### 3.4 Preflight and dry run
- **Refuse** unless `select rolsuper or rolbypassrls from pg_roles where rolname = current_user` is true: `REFUSED. <role>
  is subject to row-level security; the purge would clear nothing and report success.` (G). Runs in dry run too.
- Dry run (default) stays read-only and now reports per shell table `rows now | dropped (status=disposed) | after`.
- **`--rehearse`** (new): run `applyPurge` in a transaction and ALWAYS roll back, reporting pass or the exact error. Meant for
  the November restored copy (ADR-007 §5); it takes TRUNCATE locks, so the usage text says "not against a live database".

### 3.5 Migration `0164_t347_asset_shell_disposal_pair.sql` (hand-authored, ADR-012 §5)
Drop and re-add `fixed_assets_disposal_pair_check` with a third branch:
`(status = 'pending_valuation' and disposed_on is null and disposal_reason is null and disposed_by is null)`. Mirror in
`schema/fixed-assets.ts:269-274`. No data change (no shell rows can exist). Header states B and that nothing else moves.

## 4. Tests (TESTER, real Postgres on a SCRATCH database per describe, technique of
`attendance-credentials-scan-collision-migration.test.ts:79-104`; migrate to head; red = run on current `main`). Fixture (one org): store, person, posted journal entry, `asset_policy` + `asset_category_lives`, asset **A1 active** (cost
24,000, salvage 1,000, acquired 2026-03-15, `needs_review` true, notes, in service per T-346, one posted depreciation entry),
**A2 disposed**, customer + supplier **reconciled**, **P1 active prepaid**, stored file **linked**.

| # | Case | Positive / ⛔ Negative | Expected red |
|---|---|---|---|
| S1 | script `--apply` (child process, scratch `DATABASE_URL`) | exits 0; report says committed | `fixed_assets_valuation_shape_check` (A) |
| S2 | `applyPurge` on the fixture | A1 `pending_valuation`; cost, salvage, acquired, source, in-service both NULL; `needs_review` false | module not found |
| S3 | same | ⛔ A1 name, category, store, `useful_life_months`, notes, id unchanged | as S2 |
| S4 | same | A2 deleted; shell count = before − 1 | as S2 |
| S5 | same | customer + supplier anchors all NULL, rows kept | as S2 (then E's 23514 once engine exists with per-column loop) |
| S6 | same | `prepaid_items` empty; `stored_files.linked_to` NULL | as S2 |
| N1 | ⛔ half-clear: scratch-only CHECK on `suppliers` refusing NULL `reconciled_by`, then apply | throws; A1 still `active` at 24,000, journal count unchanged, customers anchor intact | as S2 |
| N2 | ⛔ keep untouched | `accounts`, `stores`, `asset_policy`, `asset_category_lives`, `persons` md5 identical | as S2 |
| N3 | ⛔ dry run and `--rehearse` | md5 of every table identical after; dry run lists A2 as dropped; on red `main`, rehearse fails with A's error | flag unknown |
| N4 | ⛔ RLS preflight: run as `shareat_app`-like non-bypass role | `REFUSED ... row-level security`; nothing changed | no refusal; exits 0 having cleared nothing |
| M1 | migration 0164 (scratch DB at 0163, then 0164) | raw insert of a shell accepted. ⛔ shell with `disposed_on` → 23514; ⛔ active with NULL cost → 23514 | 23514 `disposal_pair_check` on the shell |
| U1 | unit, `cutover-classification.test.ts` | every `set` / `dropWhere` column exists on its table; a `set` column is never also in `clearColumns` | property unknown |

Files: `packages/db/tests/integration/t347-cutover-purge-shells.test.ts` (S, N), `packages/db/tests/integration/t347-migration.test.ts`
(M1), `tests/unit/cutover-classification.test.ts` (U1), `packages/db/tests/integration/cutover-purge.test.ts:108` (grep now reads `purge.ts`).

## 5. Paths (disjoint)
**TESTER:** the four test files above only.
**BUILDER:** `packages/db/src/cutover/purge.ts` (new); `packages/db/src/cutover/classification.ts` (types, `fixed_assets`,
`prepaid_items`); `scripts/cutover-purge.ts`; `packages/db/migrations/0164_*` + `meta/_journal.json`; `packages/db/schema/fixed-assets.ts` (the one CHECK).
⛔ **Do not touch:** applied migrations, `repo/fixed-assets.ts`, `domain/**`, `repo/prepaid.ts`, `rls/registry.ts`, bible, register, glossary, ADR-007.

## 6. Invariants
1. One transaction; any failure leaves every row as it was (ADR-007 §5). N1.
2. A shell row is written in one statement into a state its CHECKs accept; no half-cleared row can exist. S2, N1, M1.
3. Post-conditions prove the clear happened, not just that rows survived (closes G). S2, N4.
4. KEEP tables are byte-identical; untouched shell columns are unchanged. N2, S3.
5. Shells are cleared only after the ledger is truncated (T-346 guard). S1 with the posted depreciation entry.
6. Dry run never writes; rehearse always rolls back. N3.

## 7. Out of scope
- T-134's valuation writer and the "remaining useful life" gap (ADR-007 §2 keeps REMAINING life; the row stores TOTAL life).
- Sequence reset running outside the transaction (`cutover-purge.ts:280-284`): candidate DEF, orchestrator registers.
- **Orchestrator:** register shapes B-G; production counts (§1.3); bible §13 row for the prepaid reclassification if Ian agrees.

## 8. Done when
Every case seen red for its stated reason, then passing · typecheck + unit clean (`cutover-classification`, `migration-journal`,
RLS/classification guards) · **full** integration green (at risk: `fixed-assets`, `cutover-purge`, T-346 files) · scratch-DB
proof of 0164 (ADR-012 §5.8) · `--rehearse` run against a local copy of `shareat_dev` with one asset of each status, output pasted.

**Questions for Ian:** Q1 prepaid items purge at cutover and are re-entered in T-134 (recommended), or stay as shells
(adds a nullable-cost migration and a prepaid valuation path)? Q2 disposed assets are deleted at cutover (recommended; they
do not exist on 1 January), or kept as disposed history with their pilot cost?

## Amendment R1 — spec review (2026-09-25), binding; still DRAFT
Independent Opus review: CHANGES. Where the body above disagrees, this wins. Ian's Q1/Q2 rulings (Decisions line) stand; §3.2's prepaid reclassification and `dropWhere` disposed are now decided, not recommended.
1. **CRITICAL, the TRUNCATE is refused outright.** Kept shell `fixed_assets.source_expense_id` → `expenses` (`0019:63`), and `expenses` is purge
   class, so Postgres raises `0A000 cannot truncate a table referenced in a foreign key constraint` whatever the rows hold. The old test
   hid it with CASCADE (`cutover-purge.test.ts:85`). `planPurge` derives from `pg_constraint` **every FK whose child is NOT truncated
   and whose parent IS**. The dry run lists each one (`child.col → parent`), and `--apply` refuses any the plan cannot handle. Inside the tx,
   `applyPurge`, for each such FK in turn: (a) the child column must be in that table's `clearColumns`, or the purge refuses before writing:
   `REFUSED. <child>.<col> references purged <parent> and is not cleared; classify it`; (b) `alter table child drop constraint <fk>`;
   (c) TRUNCATE; (d) shell step (§3.3), which nulls the column; (e) re-add the FK from its captured `pg_get_constraintdef`, same name,
   **validated** (not `NOT VALID`). DDL is transactional, so a failure restores the constraint. S1's expected red becomes
   `0A000 cannot truncate a table referenced in a foreign key constraint`. New N5: ⛔ a scratch-only kept-class table with an FK into
   `expenses` makes `--apply` refuse with the message above, nothing changed; P1: the dry run lists `fixed_assets.source_expense_id → expenses`;
   S2 adds: the FK exists and is validated after apply (`convalidated = true`).
2. **HIGH, the sequence reset moves inside the transaction.** `cutover-purge.ts:280-284` runs after commit. `applyPurge` restarts the
   sequences as its last step, before the post-conditions (`ALTER SEQUENCE ... RESTART` is transactional). **`mirror_version_seq`
   (`0088:22`) is EXCLUDED:** it is the monotonic version the publisher compares against Firestore's `srcVersion`, so restarting it at 1
   makes every later mirror write look older than what the edge already holds, and the edge freezes. The exclusion is a named constant
   (`SEQUENCES_NEVER_RESET`) in `purge.ts` with that reason. The post-conditions assert `mirror_version_seq`'s `last_value` is unchanged.
   N3 adds: ⛔ after `--rehearse`, every sequence's `last_value` equals its value before. S1 adds: `mirror_version_seq` is unchanged after apply.
3. **MEDIUM, rehearse ceremony.** `--rehearse` requires `--confirm-database` and, off localhost, `--yes-really-not-local`, exactly as
   `--apply`. `--rehearse` with `--apply` → `REFUSED. --rehearse always rolls back; it cannot be combined with --apply.` N3 adds both refusals.
4. **MEDIUM, RLS: §3.4's preflight stays, and §3.3 is corrected.** Under RLS the before and after counts both read 0, so the
   post-conditions cannot catch G. The first statement of the tx is `set local row_security = off`. A role that RLS applies to then
   **errors** (`query would be affected by row-level security policy`) instead of silently matching nothing. §3.3's claim that the
   post-conditions "close G" is struck; the preflight plus `row_security = off` close it. N4 expects the preflight refusal, and N4b
   (preflight bypassed via a test hook) expects the row-security error, with nothing changed.
5. **LOW.** T-346 §3.3 step 7 adds `in_service_on`/`in_service_source` to `clearColumns`. T-347 only **verifies** them (U1 asserts both
   are present), so §3.2's "+ T-346's" line is informational. Build order: after T-346 S2 lands, and Ian's queue still puts it after
   T-343 S5. §5 BUILDER paths unchanged; TESTER owns N5/P1/N4b in `t347-cutover-purge-shells.test.ts`.

# T-356: existing history tables lose the app role's unused UPDATE/DELETE (DEF-489 follow-up)

**Status:** APPROVED 2026-09-29 (orchestrator, after an independent Opus spec audit; amendments A1–A4 at the end bind). Runs after T-355. **Model:** Sonnet, tester then builder.
**Migration:** `0170_t356_def489_existing_table_revokes.sql`. The journal entry is idx 170, `when` = 1800761507084.
That is 0169's `1800675107084` (T-355) + 86_400_000.
**Why now:** Ian said yes (bible §13 row 243). It replaces T-355's dropped R3 (T-355 "Orchestrator amendments", S1).
**Runs after** T-355 (0169). It touches no domain or app code. Line numbers were checked at HEAD `a47e0a7`.

## Why
- T-355 narrows the default for FUTURE tables. Existing tables still hold the SIUD that 0011:68 granted.
- For six of them, a history-guard trigger (T-354, `packages/db/src/triggers/registry.ts:44-165`) refuses an UPDATE
  and/or DELETE on every row. The privilege is dead weight, and it leaves the trigger as the only lock against the
  app role.
- T-354 R4 set the pattern on `audit_log` (`0168:75`): REVOKE gives a loud 42501 at the statement, and a third lock
  (privilege, then RLS, then trigger), per §15.11.
- The planner's first draft (T-355 R3) was unsafe. Postgres requires **UPDATE privilege for `SELECT … FOR UPDATE /
  FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE`**. `stock_movements` is row-locked by the app role. This spec
  re-derives every revoke from a row-lock grep as well as a write grep.

## Rulings (planner, 2026-09-29)

- **R1: the evidence per table.** Two greps, run over `packages/db/src`, `packages/domain/src`, `packages/etl/src`,
  `apps/`, `scripts/` and the SQL function bodies in `packages/db/migrations/`:
  - **Writes:** `.update(` / `.delete(` / raw `update` / `delete from` / `onConflictDoUpdate`.
  - **Row locks:** `for update` / `for share` / `for no key update` / `for key share` / drizzle `.for(`.

  | Table | App writes | App row locks | Revoke |
  |---|---|---|---|
  | stock_movements | none | **YES**: `onHandForUpdate`, `repo/stock-ledger.ts:86-91` (`select 1 from stock_movements … for update`). Its only caller is `domain/stock/transfers.ts:74` (`checkSufficiency`), which runs in `transferNow` (`:89`) and `dispatch` (`:185`) as `shareat_app` | **DELETE only.** UPDATE stays because the lock needs it |
  | trade_order_messages | none | none | UPDATE, DELETE |
  | attendance_punches | none | none | UPDATE, DELETE |
  | etl_source_documents | none. It lands with `onConflictDoNothing` (`repo/etl.ts:205`), which needs INSERT only, inside `systemTransaction` (owner) | none | UPDATE, DELETE |
  | missed_month_adjustments | none. It is removed only by the FK cascade (`0161:199-211`), which runs as the owner (C1) | none | UPDATE, DELETE |
  | attendance_adjustments | **UPDATE**: `markSuperseded`, `repo/attendance-adjustments.ts:108-113` | none | **DELETE only** |

  - Every lock the grep found is on another table:
    - `expenses` (`ap.ts:805-809`), `ar_charges` (`ar.ts:340`), `stores` (`employment.ts:191`) and `trade_orders`
      (`low-stock.ts:140-150`, `trade.ts:201`);
    - `order_wastages` (`order-wastage.ts:109`), `stock_layers` (`stock-layers.ts:76`),
      `trade_discrepancies` (`trade-discrepancies.ts:68`) and `mirror_outbox` (`mirror-outbox.ts:36`).
  - No function body in `migrations/` updates, deletes or row-locks any of the six. No `LOCK TABLE` exists anywhere;
    the only other locks are advisory, which need no table privilege.
- **R2: FK checks do not need the parent's UPDATE.** Several tables reference `stock_movements`:
  - `0063:63` (a self-reference), `0064:50,88,90`, `0067:92` and `0068:120`.
  - `attendance_punches` is referenced at `0082:41` and `0083:26-27`; `attendance_adjustments` at `0084:38`.
  - The RI check (`FOR KEY SHARE` on the parent) and RI cascades run as the **table owner**, not the invoking role,
    so revoking the app role's DELETE (or UPDATE) on a parent breaks no child INSERT.
  - C1 proves the cascade half. The existing transfer and consume suites prove the check half, because they insert
    stock layers that reference movements as the app role.
- **R3: T-355's snapshot leg E1 is amended, not weakened.** T-355's E1 expects no existing table to change. 0170 changes
  exactly six. The tester adds a `T356_REVOKES` expected-delta map inside `t355-default-privileges.test.ts`'s E1: the
  table name → the privileges removed, matching R1's last column. Every other table must still match the fixture
  exactly. This is a ruled edit. Record it in the TESTER report.
- **R4: no registry marker.** The migration plus E1's delta map are the record. Each of the six RLS-registry
  `reason`s gets one sentence (BUILDER item 3), matching `audit_log`'s.

## BUILDER items

1. **The migration.** New file `packages/db/migrations/0170_t356_def489_existing_table_revokes.sql`, per ADR-012 §5.
   - **Header:** DEF-489, bible row 243, and R1's table in brief. State that FOR UPDATE/SHARE needs UPDATE privilege,
     and that this is why `stock_movements` keeps UPDATE. State that RI checks and cascades run as the owner (R2).
   - **Body:** six statements, each ending `--> statement-breakpoint` except the last:
     - `REVOKE DELETE ON "stock_movements" FROM "shareat_app";`
     - `REVOKE UPDATE, DELETE ON "trade_order_messages" FROM "shareat_app";`
     - `REVOKE UPDATE, DELETE ON "attendance_punches" FROM "shareat_app";`
     - `REVOKE UPDATE, DELETE ON "etl_source_documents" FROM "shareat_app";`
     - `REVOKE UPDATE, DELETE ON "missed_month_adjustments" FROM "shareat_app";`
     - `REVOKE DELETE ON "attendance_adjustments" FROM "shareat_app";`
   - No DO blocks and no data changes.
2. **Journal.** `packages/db/migrations/meta/_journal.json`: append
   `{ "idx": 170, "version": "7", "when": 1800761507084, "tag": "0170_t356_def489_existing_table_revokes", "breakpoints": true }`.
   ⛔ If 0169 is not in the journal yet, stop. T-355 lands first.
3. **RLS registry reasons.** `packages/db/src/rls/registry.ts`: append one sentence to the `reason` at each of these
   lines: `trade_order_messages` `:101`, `stock_movements` `:168`, `missed_month_adjustments` `:568`,
   `attendance_punches` `:791`, `attendance_adjustments` `:810` and `etl_source_documents` `:854`.
   - The shape: *"<UPDATE and DELETE | DELETE> REVOKEd from the app role (0170, T-356), so an attempt is a loud
     42501."*
   - For `stock_movements`, add: *"UPDATE is kept: `onHandForUpdate` row-locks it, and FOR UPDATE needs UPDATE
     privilege."*

**BUILDER paths:** `packages/db/migrations/0170_t356_def489_existing_table_revokes.sql` (new),
`packages/db/migrations/meta/_journal.json`, `packages/db/src/rls/registry.ts` (reasons only).
⛔ Not any applied migration, not the register or the bible, and no test or fixture file.

## TESTER paths
- **New file.** `packages/db/tests/integration/t356-existing-table-revokes.test.ts` holds V1-V4, L1-L2 and C1.
  - Real Postgres through `TEST_DATABASE_URL`, with the `_test` name guard (`t354-immutability-triggers-always.test.ts:26`).
  - Copy the `asOrg` helper from `t354…test.ts:253`. It uses `set local role shareat_app`.
  - Probe DDL runs inside `sql.begin`, under `tx.savepoint` per target, and rolls back by throwing a sentinel.
- **New file.** `packages/domain/tests/integration/t356-transfer-dispatch-as-app-role.test.ts` holds D1-D2.
  - Reuse `stock-transfers.test.ts`'s fixture seeding and its `asOrg` (`:40-47`, which is `transaction()` plus
    `set local role`).
  - ⛔ Before any leg, assert that the harness is armed: `DATABASE_URL`'s username is `shareat_test_runner` (from
    `tests/integration/setup.ts:85-90`), and that role is `rolsuper = f` and `rolbypassrls = f`. If not, the file
    **fails** with a sentence. It never skips: a dispatch run as the admin would pass vacuously.
- **Ruled edit (R3).** In `packages/db/tests/integration/t355-default-privileges.test.ts`, E1 gains the
  `T356_REVOKES` delta. No other assertion is touched.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| V1 | `has_table_privilege('shareat_app', t, p)` on the six | See the grid below this table | Every cell is true |
| V2 | App role (`asOrg`, own org, a real seeded row) UPDATE, then DELETE, of an `attendance_punches` row and of a `trade_order_messages` row | Each rejects with `code === '42501'`. Positive control: the admin `sql` UPDATE of the same row still raises the trigger's own message (`/append-only/`) | The trigger error (23001 / P0001), not 42501 |
| V3 | App role DELETE of a `stock_movements` row and of an `attendance_adjustments` row | Each rejects `42501` | The trigger error |
| V4 | App role UPDATE of `attendance_adjustments.superseded_by_adjustment_id` alone (the `markSuperseded` shape) | Succeeds, `count 1` | Green (guard: the kept UPDATE) |
| L1 | The lock needs UPDATE, so the rule is real: as the migrating role (the owner of `journal_entries`), create `t356_probe(id int primary key)` and grant `shareat_app` SELECT only. As `shareat_app`, `select 1 from t356_probe for update` | Rejects `42501`. Positive control: after `GRANT UPDATE`, the same statement succeeds | Green (a Postgres property; it proves why `stock_movements` keeps UPDATE) |
| L2 | The real lock path as the app role: `asOrg`, then `stockLedgerRepo.onHandForUpdate(tx, item, location)` on a seeded item | Returns the on-hand. Inside the same tx, `select current_user` = `shareat_app` | Green (guard). It goes red (42501) if anyone revokes `stock_movements` UPDATE |
| C1 | RI cascade runs as the owner (what the `missed_month_adjustments` DELETE revoke relies on) | In a rolled-back tx, as the migrating role: create `t356_parent(id int pk)` and `t356_child(id int pk, p int references t356_parent on delete cascade)`. Grant `shareat_app` SELECT and DELETE on the parent, REVOKE DELETE on the child, and seed one row in each. As `shareat_app`, DELETE the parent: `count 1`, and the child row is gone | Green (a Postgres property; a guard) |
| D1 | Transfer DISPATCH end to end as the app role: `saveDraft`, then `dispatch(tx, staff, id)` under `asOrg`, as `shareat_test_runner` | `ok: true`. The source location's on-hand drops by the line quantity | Green (guard). Red if `stock_movements` UPDATE is ever revoked |
| D2 | `transferNow` (the other `checkSufficiency` caller, `transfers.ts:89`) as the app role | `ok: true`. The movements are written | Green (guard) |
| E1′ | T-355's E1 with the R3 delta | The six tables match the fixture minus R1's revokes. Every other table matches exactly | The six still hold the revoked privileges |

**The V1 grid** (target; "—" means REVOKEd):

| | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| stock_movements | ✓ | ✓ | ✓ | — |
| attendance_adjustments | ✓ | ✓ | ✓ | — |
| trade_order_messages | ✓ | ✓ | — | — |
| attendance_punches | ✓ | ✓ | — | — |
| etl_source_documents | ✓ | ✓ | — | — |
| missed_month_adjustments | ✓ | ✓ | — | — |

Existing suites stay green UNCHANGED:
- `stock-transfers.test.ts` (it dispatches at `:268`, `:292` and `:321` as the app role), `commissary-transfer.test.ts`
  and the stock-usage / consume suites (child inserts referencing movements, R2);
- `attendance-adjustments.test.ts` (supersede) and `attendance-punches.test.ts`;
- `low-stock.test.ts` (the order thread), `t345-missed-month.test.ts` and `etl-run.test.ts`;
- `stock-ledger.test.ts`, the T-354 and T-355 files (except the ruled E1 edit) and `migration-journal.test.ts`.
- **The full integration suite.** A red here means an app path used a revoked privilege. That is a spec defect:
  report it, and do not re-grant.

## §9.4
0170 changes privileges only, but the one path at risk (the `stock_movements` row lock) is user-facing, so it is
clicked:
1. Apply from zero on a scratch database (ADR-012 §5.8). Record `count(*)` and `max(created_at)` from
   `drizzle.__drizzle_migrations`. Paste `\dp` (or `select relname, relacl from pg_class where relname in (…six…)`)
   for the six tables.
2. Boot the app on 9008, on a database at 0170. **Dispatch a stock transfer** (`/inventory/transfers`: create, then
   dispatch) and screenshot the dispatched state with the source on-hand reduced.
3. On the same app, do one attendance supersede (it keeps UPDATE on `attendance_adjustments`) and post one order-thread
   message (INSERT on `trade_order_messages`). Screenshot both saved states.

## Out of scope
- The nine state-transition history tables (journal, usage, counts, discrepancies, config, days and periods). The app
  legitimately updates their open rows.
- Column-level grants, for example UPDATE on `attendance_adjustments.superseded_by_adjustment_id` only. It is
  possible, but the trigger already pins every other column; this is a separate task if ever wanted.
- Replacing `onHandForUpdate`'s row lock with an advisory lock so that `stock_movements` could lose UPDATE too. It is
  a behaviour change in the stock path and not asked for.
- Anything against production. The deploy applies 0170.

## Done when
- V1, V2, V3 and E1′ go red→green. V4, L1, L2, C1, D1 and D2 stay green, with L1's control shown firing.
- Every suite named above, and the full integration suite, is green unchanged, apart from the ruled E1 edit.
- `migration-journal.test.ts` is green, and 0170 applies from zero. Typecheck is clean. The §9.4 screenshots are
  pasted. The builder edited no test file.
- **Orchestrator:** DEF-489's register row notes T-356's six revokes and the commit.

## Questions for Ian
None. Ian approved the revokes (row 243). This spec narrows `stock_movements` to DELETE only, for the lock reason in R1.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-29)
- **A1 — the FK-check proof names the wrong parent.** `stock_movements` keeps UPDATE, so stock-layer inserts prove
  nothing. The parent that loses UPDATE is `attendance_punches` (referenced by `attendance_days.first_in/last_out_punch_id`,
  `0083:26-27`; self-referenced by `supersedes_punch_id`, `0082:41`). Cite the attendance-days / adjudicate suites (app
  role) and add **C1b**: a parent with SELECT only (no UPDATE) and an app-role INSERT into its child succeeds (count 1).
- **A2 — D1/D2's arming check asserts the target, not the URL.** Inside the same tx, `select current_user` =
  `shareat_app` (L2's target). The `DATABASE_URL` username is a report line only, so a lane run with
  `INTEGRATION_RESTRICTED_ROLE=0` is not falsely failed.
- **A3 — E1′ is exact.** `expected[t] = fixture[t] − delta[t]`, deep-equal, for every table; every delta key exists in
  the fixture and every removed privilege was present in it; `stock_movements`' delta is `[DELETE]` only. No subset or
  "at most" comparison, no filtering the six out.
- **A4 — the 0170 header records that the cutover purge is unaffected:** all six are `class: 'purge'`
  (`cutover/classification.ts`) and `purge.ts:355` TRUNCATEs them; TRUNCATE was never granted to `shareat_app`
  (`0011:68`), so the purge already runs as the owner.

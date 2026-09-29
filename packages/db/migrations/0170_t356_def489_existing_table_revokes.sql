-- 0170 — T-356 / DEF-489 follow-up, bible §13 row 243. Ian said yes (row 243). Replaces T-355's
-- dropped R3 (T-355 "Orchestrator amendments", S1) with the corrected, re-derived revoke.
-- docs/tasks/356-def-489-existing-table-revokes.md.
--
-- T-355 (0169) narrowed the DEFAULT for future tables only. These six existing tables still hold
-- the SELECT/INSERT/UPDATE/DELETE that 0011:68 granted every table at role creation, even though a
-- history-guard trigger (T-354, `packages/db/src/triggers/registry.ts:44-165`) refuses an UPDATE
-- and/or DELETE on every row of each — the privilege is dead weight, and leaves the trigger as the
-- ONLY lock against the app role. REVOKE gives a loud 42501 at the statement, before RLS even runs,
-- and adds a third, independent lock (privilege, then RLS, then trigger), per §15.11 — the same
-- pattern T-354 R4 set on `audit_log` (0168:75).
--
-- ⛔ **`stock_movements` keeps UPDATE — every other table here loses it.** Postgres requires UPDATE
-- privilege for `SELECT … FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE`, and
-- `onHandForUpdate` (`repo/stock-ledger.ts:86-91`) row-locks `stock_movements` with `FOR UPDATE`.
-- Its only caller is `checkSufficiency` (`domain/stock/transfers.ts:74`), which runs as `shareat_app`
-- inside both `transferNow` (`:89`) and `dispatch` (`:185`) — T-355's original draft (R3) revoked
-- this table's UPDATE too and would have 42501'd every transfer dispatch. `attendance_adjustments`
-- keeps UPDATE for the same shape of reason: `markSuperseded` (`repo/attendance-adjustments.ts:108-113`)
-- is a legitimate app-role UPDATE the trigger itself permits.
--
-- ⛔ **RI checks and cascades run as the table OWNER, not the invoking role** — so none of these six
-- REVOKEs breaks a child insert or a cascade. `attendance_punches` is referenced by
-- `attendance_days.first_in_punch_id`/`last_out_punch_id` (0083:26-27) and self-referenced by
-- `supersedes_punch_id` (0082:41); `missed_month_adjustments` is removed only by an FK cascade
-- (0161:199-211), which the parent's owner runs regardless of the app role's own DELETE privilege.
--
-- ⚠️ **The cutover purge is unaffected.** All six are `class: 'purge'`
-- (`packages/db/src/cutover/classification.ts`) and `packages/db/src/cutover/purge.ts:355`
-- TRUNCATEs them — TRUNCATE was never granted to `shareat_app` (0011:68 grants SIUD only), so the
-- purge already runs as the table owner and this migration changes nothing about it.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired; it cannot emit `REVOKE`. Every
-- statement below is its own breakpoint, except the last, which is the last statement in the file.
--
-- | Table | App writes | App row locks | Revoke |
-- |---|---|---|---|
-- | stock_movements | none | YES: onHandForUpdate FOR UPDATE (repo/stock-ledger.ts:86-91) | DELETE only |
-- | trade_order_messages | none | none | UPDATE, DELETE |
-- | attendance_punches | none | none | UPDATE, DELETE |
-- | etl_source_documents | none (onConflictDoNothing, systemTransaction) | none | UPDATE, DELETE |
-- | missed_month_adjustments | none (FK cascade only, runs as owner) | none | UPDATE, DELETE |
-- | attendance_adjustments | UPDATE: markSuperseded | none | DELETE only |

REVOKE DELETE ON "stock_movements" FROM "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "trade_order_messages" FROM "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "attendance_punches" FROM "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "etl_source_documents" FROM "shareat_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "missed_month_adjustments" FROM "shareat_app";
--> statement-breakpoint
REVOKE DELETE ON "attendance_adjustments" FROM "shareat_app";

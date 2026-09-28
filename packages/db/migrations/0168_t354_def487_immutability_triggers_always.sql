-- 0168 — T-354 / DEF-487, bible §13 row 241. Ian, 2026-09-28: "yes fix def 487 before launch".
-- docs/tasks/354-def-487-immutability-triggers-always.md.
--
-- ⛔ THE DEFECT, MEASURED. Every trigger in this database was created plain (`tgenabled = 'O'`),
-- origin mode. An `'O'` trigger does not fire while `session_replication_role = 'replica'` — the
-- mode logical-replication apply workers run in, and the usual hand-rolled-bulk-load trick ("turn
-- off FKs and triggers"). The auditor proved it: a superuser `DELETE FROM audit_log` inside
-- `SET LOCAL session_replication_role = 'replica'` removed the row; the same DELETE outside replica
-- mode raises 23001 (the append-only trigger). Every history-guard trigger in this schema — the
-- ones whose only job is refusing a rewrite or erase of a row that is already posted, frozen,
-- committed, resolved, voided, or append-only — had this same silent bypass.
--
-- **The fix is `ALTER TABLE ... ENABLE ALWAYS TRIGGER ...`** on exactly those 18 triggers
-- (`packages/db/src/triggers/registry.ts` is the one classification of all 57 non-internal
-- triggers in this schema; a live guard fails the build if a trigger is unclassified or its live
-- `tgenabled` disagrees with its class). The other 39 stay origin (`'O'`), deliberately:
--   - 11 are DERIVATION triggers (mirror-outbox enqueuers, foundation-account seeding, opening-date
--     propagation, fixed-asset in-service fill, person_grants store fill) — a replay or restore
--     must NOT re-run these, or a restored row's derived state could be recomputed differently, or
--     Firestore mirror writes could be re-enqueued.
--   - 28 are VALIDATORS of new data against other rows' CURRENT state or the clock (period-open
--     checks, balance checks, slab/unit guards, single-active-session guards, and so on) — reloading
--     a genuine historic row after its period closed or an account was archived would fail them.
--     New invalid rows written in replica mode is a residual risk this migration does not close
--     (task doc, "Out of scope": a writer who can set replica mode is an owner/superuser who can
--     already `ALTER TABLE`).
--
-- ⚠️ **What `ENABLE ALWAYS` does and does not do.** It closes the replica-mode bypass (this
-- migration's whole point) and it SURVIVES a `pg_dump`/`pg_restore` — a full backup restores with
-- the same `ENABLE ALWAYS` state, so the protection is not lost on restore. It does NOT stop an
-- explicit `ALTER TABLE ... DISABLE TRIGGER` by a table owner or superuser (a visible DDL act, and
-- `pg_restore --disable-triggers` legitimately needs exactly this for a data-only restore into an
-- already-populated database — see `docs/ops/README.md`'s new note). Nothing in this codebase uses
-- `session_replication_role` or `DISABLE TRIGGER` (grepped, whole tree) — this migration only
-- closes an unused-but-reachable door.
--
-- **This is the tree's first REVOKE** (R4). `audit_log`'s FORCE RLS ships zero UPDATE/DELETE
-- policies (0167), so the app role's UPDATE or DELETE already touches 0 rows — but SILENTLY: no
-- error, just nothing changed, which reads exactly like "already up to date" instead of "refused".
-- The alternative — a permissive `USING (true)` or org-scoped UPDATE/DELETE policy that always
-- refuses — was rejected: it would make the trigger the ONLY lock left for the app role (bible
-- §15.11: no layer may be the sole lock for a given risk), and a `USING (true)` policy would let one
-- org probe another org's row ids by the shape of the error it gets back. `REVOKE UPDATE, DELETE ON
-- audit_log FROM shareat_app` is loud (42501 `insufficient_privilege`, at the STATEMENT, before RLS
-- even runs) and adds a third, independent lock: privilege, then RLS, then trigger. Measured:
-- nothing else re-grants these — 0011's `GRANT ... ON ALL TABLES` ran once at role creation,
-- `provision.sh`/`provision-test-role.mjs` grant no table privileges, and `repo/audit-log.ts` only
-- ever INSERTs.
--
-- No DO blocks and no data changes (R6: 0167's own pre-flight guard is applied and stays unedited —
-- RULES §1 rule 9 — even though it is blind for a migrator without BYPASSRLS; the lesson is
-- recorded there for the next migration to heed, not fixed by touching an applied file).
--
-- HAND-WRITTEN, per ADR-012 §5 (packages/db/migrations/README.md) — `drizzle-kit generate` is
-- retired; it cannot emit `ENABLE ALWAYS` or `REVOKE`. Every statement below is its own breakpoint.

ALTER TABLE "journal_entries" ENABLE ALWAYS TRIGGER "journal_entries_posted_immutable";--> statement-breakpoint
ALTER TABLE "journal_lines" ENABLE ALWAYS TRIGGER "journal_lines_posted_immutable";--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE ALWAYS TRIGGER "stock_movements_append_only_trg";--> statement-breakpoint
ALTER TABLE "stock_usage_records" ENABLE ALWAYS TRIGGER "stock_usage_posted_immutable_trg";--> statement-breakpoint
ALTER TABLE "stock_usage_records" ENABLE ALWAYS TRIGGER "stock_usage_void_terminal_trg";--> statement-breakpoint
ALTER TABLE "count_sessions" ENABLE ALWAYS TRIGGER "count_sessions_commit_once_trg";--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ENABLE ALWAYS TRIGGER "trade_discrepancies_defer_once_trg";--> statement-breakpoint
ALTER TABLE "trade_discrepancies" ENABLE ALWAYS TRIGGER "trade_discrepancies_resolution_terminal_trg";--> statement-breakpoint
ALTER TABLE "trade_order_messages" ENABLE ALWAYS TRIGGER "trade_order_messages_append_only_trg";--> statement-breakpoint
ALTER TABLE "store_attendance_config" ENABLE ALWAYS TRIGGER "store_attendance_config_immutable";--> statement-breakpoint
ALTER TABLE "attendance_punches" ENABLE ALWAYS TRIGGER "attendance_punches_append_only";--> statement-breakpoint
ALTER TABLE "attendance_days" ENABLE ALWAYS TRIGGER "attendance_days_frozen_immutable";--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ENABLE ALWAYS TRIGGER "attendance_adjustments_append_only";--> statement-breakpoint
ALTER TABLE "etl_source_documents" ENABLE ALWAYS TRIGGER "etl_source_documents_immutable";--> statement-breakpoint
ALTER TABLE "fiscal_periods" ENABLE ALWAYS TRIGGER "fiscal_periods_fill_immutable_trg";--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ENABLE ALWAYS TRIGGER "missed_month_adjustments_no_update_trg";--> statement-breakpoint
ALTER TABLE "missed_month_adjustments" ENABLE ALWAYS TRIGGER "missed_month_adjustments_no_direct_delete_trg";--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ALWAYS TRIGGER "audit_log_append_only";--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM "shareat_app";

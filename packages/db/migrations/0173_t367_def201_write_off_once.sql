-- 0173 — T-367 S1 / DEF-201 (+DEF-517, DEF-520), docs/tasks/367-ap-ar-money.md §S1, R2.
--
-- The database backstop for DEF-201: one write-off decision makes exactly one `ar_write_offs` row.
-- `writeOffCharge` already retries an idempotent double-click through its own idempotency-key
-- lookup before this ships (R1); this unique index is the second layer (bible §15.11) for every
-- OTHER writer — raw SQL, the ETL, a future repo helper — so a second subledger row against the
-- same journal entry can never land no matter what wrote it.
--
-- Production precheck P1 (`select journal_entry_id, count(*) from ar_write_offs group by 1 having
-- count(*) > 1`) must be 0 rows before this applies; any row is a live duplicate and stops the
-- deploy (Ian's Q6). Checked 0 on the lane test database and `shareat_dev` at build.
--
-- No new table: classification and RLS registries are unchanged. `ar_write_offs` keeps the
-- table-level grants it already has.
--
-- HAND-WRITTEN, per ADR-012 §5 — `drizzle-kit generate` is retired.

CREATE UNIQUE INDEX "ar_write_offs_journal_entry_unique" ON "ar_write_offs" USING btree ("journal_entry_id");

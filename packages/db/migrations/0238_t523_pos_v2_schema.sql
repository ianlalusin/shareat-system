-- 0238 -- T-523: POS v2 schema. docs/tasks/523-pos-v2-schema.md R1-R13 (R13 = planner ruling 6 Nov, per-line discounts; + "Rulings on the tester's questions", "Ruled since the first draft"); bible rows 430, 431, 435, 436, 437.
-- Hand-authored per ADR-012 s5. Journal head when written: 0236 (0237 is T-511 S5c); `when` recomputed from the head on the one-day grid.
--
-- WHY. Ian, 6 Nov: "pos is a piece of erp", "no firebase db now"; Lipa runs the new POS on 7 Dec (row 431). Every floor record (sessions, bill lines, kitchen
-- tickets, receipts, Z readings) lived in Firestore. This migration creates the fourteen tables release 1 needs and nothing else. It is INERT: nothing reads or writes
-- them until a store's switch (pos_stores.mode) is turned on (row 435), so it may apply to production before T-524 merges.
--
-- THE TABLES (the order of the spec):
--   R1  pos_stores                    per-store switch (off | test | live) and the polling counter. keep.
--   R2  pos_stands                    a store's fixed stand set. keep.
--   R3  pos_terminals                 the stable receipt-number identity (survives a replaced tablet). keep.
--   R4  table_sessions                a seated party or a take-out order. purge (row 379/436).
--   R5  table_session_lines           what was ordered, kitchen state, refills. purge.
--   R6  pos_sales_receipts            the sales receipt, immutable. NOT pos_bridge_receipts (the read-only v1 copy). purge.
--   R7  pos_sales_receipt_lines       frozen copy of what was billed, append-only. purge.
--   R8  pos_sales_receipt_payments    tender lines. purge.
--   R9  pos_day_closes / pos_day_close_tenders   the Z (row 390), append-only. purge.
--   R10 pos_events                    the outbox inbox, UNIQUE (pairing_id, seq). purge.
--   R11 sales_days                    learns its third source 'pos_receipts' (drop/re-add the CHECK, the 0209 pattern) + pos_day_close_id.
--   R12 statutory_discount_records_live_invoice_key is replaced so two seniors on one bill are two rows (one live row per CARD per bill).
--   R13 (planner ruling 6 Nov, v1-style itemised bill, a discount covers N units of one line): pos_discount_presets (keep), table_session_line_discounts (purge),
--       pos_sales_receipt_line_discounts (purge, append-only; replaces the first draft's per-diner pos_sales_receipt_discounts; NO holder name or id number, row 353);
--       pos_sales_receipt_lines carries gross / discount_total / net instead of amount. A senior's own head is 1 unit of the package line.
--
-- WHAT THE DATABASE ENFORCES (tests: packages/db/tests/integration/t523-pos-v2-schema.test.ts):
--   * one open session per stand (partial unique); dine_in iff a stand; void shape; heads bounds.
--   * UNIQUE (terminal_id, receipt_seq); one sales receipt per session; (pairing_id, seq) unique so a replay is a silent no-op for the domain.
--   * TRIGGERS, all history_guard / ENABLE ALWAYS (triggers/registry.ts), all SET search_path = public, pg_temp, EXECUTE revoked from PUBLIC:
--       table_sessions_forward_only   open -> paid | voided only (23514 check_violation); id / org / store / stand / mode / opened_* frozen (23001).
--       table_session_lines_guard     INSERT into a paid or voided session refused (23001); UPDATE: kitchen_status queued -> served | cancelled once (23514),
--                                     everything but kitchen_status / served_at_device / served_by frozen, served_* frozen once the line is final (23001).
--       table_session_line_discounts_guard   INSERT on a paid / voided session's line refused (23001); active -> removed only (23514); other columns frozen, removal once (23001).
--       pos_sales_receipts_frozen, pos_sales_receipt_payments_frozen, pos_events_frozen   (one shared function pos_v2_frozen_except_once):
--                                     every column frozen, except the columns named in the trigger's arguments, which may go NULL -> value ONCE (23001);
--                                     DELETE refused. It compares whole rows through to_jsonb, so a column added later is frozen without editing the function.
--       pos_sales_receipt_lines / pos_day_closes / pos_day_close_tenders / pos_sales_receipt_line_discounts _append_only   (one shared function): UPDATE and DELETE refused (23001).
--   * Errors follow pay_rates_append_only (0221): 23001 restrict_violation for a frozen / once-only / append-only write, 23514 for a refused status transition.
--   * Money is numeric(14,2). Device times are *_at_device; server times are *_at DEFAULT now(). A business day never comes from a device clock.
--   * Same-org composite FKs on every person / store / menu / tender / pairing / statutory reference (DEF-491 census), single-column twins beside them. A reference whose
--     parent is store-scoped uses the (store_id, x) composite instead (a stand, a session, a terminal, a kitchen station): it carries the store AND, through
--     (org_id, store_id) -> stores, the org, and has no single-column FK (so the census has nothing to twin).
--   * Three parent uniques are added on EXISTING tables so the twins and composites have a target (ruling 3/4; trivially true, id alone is unique):
--       pos_tablet_pairings (store_id, id)   kitchen_stations (store_id, id)   statutory_discount_records (org_id, id)   (+ pos_day_closes (store_id, id), a new table).
--   * Every pairing reference (terminal, session, line, event) and the receipt's day close is a (store_id, x) composite, not a single FK + twin: it cannot name another store's tablet or Z.
--
-- NOT IN THIS SLICE (T-524 domain, T-534, T-535): that discount_total equals the sum of the discount rows, that a payment's tender is of the sales receipt's store,
-- that change is given from cash only, the mode audit, the state_version bump, refunds, preset discounts. A CHECK cannot see a child row or a tender's kind.
--
-- R7 note: the spec gives the receipt line no list or sign checks beyond gross = qty * unit_price and net = gross - discount_total. Because the line is the FROZEN COPY of an R5 line, it repeats R5's
-- three (kind in package | item | refill, qty > 0, unit_price >= 0) so a copy can never be a shape the source could not be.
--
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on all fourteen; column-level UPDATE only where the spec names columns; never DELETE, never table-level UPDATE.
-- RLS: ENABLE + FORCE, one <t>_org_isolation policy through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- CUTOVER: R1-R3 and R13 pos_discount_presets keep; R4-R10 and the two R13 discount tables purge (row 436: v1 receives Lipa's December day totals through T-531's bridge, so no booked figure lives only here). The purge TRUNCATEs
-- in one statement, which fires no row trigger.
--
-- LOCK BUDGET (ADR-012 s5). First statement SET LOCAL lock_timeout = '5s'. Fourteen new empty tables: their FKs scan nothing. The statements touching existing tables
-- are brief: SHARE ROW EXCLUSIVE for the FKs (stores, persons, menu_items, menu_item_variants, tenders, organizations, kitchen_stations, pos_tablet_pairings,
-- statutory_discount_records), three UNIQUE constraints (build a unique index on a tiny table), and on sales_days one ADD COLUMN (nullable, no rewrite), the CHECK
-- drop/re-add and the new CHECK (each validates sales_days once; the table has a few hundred rows). No backfill. Every statement is its own breakpoint; the last closes the file.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- parent uniques on existing tables (trivially true; they exist so the composites and twins have a unique target)
ALTER TABLE "pos_tablet_pairings" ADD CONSTRAINT "pos_tablet_pairings_store_id_id_unique" UNIQUE ("store_id","id");
--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_store_id_id_unique" UNIQUE ("store_id","id");
--> statement-breakpoint
ALTER TABLE "statutory_discount_records" ADD CONSTRAINT "statutory_discount_records_org_id_id_unique" UNIQUE ("org_id","id");
--> statement-breakpoint

-- R1
CREATE TABLE "pos_stores" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"live_from" date,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_stores_store_id_unique" UNIQUE ("store_id"),
	CONSTRAINT "pos_stores_mode_check" CHECK ("mode" IN ('off','test','live')),
	CONSTRAINT "pos_stores_live_from_check" CHECK (("mode" = 'live') = ("live_from" IS NOT NULL)),
	CONSTRAINT "pos_stores_state_version_check" CHECK ("state_version" >= 0)
);
--> statement-breakpoint

-- R2
CREATE TABLE "pos_stands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"number" smallint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pos_stands_store_number_unique" UNIQUE ("store_id","number"),
	CONSTRAINT "pos_stands_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_stands_number_check" CHECK ("number" BETWEEN 1 AND 999),
	CONSTRAINT "pos_stands_status_check" CHECK ("status" IN ('active','retired'))
);
--> statement-breakpoint

-- R3
CREATE TABLE "pos_terminals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_no" smallint NOT NULL,
	"pairing_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pos_terminals_store_terminal_no_unique" UNIQUE ("store_id","terminal_no"),
	CONSTRAINT "pos_terminals_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_terminals_terminal_no_check" CHECK ("terminal_no" BETWEEN 1 AND 99)
);
--> statement-breakpoint

-- R4
CREATE TABLE "table_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"stand_id" uuid,
	"mode" text NOT NULL,
	"heads_cashier" integer NOT NULL,
	"heads_server" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at_device" timestamp with time zone NOT NULL,
	"opened_on_pairing_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_by" uuid,
	"voided_at_device" timestamp with time zone,
	"void_reason" text,
	"voided_offline" boolean DEFAULT false NOT NULL,
	CONSTRAINT "table_sessions_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "table_sessions_mode_check" CHECK ("mode" IN ('dine_in','take_out')),
	CONSTRAINT "table_sessions_stand_mode_check" CHECK (("mode" = 'dine_in') = ("stand_id" IS NOT NULL)),
	CONSTRAINT "table_sessions_heads_cashier_check" CHECK ("heads_cashier" BETWEEN 0 AND 200),
	CONSTRAINT "table_sessions_dine_in_heads_check" CHECK ("mode" = 'take_out' OR "heads_cashier" >= 1),
	CONSTRAINT "table_sessions_heads_server_check" CHECK ("heads_server" BETWEEN 1 AND 200),
	CONSTRAINT "table_sessions_status_check" CHECK ("status" IN ('open','paid','voided')),
	CONSTRAINT "table_sessions_void_shape_check" CHECK (("status" = 'voided') = ("voided_by" IS NOT NULL AND "void_reason" IS NOT NULL AND length(trim("void_reason")) > 0)),
	CONSTRAINT "table_sessions_voided_offline_check" CHECK ("voided_offline" = false OR "status" = 'voided')
);
--> statement-breakpoint

-- R5
CREATE TABLE "table_session_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"menu_item_variant_id" uuid,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" numeric(14,2) NOT NULL,
	"kitchen_station_id" uuid,
	"kitchen_status" text DEFAULT 'queued' NOT NULL,
	"served_at_device" timestamp with time zone,
	"served_by" uuid,
	"note" text,
	"added_by" uuid NOT NULL,
	"added_on_pairing_id" uuid,
	"added_at_device" timestamp with time zone NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_session_lines_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "table_session_lines_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "table_session_lines_kind_check" CHECK ("kind" IN ('package','item','refill')),
	CONSTRAINT "table_session_lines_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "table_session_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "table_session_lines_refill_free_check" CHECK ("kind" <> 'refill' OR "unit_price" = 0),
	CONSTRAINT "table_session_lines_kitchen_status_check" CHECK ("kitchen_status" IN ('queued','served','cancelled')),
	CONSTRAINT "table_session_lines_served_shape_check" CHECK (("kitchen_status" = 'served') = ("served_at_device" IS NOT NULL)),
	CONSTRAINT "table_session_lines_note_check" CHECK (length("note") <= 200),
	CONSTRAINT "table_session_lines_unit_price_finite_check" CHECK ("unit_price" > '-Infinity'::numeric AND "unit_price" < 'Infinity'::numeric)
);
--> statement-breakpoint
-- R13: store discount presets (planner ruling 6 Nov: v1-style discount per item line). keep.
CREATE TABLE "pos_discount_presets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value_type" text NOT NULL,
	"value" numeric(14,2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "pos_discount_presets_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_discount_presets_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_discount_presets_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 40),
	CONSTRAINT "pos_discount_presets_value_type_check" CHECK ("value_type" IN ('percent','fixed')),
	CONSTRAINT "pos_discount_presets_value_check" CHECK ("value" > 0),
	CONSTRAINT "pos_discount_presets_percent_max_check" CHECK ("value_type" <> 'percent' OR "value" <= 100),
	CONSTRAINT "pos_discount_presets_status_check" CHECK ("status" IN ('active','retired')),
	CONSTRAINT "pos_discount_presets_value_finite_check" CHECK ("value" > '-Infinity'::numeric AND "value" < 'Infinity'::numeric)
);
--> statement-breakpoint
-- R13: a discount on one session line, covering qty units of it (v1: "a discount covers N units of one line"). purge.
CREATE TABLE "table_session_line_discounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"session_line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"preset_id" uuid,
	"value_type" text NOT NULL,
	"value" numeric(14,2) NOT NULL,
	"qty" integer NOT NULL,
	"diner_no" smallint,
	"applied_by" uuid NOT NULL,
	"applied_at_device" timestamp with time zone NOT NULL,
	"approved_by" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"removed_by" uuid,
	"removed_at_device" timestamp with time zone,
	CONSTRAINT "table_session_line_discounts_kind_check" CHECK ("kind" IN ('senior','pwd','preset','custom')),
	CONSTRAINT "table_session_line_discounts_preset_kind_check" CHECK (("kind" = 'preset') = ("preset_id" IS NOT NULL)),
	CONSTRAINT "table_session_line_discounts_value_type_check" CHECK ("value_type" IN ('percent','fixed')),
	CONSTRAINT "table_session_line_discounts_value_check" CHECK ("value" > 0),
	CONSTRAINT "table_session_line_discounts_percent_max_check" CHECK ("value_type" <> 'percent' OR "value" <= 100),
	CONSTRAINT "table_session_line_discounts_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "table_session_line_discounts_diner_no_check" CHECK ("diner_no" BETWEEN 1 AND 200),
	CONSTRAINT "table_session_line_discounts_statutory_diner_check" CHECK (("kind" IN ('senior','pwd')) = ("diner_no" IS NOT NULL)),
	CONSTRAINT "table_session_line_discounts_status_check" CHECK ("status" IN ('active','removed')),
	CONSTRAINT "table_session_line_discounts_removed_shape_check" CHECK (("status" = 'removed') = ("removed_by" IS NOT NULL)),
	CONSTRAINT "table_session_line_discounts_value_finite_check" CHECK ("value" > '-Infinity'::numeric AND "value" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R9 first: R6 and R11 point at it
CREATE TABLE "pos_day_closes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"z_no" integer NOT NULL,
	"business_date" date NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"receipt_count" integer NOT NULL,
	"gross_total" numeric(14,2) NOT NULL,
	"closed_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_day_closes_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_day_closes_store_id_id_unique" UNIQUE ("store_id","id"),
	CONSTRAINT "pos_day_closes_terminal_z_no_unique" UNIQUE ("terminal_id","z_no"),
	CONSTRAINT "pos_day_closes_store_date_terminal_unique" UNIQUE ("store_id","business_date","terminal_id"),
	CONSTRAINT "pos_day_closes_z_no_check" CHECK ("z_no" > 0),
	CONSTRAINT "pos_day_closes_window_check" CHECK ("window_end" > "window_start"),
	CONSTRAINT "pos_day_closes_receipt_count_check" CHECK ("receipt_count" >= 0),
	CONSTRAINT "pos_day_closes_gross_total_check" CHECK ("gross_total" >= 0),
	CONSTRAINT "pos_day_closes_gross_total_finite_check" CHECK ("gross_total" > '-Infinity'::numeric AND "gross_total" < 'Infinity'::numeric)
);
--> statement-breakpoint
CREATE TABLE "pos_day_close_tenders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"day_close_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	CONSTRAINT "pos_day_close_tenders_day_close_tender_unique" UNIQUE ("day_close_id","tender_id"),
	CONSTRAINT "pos_day_close_tenders_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R6
CREATE TABLE "pos_sales_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"receipt_seq" integer NOT NULL,
	"table_session_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"issued_at_device" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subtotal" numeric(14,2) NOT NULL,
	"discount_total" numeric(14,2) DEFAULT 0 NOT NULL,
	"total" numeric(14,2) NOT NULL,
	"device_total" numeric(14,2) NOT NULL,
	"offline" boolean NOT NULL,
	"day_close_id" uuid,
	CONSTRAINT "pos_sales_receipts_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_sales_receipts_terminal_seq_unique" UNIQUE ("terminal_id","receipt_seq"),
	CONSTRAINT "pos_sales_receipts_table_session_unique" UNIQUE ("table_session_id"),
	CONSTRAINT "pos_sales_receipts_receipt_seq_check" CHECK ("receipt_seq" > 0),
	CONSTRAINT "pos_sales_receipts_discount_total_check" CHECK ("discount_total" >= 0),
	CONSTRAINT "pos_sales_receipts_total_check" CHECK ("total" >= 0),
	CONSTRAINT "pos_sales_receipts_total_identity_check" CHECK ("total" = "subtotal" - "discount_total"),
	CONSTRAINT "pos_sales_receipts_subtotal_finite_check" CHECK ("subtotal" > '-Infinity'::numeric AND "subtotal" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipts_discount_total_finite_check" CHECK ("discount_total" > '-Infinity'::numeric AND "discount_total" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipts_total_finite_check" CHECK ("total" > '-Infinity'::numeric AND "total" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipts_device_total_finite_check" CHECK ("device_total" > '-Infinity'::numeric AND "device_total" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R7
CREATE TABLE "pos_sales_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"session_line_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price" numeric(14,2) NOT NULL,
	"gross" numeric(14,2) NOT NULL,
	"discount_total" numeric(14,2) DEFAULT 0 NOT NULL,
	"net" numeric(14,2) NOT NULL,
	CONSTRAINT "pos_sales_receipt_lines_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "pos_sales_receipt_lines_receipt_line_no_unique" UNIQUE ("receipt_id","line_no"),
	CONSTRAINT "pos_sales_receipt_lines_kind_check" CHECK ("kind" IN ('package','item','refill')),
	CONSTRAINT "pos_sales_receipt_lines_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "pos_sales_receipt_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "pos_sales_receipt_lines_gross_check" CHECK ("gross" = "qty" * "unit_price"),
	CONSTRAINT "pos_sales_receipt_lines_discount_total_check" CHECK ("discount_total" >= 0),
	CONSTRAINT "pos_sales_receipt_lines_discount_within_gross_check" CHECK ("discount_total" <= "gross"),
	CONSTRAINT "pos_sales_receipt_lines_net_check" CHECK ("net" = "gross" - "discount_total"),
	CONSTRAINT "pos_sales_receipt_lines_unit_price_finite_check" CHECK ("unit_price" > '-Infinity'::numeric AND "unit_price" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_lines_gross_finite_check" CHECK ("gross" > '-Infinity'::numeric AND "gross" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_lines_discount_total_finite_check" CHECK ("discount_total" > '-Infinity'::numeric AND "discount_total" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_lines_net_finite_check" CHECK ("net" > '-Infinity'::numeric AND "net" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R8
CREATE TABLE "pos_sales_receipt_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"change_given" numeric(14,2) DEFAULT 0 NOT NULL,
	"reference_no" text,
	"to_check" boolean DEFAULT false NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone,
	CONSTRAINT "pos_sales_receipt_payments_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "pos_sales_receipt_payments_change_given_check" CHECK ("change_given" >= 0),
	CONSTRAINT "pos_sales_receipt_payments_reference_no_check" CHECK (length("reference_no") BETWEEN 4 AND 40),
	CONSTRAINT "pos_sales_receipt_payments_to_check_reference_check" CHECK (NOT "to_check" OR "reference_no" IS NOT NULL),
	CONSTRAINT "pos_sales_receipt_payments_checked_pair_check" CHECK (("checked_at" IS NULL) = ("checked_by" IS NULL)),
	CONSTRAINT "pos_sales_receipt_payments_checked_needs_to_check_check" CHECK ("checked_at" IS NULL OR "to_check"),
	CONSTRAINT "pos_sales_receipt_payments_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_payments_change_given_finite_check" CHECK ("change_given" > '-Infinity'::numeric AND "change_given" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R10
CREATE TABLE "pos_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pairing_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"person_id" uuid,
	"occurred_at_device" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "pos_events_pairing_seq_unique" UNIQUE ("pairing_id","seq"),
	CONSTRAINT "pos_events_seq_check" CHECK ("seq" > 0),
	CONSTRAINT "pos_events_kind_check" CHECK ("kind" ~ '^[a-z]+(\.[a-z_]+)+$'),
	CONSTRAINT "pos_events_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
	CONSTRAINT "pos_events_status_check" CHECK ("status" IN ('applied','quarantined')),
	CONSTRAINT "pos_events_error_check" CHECK (("status" = 'quarantined') = ("error" IS NOT NULL)),
	CONSTRAINT "pos_events_resolution_check" CHECK ("resolution" IN ('replayed','discarded')),
	CONSTRAINT "pos_events_resolved_shape_check" CHECK (("resolved_at" IS NULL) = ("resolved_by" IS NULL) AND ("resolved_at" IS NULL) = ("resolution" IS NULL)),
	CONSTRAINT "pos_events_resolved_needs_quarantine_check" CHECK ("resolved_at" IS NULL OR "status" = 'quarantined')
);
--> statement-breakpoint
-- R13 (replaces the first draft's R12 per-diner table): a discount on one frozen receipt line. Append-only. purge.
-- No holder name or id number here (row 353); no UNIQUE on statutory_record_id: one statutory row per diner is pointed to by several line discounts.
CREATE TABLE "pos_sales_receipt_line_discounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"receipt_line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"preset_id" uuid,
	"label" text NOT NULL,
	"value_type" text NOT NULL,
	"value" numeric(14,2) NOT NULL,
	"qty" integer NOT NULL,
	"diner_no" smallint,
	"vat_removed" numeric(14,2) DEFAULT 0 NOT NULL,
	"discount_amount" numeric(14,2) NOT NULL,
	"statutory_record_id" uuid,
	CONSTRAINT "pos_sales_receipt_line_discounts_kind_check" CHECK ("kind" IN ('senior','pwd','preset','custom')),
	CONSTRAINT "pos_sales_receipt_line_discounts_preset_kind_check" CHECK (("kind" = 'preset') = ("preset_id" IS NOT NULL)),
	CONSTRAINT "pos_sales_receipt_line_discounts_value_type_check" CHECK ("value_type" IN ('percent','fixed')),
	CONSTRAINT "pos_sales_receipt_line_discounts_value_check" CHECK ("value" > 0),
	CONSTRAINT "pos_sales_receipt_line_discounts_percent_max_check" CHECK ("value_type" <> 'percent' OR "value" <= 100),
	CONSTRAINT "pos_sales_receipt_line_discounts_qty_check" CHECK ("qty" > 0),
	CONSTRAINT "pos_sales_receipt_line_discounts_diner_no_check" CHECK ("diner_no" BETWEEN 1 AND 200),
	CONSTRAINT "pos_sales_receipt_line_discounts_vat_removed_check" CHECK ("vat_removed" >= 0),
	CONSTRAINT "pos_sales_receipt_line_discounts_vat_statutory_only_check" CHECK ("kind" IN ('senior','pwd') OR "vat_removed" = 0),
	CONSTRAINT "pos_sales_receipt_line_discounts_discount_amount_check" CHECK ("discount_amount" > 0),
	CONSTRAINT "pos_sales_receipt_line_discounts_statutory_record_check" CHECK (("kind" IN ('senior','pwd')) = ("statutory_record_id" IS NOT NULL)),
	CONSTRAINT "pos_sales_receipt_line_discounts_value_finite_check" CHECK ("value" > '-Infinity'::numeric AND "value" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_line_discounts_vat_removed_finite_check" CHECK ("vat_removed" > '-Infinity'::numeric AND "vat_removed" < 'Infinity'::numeric),
	CONSTRAINT "pos_sales_receipt_line_discounts_discount_amount_finite_check" CHECK ("discount_amount" > '-Infinity'::numeric AND "discount_amount" < 'Infinity'::numeric)
);
--> statement-breakpoint

-- R11: the new column first, so its FK below has something to point from
ALTER TABLE "sales_days" ADD COLUMN "pos_day_close_id" uuid;
--> statement-breakpoint
-- pos_stores
ALTER TABLE "pos_stores" ADD CONSTRAINT "pos_stores_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stores" ADD CONSTRAINT "pos_stores_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stores" ADD CONSTRAINT "pos_stores_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stores" ADD CONSTRAINT "pos_stores_changed_by_fk"
	FOREIGN KEY ("changed_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stores" ADD CONSTRAINT "pos_stores_changed_by_same_org_fk"
	FOREIGN KEY ("org_id","changed_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_stands
ALTER TABLE "pos_stands" ADD CONSTRAINT "pos_stands_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stands" ADD CONSTRAINT "pos_stands_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stands" ADD CONSTRAINT "pos_stands_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stands" ADD CONSTRAINT "pos_stands_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_stands" ADD CONSTRAINT "pos_stands_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_terminals
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_pairing_same_store_fk"
	FOREIGN KEY ("store_id","pairing_id") REFERENCES "pos_tablet_pairings"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- table_sessions
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_opened_by_fk"
	FOREIGN KEY ("opened_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_opened_by_same_org_fk"
	FOREIGN KEY ("org_id","opened_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_voided_by_fk"
	FOREIGN KEY ("voided_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_voided_by_same_org_fk"
	FOREIGN KEY ("org_id","voided_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_opened_on_pairing_same_store_fk"
	FOREIGN KEY ("store_id","opened_on_pairing_id") REFERENCES "pos_tablet_pairings"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_sessions" ADD CONSTRAINT "table_sessions_stand_same_store_fk"
	FOREIGN KEY ("store_id","stand_id") REFERENCES "pos_stands"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- table_session_lines
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_served_by_fk"
	FOREIGN KEY ("served_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_served_by_same_org_fk"
	FOREIGN KEY ("org_id","served_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_added_by_fk"
	FOREIGN KEY ("added_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_added_by_same_org_fk"
	FOREIGN KEY ("org_id","added_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_added_on_pairing_same_store_fk"
	FOREIGN KEY ("store_id","added_on_pairing_id") REFERENCES "pos_tablet_pairings"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_menu_item_id_fk"
	FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_menu_item_id_same_org_fk"
	FOREIGN KEY ("org_id","menu_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_menu_item_variant_id_fk"
	FOREIGN KEY ("menu_item_variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_menu_item_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","menu_item_variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_session_same_store_fk"
	FOREIGN KEY ("store_id","session_id") REFERENCES "table_sessions"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ADD CONSTRAINT "table_session_lines_kitchen_station_same_store_fk"
	FOREIGN KEY ("store_id","kitchen_station_id") REFERENCES "kitchen_stations"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_sales_receipts
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_cashier_id_fk"
	FOREIGN KEY ("cashier_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_cashier_id_same_org_fk"
	FOREIGN KEY ("org_id","cashier_id") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_day_close_same_store_fk"
	FOREIGN KEY ("store_id","day_close_id") REFERENCES "pos_day_closes"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_terminal_same_store_fk"
	FOREIGN KEY ("store_id","terminal_id") REFERENCES "pos_terminals"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ADD CONSTRAINT "pos_sales_receipts_table_session_same_store_fk"
	FOREIGN KEY ("store_id","table_session_id") REFERENCES "table_sessions"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_sales_receipt_lines
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_receipt_id_fk"
	FOREIGN KEY ("receipt_id") REFERENCES "pos_sales_receipts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_receipt_id_same_org_fk"
	FOREIGN KEY ("org_id","receipt_id") REFERENCES "pos_sales_receipts"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_session_line_id_fk"
	FOREIGN KEY ("session_line_id") REFERENCES "table_session_lines"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ADD CONSTRAINT "pos_sales_receipt_lines_session_line_id_same_org_fk"
	FOREIGN KEY ("org_id","session_line_id") REFERENCES "table_session_lines"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_sales_receipt_payments
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_checked_by_fk"
	FOREIGN KEY ("checked_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_checked_by_same_org_fk"
	FOREIGN KEY ("org_id","checked_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_receipt_id_fk"
	FOREIGN KEY ("receipt_id") REFERENCES "pos_sales_receipts"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_receipt_id_same_org_fk"
	FOREIGN KEY ("org_id","receipt_id") REFERENCES "pos_sales_receipts"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_tender_id_fk"
	FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ADD CONSTRAINT "pos_sales_receipt_payments_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_day_closes
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_closed_by_fk"
	FOREIGN KEY ("closed_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_closed_by_same_org_fk"
	FOREIGN KEY ("org_id","closed_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_approved_by_fk"
	FOREIGN KEY ("approved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_approved_by_same_org_fk"
	FOREIGN KEY ("org_id","approved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ADD CONSTRAINT "pos_day_closes_terminal_same_store_fk"
	FOREIGN KEY ("store_id","terminal_id") REFERENCES "pos_terminals"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_day_close_tenders
ALTER TABLE "pos_day_close_tenders" ADD CONSTRAINT "pos_day_close_tenders_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ADD CONSTRAINT "pos_day_close_tenders_day_close_id_fk"
	FOREIGN KEY ("day_close_id") REFERENCES "pos_day_closes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ADD CONSTRAINT "pos_day_close_tenders_day_close_id_same_org_fk"
	FOREIGN KEY ("org_id","day_close_id") REFERENCES "pos_day_closes"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ADD CONSTRAINT "pos_day_close_tenders_tender_id_fk"
	FOREIGN KEY ("tender_id") REFERENCES "tenders"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ADD CONSTRAINT "pos_day_close_tenders_tender_id_same_org_fk"
	FOREIGN KEY ("org_id","tender_id") REFERENCES "tenders"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_events
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_person_id_fk"
	FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_person_id_same_org_fk"
	FOREIGN KEY ("org_id","person_id") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_resolved_by_fk"
	FOREIGN KEY ("resolved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_resolved_by_same_org_fk"
	FOREIGN KEY ("org_id","resolved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_events" ADD CONSTRAINT "pos_events_pairing_same_store_fk"
	FOREIGN KEY ("store_id","pairing_id") REFERENCES "pos_tablet_pairings"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_discount_presets
ALTER TABLE "pos_discount_presets" ADD CONSTRAINT "pos_discount_presets_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" ADD CONSTRAINT "pos_discount_presets_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" ADD CONSTRAINT "pos_discount_presets_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" ADD CONSTRAINT "pos_discount_presets_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" ADD CONSTRAINT "pos_discount_presets_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- table_session_line_discounts
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_applied_by_fk"
	FOREIGN KEY ("applied_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_applied_by_same_org_fk"
	FOREIGN KEY ("org_id","applied_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_approved_by_fk"
	FOREIGN KEY ("approved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_approved_by_same_org_fk"
	FOREIGN KEY ("org_id","approved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_removed_by_fk"
	FOREIGN KEY ("removed_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_removed_by_same_org_fk"
	FOREIGN KEY ("org_id","removed_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_session_line_same_store_fk"
	FOREIGN KEY ("store_id","session_line_id") REFERENCES "table_session_lines"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ADD CONSTRAINT "table_session_line_discounts_preset_same_store_fk"
	FOREIGN KEY ("store_id","preset_id") REFERENCES "pos_discount_presets"("store_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- pos_sales_receipt_line_discounts
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_receipt_line_id_fk"
	FOREIGN KEY ("receipt_line_id") REFERENCES "pos_sales_receipt_lines"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_receipt_line_id_same_org_fk"
	FOREIGN KEY ("org_id","receipt_line_id") REFERENCES "pos_sales_receipt_lines"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_preset_id_fk"
	FOREIGN KEY ("preset_id") REFERENCES "pos_discount_presets"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_preset_id_same_org_fk"
	FOREIGN KEY ("org_id","preset_id") REFERENCES "pos_discount_presets"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_statutory_record_id_fk"
	FOREIGN KEY ("statutory_record_id") REFERENCES "statutory_discount_records"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ADD CONSTRAINT "pos_sales_receipt_line_discounts_statutory_same_org_fk"
	FOREIGN KEY ("org_id","statutory_record_id") REFERENCES "statutory_discount_records"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- sales_days (R11)
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pos_day_close_id_fk"
	FOREIGN KEY ("pos_day_close_id") REFERENCES "pos_day_closes"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pos_day_close_id_same_org_fk"
	FOREIGN KEY ("org_id","pos_day_close_id") REFERENCES "pos_day_closes"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint

-- partial unique indexes and read indexes
CREATE UNIQUE INDEX "pos_terminals_pairing_key" ON "pos_terminals" ("pairing_id") WHERE "pairing_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "table_sessions_one_open_per_stand_key" ON "table_sessions" ("stand_id") WHERE "status" = 'open' AND "stand_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "table_sessions_store_open_idx" ON "table_sessions" ("store_id","opened_at") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "table_session_lines_session_idx" ON "table_session_lines" ("store_id","session_id");
--> statement-breakpoint
CREATE INDEX "pos_sales_receipt_payments_receipt_idx" ON "pos_sales_receipt_payments" ("receipt_id");
--> statement-breakpoint
CREATE INDEX "pos_sales_receipt_line_discounts_line_idx" ON "pos_sales_receipt_line_discounts" ("receipt_line_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_discount_presets_store_active_name_key" ON "pos_discount_presets" ("store_id", lower("name")) WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "table_session_line_discounts_line_idx" ON "table_session_line_discounts" ("store_id","session_line_id");
--> statement-breakpoint
CREATE INDEX "pos_events_quarantined_idx" ON "pos_events" ("store_id","status") WHERE "status" = 'quarantined';
--> statement-breakpoint

-- trigger functions
CREATE FUNCTION "table_sessions_forward_only"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'open' AND NEW.status IN ('paid','voided')) THEN
		RAISE EXCEPTION 'A table session only moves open -> paid or open -> voided; % -> % on session % is refused.', OLD.status, NEW.status, OLD.id
			USING ERRCODE = 'check_violation';
	END IF;
	IF (NEW.id, NEW.org_id, NEW.store_id, NEW.stand_id, NEW.mode, NEW.opened_by, NEW.opened_at_device, NEW.opened_on_pairing_id, NEW.opened_at)
		IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.store_id, OLD.stand_id, OLD.mode, OLD.opened_by, OLD.opened_at_device, OLD.opened_on_pairing_id, OLD.opened_at) THEN
		RAISE EXCEPTION 'How a table session was opened (id, org, store, stand, mode, who, when, which tablet) never changes (session %).', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.status <> 'open' AND (NEW.heads_cashier, NEW.heads_server, NEW.voided_by, NEW.voided_at_device, NEW.void_reason, NEW.voided_offline)
		IS DISTINCT FROM (OLD.heads_cashier, OLD.heads_server, OLD.voided_by, OLD.voided_at_device, OLD.void_reason, OLD.voided_offline) THEN
		RAISE EXCEPTION 'A % table session is closed: its head counts and void record never change (session %).', OLD.status, OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION "table_session_lines_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	s text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- FOR SHARE: a concurrent open -> paid UPDATE of the session waits for this line (or this line waits for it), so no line lands after the payment.
		SELECT status INTO s FROM "table_sessions" WHERE id = NEW.session_id FOR SHARE;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A % table session takes no new line (session %).', s, NEW.session_id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.kitchen_status IS DISTINCT FROM OLD.kitchen_status AND NOT (OLD.kitchen_status = 'queued' AND NEW.kitchen_status IN ('served','cancelled')) THEN
		RAISE EXCEPTION 'A kitchen line only moves queued -> served or queued -> cancelled; % -> % on line % is refused.', OLD.kitchen_status, NEW.kitchen_status, OLD.id
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.kitchen_status = 'cancelled' AND OLD.kitchen_status <> 'cancelled' THEN
		-- a line can be served late (the kitchen marks food out after payment) but never cancelled once the session is closed
		SELECT status INTO s FROM "table_sessions" WHERE id = NEW.session_id FOR SHARE;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A line of a % table session cannot be cancelled (line %).', s, OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	IF to_jsonb(NEW) - ARRAY['kitchen_status','served_at_device','served_by'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['kitchen_status','served_at_device','served_by']
		OR (OLD.kitchen_status <> 'queued' AND (NEW.served_at_device, NEW.served_by) IS DISTINCT FROM (OLD.served_at_device, OLD.served_by)) THEN
		RAISE EXCEPTION 'A table session line is frozen once written (only its kitchen status moves, once); line % is refused.', OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION "pos_sales_receipts_session_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	s text;
BEGIN
	-- FOR SHARE: a concurrent open -> voided UPDATE of the session waits for this receipt (or this receipt waits for it).
	SELECT status INTO s FROM "table_sessions" WHERE id = NEW.table_session_id FOR SHARE;
	IF s = 'voided' THEN
		RAISE EXCEPTION 'A voided table session takes no sales receipt (session %).', NEW.table_session_id USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
-- TG_ARGV names the columns that may go NULL -> a value once; every other column is frozen; DELETE is refused.
CREATE FUNCTION "pos_v2_frozen_except_once"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	o jsonb;
	n jsonb;
	c text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'A row of % is never deleted.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
	END IF;
	o := to_jsonb(OLD);
	n := to_jsonb(NEW);
	IF n - TG_ARGV IS DISTINCT FROM o - TG_ARGV THEN
		RAISE EXCEPTION 'A row of % is frozen once written (only % may be set, once); row % is refused.', TG_TABLE_NAME, TG_ARGV, OLD.id
			USING ERRCODE = 'restrict_violation';
	END IF;
	FOREACH c IN ARRAY TG_ARGV LOOP
		IF o -> c IS DISTINCT FROM 'null'::jsonb AND n -> c IS DISTINCT FROM o -> c THEN
			RAISE EXCEPTION '% on % is set once and never changed (row %).', c, TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
	END LOOP;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION "table_session_line_discounts_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
	s text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- FOR SHARE OF ss: a concurrent open -> paid UPDATE of the session waits for this discount (or this discount waits for it).
		SELECT ss.status INTO s FROM "table_session_lines" l JOIN "table_sessions" ss ON ss.id = l.session_id WHERE l.id = NEW.session_line_id FOR SHARE OF ss;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A % table session takes no new discount (line %).', s, NEW.session_line_id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'removed') THEN
		RAISE EXCEPTION 'A line discount only moves active -> removed; % -> % on discount % is refused.', OLD.status, NEW.status, OLD.id USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status = 'removed' AND OLD.status = 'active' THEN
		SELECT ss.status INTO s FROM "table_session_lines" l JOIN "table_sessions" ss ON ss.id = l.session_id WHERE l.id = OLD.session_line_id FOR SHARE OF ss;
		IF s IN ('paid','voided') THEN
			RAISE EXCEPTION 'A discount of a % table session cannot be removed (discount %).', s, OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	IF to_jsonb(NEW) - ARRAY['status','removed_by','removed_at_device'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','removed_by','removed_at_device']
		OR (OLD.status = 'removed' AND (NEW.removed_by, NEW.removed_at_device) IS DISTINCT FROM (OLD.removed_by, OLD.removed_at_device)) THEN
		RAISE EXCEPTION 'A line discount is frozen once written (only its removal moves, once); discount % is refused.', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION "pos_v2_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
	RAISE EXCEPTION 'A row of % is append-only: % is refused (row %).', TG_TABLE_NAME, TG_OP, OLD.id USING ERRCODE = 'restrict_violation';
END;
$fn$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "table_sessions_forward_only"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "table_session_lines_guard"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_v2_frozen_except_once"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_v2_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "pos_sales_receipts_session_guard"() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "table_session_line_discounts_guard"() FROM PUBLIC;
--> statement-breakpoint

-- triggers
CREATE TRIGGER "table_sessions_forward_only" BEFORE UPDATE ON "table_sessions" FOR EACH ROW EXECUTE FUNCTION "table_sessions_forward_only"();
--> statement-breakpoint
CREATE TRIGGER "table_session_lines_guard" BEFORE INSERT OR UPDATE ON "table_session_lines" FOR EACH ROW EXECUTE FUNCTION "table_session_lines_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipts_frozen" BEFORE UPDATE OR DELETE ON "pos_sales_receipts" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('day_close_id');
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipts_session_guard" BEFORE INSERT ON "pos_sales_receipts" FOR EACH ROW EXECUTE FUNCTION "pos_sales_receipts_session_guard"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_payments_frozen" BEFORE UPDATE OR DELETE ON "pos_sales_receipt_payments" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('checked_by','checked_at');
--> statement-breakpoint
CREATE TRIGGER "pos_events_frozen" BEFORE UPDATE OR DELETE ON "pos_events" FOR EACH ROW EXECUTE FUNCTION "pos_v2_frozen_except_once"('resolved_by','resolved_at','resolution');
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_lines_append_only" BEFORE UPDATE OR DELETE ON "pos_sales_receipt_lines" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_day_closes_append_only" BEFORE UPDATE OR DELETE ON "pos_day_closes" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_day_close_tenders_append_only" BEFORE UPDATE OR DELETE ON "pos_day_close_tenders" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "pos_sales_receipt_line_discounts_append_only" BEFORE UPDATE OR DELETE ON "pos_sales_receipt_line_discounts" FOR EACH ROW EXECUTE FUNCTION "pos_v2_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "table_session_line_discounts_guard" BEFORE INSERT OR UPDATE ON "table_session_line_discounts" FOR EACH ROW EXECUTE FUNCTION "table_session_line_discounts_guard"();
--> statement-breakpoint
ALTER TABLE "table_sessions" ENABLE ALWAYS TRIGGER "table_sessions_forward_only";
--> statement-breakpoint
ALTER TABLE "table_session_lines" ENABLE ALWAYS TRIGGER "table_session_lines_guard";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ENABLE ALWAYS TRIGGER "pos_sales_receipts_frozen";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ENABLE ALWAYS TRIGGER "pos_sales_receipts_session_guard";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ENABLE ALWAYS TRIGGER "pos_sales_receipt_payments_frozen";
--> statement-breakpoint
ALTER TABLE "pos_events" ENABLE ALWAYS TRIGGER "pos_events_frozen";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ENABLE ALWAYS TRIGGER "pos_sales_receipt_lines_append_only";
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ENABLE ALWAYS TRIGGER "pos_day_closes_append_only";
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ENABLE ALWAYS TRIGGER "pos_day_close_tenders_append_only";
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ENABLE ALWAYS TRIGGER "pos_sales_receipt_line_discounts_append_only";
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ENABLE ALWAYS TRIGGER "table_session_line_discounts_guard";
--> statement-breakpoint

-- RLS
ALTER TABLE "pos_stores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_stores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_stands" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_stands" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_terminals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_terminals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_day_closes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_day_close_tenders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_discount_presets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "table_session_line_discounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_sales_receipt_line_discounts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_stores_org_isolation" ON "pos_stores" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_stands_org_isolation" ON "pos_stands" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_terminals_org_isolation" ON "pos_terminals" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "table_sessions_org_isolation" ON "table_sessions" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "table_session_lines_org_isolation" ON "table_session_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_sales_receipts_org_isolation" ON "pos_sales_receipts" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_sales_receipt_lines_org_isolation" ON "pos_sales_receipt_lines" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_sales_receipt_payments_org_isolation" ON "pos_sales_receipt_payments" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_day_closes_org_isolation" ON "pos_day_closes" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_day_close_tenders_org_isolation" ON "pos_day_close_tenders" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_events_org_isolation" ON "pos_events" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_discount_presets_org_isolation" ON "pos_discount_presets" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "table_session_line_discounts_org_isolation" ON "table_session_line_discounts" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
CREATE POLICY "pos_sales_receipt_line_discounts_org_isolation" ON "pos_sales_receipt_line_discounts" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- grants: SELECT + INSERT everywhere, named columns for UPDATE, never DELETE
GRANT SELECT, INSERT ON "pos_stores", "pos_stands", "pos_terminals", "table_sessions", "table_session_lines", "pos_sales_receipts", "pos_sales_receipt_lines", "pos_sales_receipt_payments", "pos_day_closes", "pos_day_close_tenders", "pos_events", "pos_discount_presets", "table_session_line_discounts", "pos_sales_receipt_line_discounts" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("mode","live_from","state_version","changed_by","changed_at") ON "pos_stores" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("status","updated_at") ON "pos_stands" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("pairing_id","updated_at") ON "pos_terminals" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("heads_cashier","heads_server","status","voided_by","voided_at_device","void_reason","voided_offline") ON "table_sessions" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("kitchen_status","served_at_device","served_by") ON "table_session_lines" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("day_close_id") ON "pos_sales_receipts" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("checked_by","checked_at") ON "pos_sales_receipt_payments" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("resolved_by","resolved_at","resolution") ON "pos_events" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name","value_type","value","status","updated_at") ON "pos_discount_presets" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("status","removed_by","removed_at_device") ON "table_session_line_discounts" TO "shareat_app";
--> statement-breakpoint

-- R11: sales_days learns its third source (the 0209 drop / re-add pattern). The 0185 figure-lock and 0188 verify triggers are NOT touched.
ALTER TABLE "sales_days" DROP CONSTRAINT "sales_days_source_check";
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_source_check" CHECK ("source" IN ('legacy_typed','pos_v1_day_feed','pos_receipts'));
--> statement-breakpoint
ALTER TABLE "sales_days" ADD CONSTRAINT "sales_days_pos_day_close_link_check" CHECK (("source" = 'pos_receipts') = ("pos_day_close_id" IS NOT NULL));
--> statement-breakpoint

-- R12: one live statutory record per CARD per bill (was one per bill), so two seniors at one table are two rows.
DROP INDEX "statutory_discount_records_live_invoice_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_discount_records_live_invoice_key" ON "statutory_discount_records" ("org_id","store_id","business_date","invoice_number", lower(btrim("id_number"))) WHERE "voided_at" IS NULL;

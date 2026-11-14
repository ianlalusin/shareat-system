-- 0257 - T-564 (T-515 re-applied on main): store channel-settlement wiring. docs/tasks/564-store-settlement-wiring-renumber.md; hand-authored per ADR-012 s5.
-- T-515's own migration was numbered 0213 and clashed with main's applied 0213_t398; BOSS reserved 0257 for this re-application. Journal idx 257 follows 0256.
--
-- WHY. v1 kept a store key, outlet-name labels, file hints, bank hints and a wastage-email opt-in on Store.channelSettlement. The rebuild never carried them. They are
-- STORED here so the payout parser and the wastage email ingest can read them later; NOTHING READS THEM YET (the settlement preview only warns when they are missing).
--
-- WHAT IT ADDS.
--   * store_channel_settlement_configs: one row per store. store_key is a lowercase slug, unique per organisation, and immutable once saved (the domain refuses a change;
--     the app role is also given no UPDATE on that column, below). match_labels and file_hints are text[]; wastage_email_ingest_enabled defaults to false (fail-closed).
--   * sales_channels.bank_hints text[] default '{}': bank-name fragments for recognising a channel's payout account.
--
-- WHAT IT DELIBERATELY DOES NOT ADD. T-515 also added sales_channels.settlement_platform and a foodpanda_partner_code column. Main already holds the platform and the
-- statement store code as sales_channels.platform and sales_channels.platform_store_code (0228, T-511 S2a: unique per org and platform, audited, admin-only), so both
-- copies were dropped rather than carried as a second, disagreeing source of truth.
--
-- RLS (0011 / 0233 pattern): ENABLE + FORCE, one policy through app_current_org(), never raw current_setting (DEF-077).
-- GRANTS (ADR-012 s5 4a): shareat_app gets SELECT, INSERT and a COLUMN-LEVEL UPDATE (match_labels, file_hints, wastage_email_ingest_enabled, updated_at; never id, org_id,
-- store_id or store_key). No DELETE. sales_channels already carries a table-level UPDATE grant, which covers the new column.
--
-- LOCK BUDGET. store_channel_settlement_configs is new and empty. sales_channels ADD COLUMN with a constant default is a catalogue change on PostgreSQL 11 and later (the
-- repo runs 18): no rewrite. First statement SET LOCAL lock_timeout = '5s' (resets at commit). Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "sales_channels" ADD COLUMN "bank_hints" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE TABLE "store_channel_settlement_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"store_key" text NOT NULL,
	"match_labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"file_hints" text[] DEFAULT '{}'::text[] NOT NULL,
	"wastage_email_ingest_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "store_channel_settlement_store_key_check" CHECK ("store_key" ~ '^[a-z0-9][a-z0-9-]{1,23}$')
);
--> statement-breakpoint
ALTER TABLE "store_channel_settlement_configs" ADD CONSTRAINT "store_channel_settlement_configs_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_channel_settlement_configs" ADD CONSTRAINT "store_channel_settlement_configs_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "store_channel_settlement_configs" ADD CONSTRAINT "store_channel_settlement_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "store_channel_settlement_configs_org_store_unique" ON "store_channel_settlement_configs" ("org_id","store_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "store_channel_settlement_configs_org_key_unique" ON "store_channel_settlement_configs" ("org_id","store_key");
--> statement-breakpoint
CREATE INDEX "store_channel_settlement_configs_org_idx" ON "store_channel_settlement_configs" ("org_id");
--> statement-breakpoint
ALTER TABLE "store_channel_settlement_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "store_channel_settlement_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "store_channel_settlement_configs_org_isolation" ON "store_channel_settlement_configs"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT ON "store_channel_settlement_configs" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("match_labels", "file_hints", "wastage_email_ingest_enabled", "updated_at") ON "store_channel_settlement_configs" TO "shareat_app";

-- 0196 - T-401 S1: the ERP menu and catalog master (ten tables, their guards, RLS and grants).
-- docs/tasks/401-erp-menu-catalog-master.md sections 2 (R1-R13), 3 and 4. Hand-authored per ADR-012 s5.
-- Builds on 0194 (UNIQUE (org_id, id) on persons and stores) and 0195 (journal head).
--
-- AMENDED 2026-10-13 (Ian's answers, spec R7 R14 R15): thirteen tables, not ten. Adds menu_item_requests (a manager's request
-- for an item, resolved once by a super admin), menu_pos_v1_links (store x v1 POS item key -> variant) and
-- menu_usage_source_switches (append-only history of which stock-usage source a store reads); menu_offers gains the
-- online price RULE columns (pricing_mode, markup_percent, fixed_markup_amount); stock_locations gains UNIQUE (org_id, id).
--
-- WHAT. menu_categories, menu_items, menu_item_variants, menu_option_groups, menu_option_values,
-- menu_option_group_links, menu_package_refills, menu_depletion_rules, menu_offers, menu_option_offers.
-- "Offer" means a STORE'S PRICE ROW for a variant on a channel (R5): append-only, effective-dated, never UPDATEd,
-- never back-dated; the offer in force at time t is the row with the greatest effective_from <= t, and no row in
-- force means not offered. A depletion rule (R6) is the same shape (the pos_item_maps shape, effective-dated).
--
-- PURELY ADDITIVE. Ten new tables, two UNIQUE (org_id, id) additions (items and production_recipes: trivially true,
-- id alone is already unique; they give the composite FKs a real unique target, R10), and the functions and triggers
-- below. Nothing here reads or changes pos_item_maps, the sales days, the day feeds or the usage pull (R7, I16).
--
-- SAME-ORG FKs (R10, the 0194 shape). Every FK to another org-scoped table keeps its single-column FK and gains a
-- composite twin FOREIGN KEY (org_id, col) REFERENCES parent (org_id, id) named <table>_<col>_same_org_fk, so the
-- DEF-491 census is green on arrival. created_by and every store, item, recipe, category, variant, group and value
-- reference is covered. MATCH SIMPLE: a NULL column skips the check, so nullable columns stay nullable.
--
-- GRANTS (shareat_app). SELECT + INSERT everywhere. UPDATE on the five editable tables (categories, items, variants,
-- option groups, option values). DELETE on the two link tables (unlink) and on the three history tables, where a
-- trigger lets only a FUTURE row go (a cancelled scheduled change). The three history tables get no UPDATE grant.
--
-- TRIGGERS. All SECURITY INVOKER, all trigger-registry origin / validator (src/triggers/registry.ts): each decides
-- from the clock or from another row's CURRENT state, so a replay or restore must not re-run it. Names deliberately
-- avoid the T-354 history-guard naming net (that net is for ALWAYS triggers; the registry pins that count).
--   history tables (rules, offers, option offers): insert refused when effective_from < now() (no back-dating);
--     update refused always; delete refused once effective_from <= now() (a row in effect is history).
--   offers insert: refill => amount NULL; non-refill live => amount NOT NULL; bundle only on a package; a LIVE offer
--     needs a depletion rule for its variant in force at its effective_from (R6, I5).
--   rules delete (future only): refused if it would leave a live offer with no rule in force (I5b).
--   AUDIT ROUND: every guard that reads other rows of a variant first takes menu_lock_key(variant) (advisory xact lock),
--     so concurrent edits serialise; the three UPDATE guards are ENABLE ALWAYS (registry: history_guard); a live offer
--     for a retired variant or item is refused; history is monotonic per key (a row earlier than the latest is refused);
--     a variant's menu_item_id is fixed once it has an offer or package refill; item_type also counts package refills.
--   variants / items retire: refused while any live offer for it is in force or scheduled (withdraw first).
--   items: item_type is fixed once any variant has an offer (even a withdrawn one); an active item cannot sit in a
--     retired category. categories: one level of parent; a category holding an active item cannot be retired.
--   variants: an active item keeps exactly one default (partial unique index + a DEFERRED constraint trigger so a
--     default swap inside one transaction works).
--   package refills: the package side is a variant of a package item, the refill side a refill item (I10).
-- Functions menu_offer_in_force / menu_option_offer_in_force are THE "in force at t" query (K2): repo and tests call
-- them; they return the single newest row at or before p_at (which may be a withdrawn row), or no row.
--
-- READ ONLY production precheck (additive; nothing to backfill):
--   select to_regclass('menu_items'), to_regclass('menu_offers');  -- expect NULL x2

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "items" ADD CONSTRAINT "items_org_id_id_unique" UNIQUE ("org_id","id");--> statement-breakpoint
ALTER TABLE "production_recipes" ADD CONSTRAINT "production_recipes_org_id_id_unique" UNIQUE ("org_id","id");--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_org_id_id_unique" UNIQUE ("org_id","id");--> statement-breakpoint

CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_categories_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "menu_categories_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_categories_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_categories_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);--> statement-breakpoint

CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"item_type" text NOT NULL,
	"sold_a_la_carte" boolean DEFAULT false NOT NULL,
	"sold_in_package_session" boolean DEFAULT false NOT NULL,
	"diner_orderable" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_items_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "menu_items_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_items_item_type_check" CHECK ("item_type" in ('a_la_carte','package','refill')),
	CONSTRAINT "menu_items_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_items_refill_not_sold_check" CHECK ("item_type" <> 'refill' OR (NOT "sold_a_la_carte" AND NOT "sold_in_package_session"))
);--> statement-breakpoint

CREATE TABLE "menu_item_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"label" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_item_variants_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "menu_item_variants_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_item_variants_label_check" CHECK (("label" IS NULL AND "is_default") OR ("label" IS NOT NULL AND length(trim("label")) > 0))
);--> statement-breakpoint

CREATE TABLE "menu_option_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"selection_mode" text NOT NULL,
	"min_selections" integer DEFAULT 0 NOT NULL,
	"max_selections" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_option_groups_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "menu_option_groups_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_option_groups_selection_mode_check" CHECK ("selection_mode" in ('single','multi')),
	CONSTRAINT "menu_option_groups_status_check" CHECK ("status" in ('active','retired')),
	CONSTRAINT "menu_option_groups_min_check" CHECK ("min_selections" >= 0),
	CONSTRAINT "menu_option_groups_max_check" CHECK ("max_selections" >= 1 AND "max_selections" >= "min_selections"),
	CONSTRAINT "menu_option_groups_single_max_check" CHECK ("selection_mode" <> 'single' OR "max_selections" = 1)
);--> statement-breakpoint

CREATE TABLE "menu_option_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"option_group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_option_values_org_id_id_unique" UNIQUE ("org_id","id"),
	CONSTRAINT "menu_option_values_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_option_values_status_check" CHECK ("status" in ('active','retired'))
);--> statement-breakpoint

CREATE TABLE "menu_option_group_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"option_group_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"variant_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_option_group_links_one_target_check" CHECK (num_nonnulls("menu_item_id","variant_id") = 1),
	CONSTRAINT "menu_option_group_links_status_check" CHECK ("status" in ('active','retired'))
);--> statement-breakpoint

CREATE TABLE "menu_package_refills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"package_variant_id" uuid NOT NULL,
	"refill_item_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_package_refills_pair_unique" UNIQUE ("package_variant_id","refill_item_id"),
	CONSTRAINT "menu_package_refills_status_check" CHECK ("status" in ('active','retired'))
);--> statement-breakpoint

CREATE TABLE "menu_depletion_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" text NOT NULL,
	"item_id" uuid,
	"recipe_id" uuid,
	"quantity_per_sale" numeric(14,6),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_depletion_rules_variant_effective_unique" UNIQUE ("variant_id","effective_from"),
	CONSTRAINT "menu_depletion_rules_mode_check" CHECK ("mode" in ('direct','recipe','no_stock')),
	CONSTRAINT "menu_depletion_rules_mode_shape_check" CHECK (
		("mode" = 'direct' AND "item_id" IS NOT NULL AND "recipe_id" IS NULL AND "quantity_per_sale" IS NOT NULL)
		OR ("mode" = 'recipe' AND "recipe_id" IS NOT NULL AND "item_id" IS NULL)
		OR ("mode" = 'no_stock' AND "item_id" IS NULL AND "recipe_id" IS NULL)
	),
	CONSTRAINT "menu_depletion_rules_quantity_check" CHECK ("quantity_per_sale" IS NULL OR ("quantity_per_sale" > 0 AND "quantity_per_sale" < 'Infinity'::numeric))
);--> statement-breakpoint

CREATE TABLE "menu_offers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" numeric(14,2),
	"bundle_heads" integer,
	"extra_head_amount" numeric(14,2),
	"withdrawn" boolean DEFAULT false NOT NULL,
	"pricing_mode" text DEFAULT 'fixed' NOT NULL,
	"markup_percent" numeric(8,4),
	"fixed_markup_amount" numeric(14,2),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_offers_slot_unique" UNIQUE ("store_id","variant_id","channel","effective_from"),
	CONSTRAINT "menu_offers_channel_check" CHECK ("channel" in ('store','online')),
	CONSTRAINT "menu_offers_withdrawn_no_amounts_check" CHECK (NOT "withdrawn" OR ("pricing_mode" = 'fixed' AND "amount" IS NULL AND "bundle_heads" IS NULL AND "extra_head_amount" IS NULL AND "markup_percent" IS NULL AND "fixed_markup_amount" IS NULL)),
	CONSTRAINT "menu_offers_pricing_mode_check" CHECK ("pricing_mode" in ('fixed','fixed_markup','percent_markup')),
	CONSTRAINT "menu_offers_store_channel_fixed_check" CHECK ("channel" = 'online' OR "pricing_mode" = 'fixed'),
	CONSTRAINT "menu_offers_rule_shape_check" CHECK (
		("pricing_mode" = 'fixed' AND "markup_percent" IS NULL AND "fixed_markup_amount" IS NULL)
		OR ("pricing_mode" = 'percent_markup' AND "markup_percent" IS NOT NULL AND "markup_percent" > -100 AND "markup_percent" < 'Infinity'::numeric
			AND "amount" IS NULL AND "bundle_heads" IS NULL AND "extra_head_amount" IS NULL AND "fixed_markup_amount" IS NULL)
		OR ("pricing_mode" = 'fixed_markup' AND "fixed_markup_amount" IS NOT NULL AND "fixed_markup_amount" > '-Infinity'::numeric AND "fixed_markup_amount" < 'Infinity'::numeric
			AND "amount" IS NULL AND "bundle_heads" IS NULL AND "extra_head_amount" IS NULL AND "markup_percent" IS NULL)
	),
	CONSTRAINT "menu_offers_amount_check" CHECK ("amount" IS NULL OR ("amount" >= 0 AND "amount" < 'Infinity'::numeric)),
	CONSTRAINT "menu_offers_bundle_pair_check" CHECK (("bundle_heads" IS NULL) = ("extra_head_amount" IS NULL)),
	CONSTRAINT "menu_offers_bundle_heads_check" CHECK ("bundle_heads" IS NULL OR "bundle_heads" >= 1),
	CONSTRAINT "menu_offers_extra_head_amount_check" CHECK ("extra_head_amount" IS NULL OR ("extra_head_amount" >= 0 AND "extra_head_amount" < 'Infinity'::numeric))
);--> statement-breakpoint

CREATE TABLE "menu_option_offers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"price_delta" numeric(14,2),
	"withdrawn" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_option_offers_slot_unique" UNIQUE ("store_id","option_value_id","channel","effective_from"),
	CONSTRAINT "menu_option_offers_channel_check" CHECK ("channel" in ('store','online')),
	CONSTRAINT "menu_option_offers_delta_shape_check" CHECK (
		("withdrawn" AND "price_delta" IS NULL)
		OR (NOT "withdrawn" AND "price_delta" IS NOT NULL AND "price_delta" > '-Infinity'::numeric AND "price_delta" < 'Infinity'::numeric)
	)
);--> statement-breakpoint

CREATE TABLE "menu_item_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"name" text NOT NULL,
	"item_type" text NOT NULL,
	"category_id" uuid,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_item_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_item_requests_name_not_blank_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "menu_item_requests_item_type_check" CHECK ("item_type" in ('a_la_carte','package','refill')),
	CONSTRAINT "menu_item_requests_status_check" CHECK ("status" in ('open','approved','duplicate','rejected','withdrawn')),
	CONSTRAINT "menu_item_requests_resolved_shape_check" CHECK (
		("status" = 'open' AND "resolved_item_id" IS NULL AND "resolved_by" IS NULL AND "resolved_at" IS NULL AND "resolution_note" IS NULL)
		OR ("status" <> 'open' AND "resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL)
	),
	CONSTRAINT "menu_item_requests_item_needed_check" CHECK ("status" NOT IN ('approved','duplicate') OR "resolved_item_id" IS NOT NULL),
	CONSTRAINT "menu_item_requests_reject_note_check" CHECK ("status" <> 'rejected' OR length(trim(coalesce("resolution_note", ''))) > 0)
);--> statement-breakpoint

CREATE TABLE "menu_pos_v1_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_item_key" text NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "menu_pos_v1_links_key_not_blank_check" CHECK (length(trim("pos_item_key")) > 0),
	CONSTRAINT "menu_pos_v1_links_status_check" CHECK ("status" in ('active','inactive'))
);--> statement-breakpoint

CREATE TABLE "menu_usage_source_switches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"difference_count" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_usage_source_switches_source_check" CHECK ("source" in ('pos_item_maps','menu_rules')),
	CONSTRAINT "menu_usage_source_switches_difference_count_check" CHECK ("difference_count" IS NULL OR "difference_count" >= 0),
	CONSTRAINT "menu_usage_source_switches_reason_check" CHECK (NOT ("source" = 'menu_rules' AND "difference_count" > 0) OR length(trim(coalesce("reason", ''))) > 0)
);--> statement-breakpoint

ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_parent_id_fk"
	FOREIGN KEY ("parent_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_parent_id_same_org_fk"
	FOREIGN KEY ("org_id","parent_id") REFERENCES "menu_categories"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fk"
	FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_same_org_fk"
	FOREIGN KEY ("org_id","category_id") REFERENCES "menu_categories"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_menu_item_id_fk"
	FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_menu_item_id_same_org_fk"
	FOREIGN KEY ("org_id","menu_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_option_group_id_fk"
	FOREIGN KEY ("option_group_id") REFERENCES "menu_option_groups"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_option_group_id_same_org_fk"
	FOREIGN KEY ("org_id","option_group_id") REFERENCES "menu_option_groups"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_values" ADD CONSTRAINT "menu_option_values_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_option_group_id_fk"
	FOREIGN KEY ("option_group_id") REFERENCES "menu_option_groups"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_option_group_id_same_org_fk"
	FOREIGN KEY ("org_id","option_group_id") REFERENCES "menu_option_groups"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_menu_item_id_fk"
	FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_menu_item_id_same_org_fk"
	FOREIGN KEY ("org_id","menu_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_variant_id_fk"
	FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ADD CONSTRAINT "menu_option_group_links_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_package_variant_id_fk"
	FOREIGN KEY ("package_variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_package_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","package_variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_refill_item_id_fk"
	FOREIGN KEY ("refill_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_refill_item_id_same_org_fk"
	FOREIGN KEY ("org_id","refill_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ADD CONSTRAINT "menu_package_refills_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_variant_id_fk"
	FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_item_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_item_id_same_org_fk"
	FOREIGN KEY ("org_id","item_id") REFERENCES "items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_recipe_id_fk"
	FOREIGN KEY ("recipe_id") REFERENCES "production_recipes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_recipe_id_same_org_fk"
	FOREIGN KEY ("org_id","recipe_id") REFERENCES "production_recipes"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ADD CONSTRAINT "menu_depletion_rules_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_variant_id_fk"
	FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_offers" ADD CONSTRAINT "menu_offers_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_option_value_id_fk"
	FOREIGN KEY ("option_value_id") REFERENCES "menu_option_values"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_option_value_id_same_org_fk"
	FOREIGN KEY ("org_id","option_value_id") REFERENCES "menu_option_values"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ADD CONSTRAINT "menu_option_offers_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint


ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_requested_by_fk"
	FOREIGN KEY ("requested_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_requested_by_same_org_fk"
	FOREIGN KEY ("org_id","requested_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_category_id_fk"
	FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_category_id_same_org_fk"
	FOREIGN KEY ("org_id","category_id") REFERENCES "menu_categories"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_resolved_item_id_fk"
	FOREIGN KEY ("resolved_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_resolved_item_id_same_org_fk"
	FOREIGN KEY ("org_id","resolved_item_id") REFERENCES "menu_items"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_resolved_by_fk"
	FOREIGN KEY ("resolved_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_resolved_by_same_org_fk"
	FOREIGN KEY ("org_id","resolved_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_item_requests" ADD CONSTRAINT "menu_item_requests_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_variant_id_fk"
	FOREIGN KEY ("variant_id") REFERENCES "menu_item_variants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_variant_id_same_org_fk"
	FOREIGN KEY ("org_id","variant_id") REFERENCES "menu_item_variants"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_location_id_fk"
	FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_location_id_same_org_fk"
	FOREIGN KEY ("org_id","location_id") REFERENCES "stock_locations"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ADD CONSTRAINT "menu_pos_v1_links_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "menu_usage_source_switches" ADD CONSTRAINT "menu_usage_source_switches_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ADD CONSTRAINT "menu_usage_source_switches_store_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ADD CONSTRAINT "menu_usage_source_switches_store_id_same_org_fk"
	FOREIGN KEY ("org_id","store_id") REFERENCES "stores"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ADD CONSTRAINT "menu_usage_source_switches_created_by_fk"
	FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ADD CONSTRAINT "menu_usage_source_switches_created_by_same_org_fk"
	FOREIGN KEY ("org_id","created_by") REFERENCES "persons"("org_id","id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "menu_item_requests_org_status_idx" ON "menu_item_requests" ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_pos_v1_links_active_key" ON "menu_pos_v1_links" ("store_id","pos_item_key") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "menu_pos_v1_links_variant_idx" ON "menu_pos_v1_links" ("variant_id");--> statement-breakpoint
CREATE INDEX "menu_usage_source_switches_store_idx" ON "menu_usage_source_switches" ("store_id","created_at" DESC);--> statement-breakpoint

CREATE UNIQUE INDEX "menu_categories_org_name_key" ON "menu_categories" ("org_id", lower("name"));--> statement-breakpoint
CREATE INDEX "menu_categories_parent_idx" ON "menu_categories" ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_items_org_type_name_key" ON "menu_items" ("org_id", "item_type", lower("name"));--> statement-breakpoint
CREATE INDEX "menu_items_category_idx" ON "menu_items" ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_variants_one_default_key" ON "menu_item_variants" ("menu_item_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "menu_item_variants_item_label_key" ON "menu_item_variants" ("menu_item_id", lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "menu_option_values_group_name_key" ON "menu_option_values" ("option_group_id", lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "menu_option_group_links_item_key" ON "menu_option_group_links" ("option_group_id","menu_item_id") WHERE "menu_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_option_group_links_variant_key" ON "menu_option_group_links" ("option_group_id","variant_id") WHERE "variant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "menu_option_group_links_item_idx" ON "menu_option_group_links" ("menu_item_id");--> statement-breakpoint
CREATE INDEX "menu_option_group_links_variant_idx" ON "menu_option_group_links" ("variant_id");--> statement-breakpoint
CREATE INDEX "menu_package_refills_refill_idx" ON "menu_package_refills" ("refill_item_id");--> statement-breakpoint
CREATE INDEX "menu_depletion_rules_org_idx" ON "menu_depletion_rules" ("org_id");--> statement-breakpoint
CREATE INDEX "menu_offers_org_store_idx" ON "menu_offers" ("org_id","store_id","effective_from");--> statement-breakpoint
CREATE INDEX "menu_offers_variant_idx" ON "menu_offers" ("variant_id");--> statement-breakpoint
CREATE INDEX "menu_option_offers_value_idx" ON "menu_option_offers" ("option_value_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- "In force at t" (K2): the newest row at or before p_at for one slot. It may be a withdrawn row ("not sold from
-- then"); no row means not offered. Plain SQL, STABLE, SECURITY INVOKER (RLS applies to the caller).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_offer_in_force"(p_store uuid, p_variant uuid, p_channel text, p_at timestamptz)
RETURNS SETOF "menu_offers" LANGUAGE sql STABLE AS $$
	SELECT * FROM "menu_offers"
	 WHERE "store_id" = p_store AND "variant_id" = p_variant AND "channel" = p_channel AND "effective_from" <= p_at
	 ORDER BY "effective_from" DESC LIMIT 1
$$;--> statement-breakpoint

CREATE FUNCTION "menu_option_offer_in_force"(p_store uuid, p_value uuid, p_channel text, p_at timestamptz)
RETURNS SETOF "menu_option_offers" LANGUAGE sql STABLE AS $$
	SELECT * FROM "menu_option_offers"
	 WHERE "store_id" = p_store AND "option_value_id" = p_value AND "channel" = p_channel AND "effective_from" <= p_at
	 ORDER BY "effective_from" DESC LIMIT 1
$$;--> statement-breakpoint

-- True while any live (non-withdrawn) offer for the variant is in force on some store and channel, or is scheduled.
CREATE FUNCTION "menu_variant_has_live_offer"(p_variant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT EXISTS (SELECT 1 FROM "menu_offers" o WHERE o."variant_id" = p_variant AND NOT o."withdrawn" AND o."effective_from" > now())
	    OR EXISTS (
	        SELECT 1
	          FROM (SELECT DISTINCT "store_id", "channel" FROM "menu_offers" WHERE "variant_id" = p_variant) k
	         CROSS JOIN LATERAL "menu_offer_in_force"(k."store_id", p_variant, k."channel", now()) f
	         WHERE NOT f."withdrawn")
$$;--> statement-breakpoint

-- Serialises every guard that reads other rows of one variant (or option value): offer insert, rule insert and delete,
-- retire. READ COMMITTED guards that each read the other's uncommitted work as absent would otherwise both pass
-- (write skew). Transaction-scoped advisory lock keyed on the id; released at commit or rollback.
CREATE FUNCTION "menu_lock_key"(p_id uuid) RETURNS void LANGUAGE sql AS $$
	SELECT pg_advisory_xact_lock(hashtextextended('menu:' || p_id::text, 0))
$$;--> statement-breakpoint

-- Several keys at once, always in ascending id order (a plain ORDER BY in a PERFORM does not fix evaluation order).
-- GLOBAL LOCK ORDER everywhere: item keys (ascending) before variant keys (ascending); a rule or option offer takes one key.
CREATE FUNCTION "menu_lock_keys"(p_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	k uuid;
BEGIN
	FOR k IN SELECT DISTINCT x FROM unnest(p_ids) x WHERE x IS NOT NULL ORDER BY x LOOP
		PERFORM "menu_lock_key"(k);
	END LOOP;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- History tables: rules, offers, option offers.
-- ---------------------------------------------------------------------------------------------
-- Rules: no back-dating, and monotonic per variant (a row earlier than the latest would never take effect).
CREATE FUNCTION "menu_depletion_rules_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_key"(NEW."variant_id");
	IF NEW."effective_from" < now() THEN
		RAISE EXCEPTION 'menu_depletion_rules rows are never back-dated: effective_from % is in the past (omit it to start now)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	IF EXISTS (SELECT 1 FROM "menu_depletion_rules" r WHERE r."variant_id" = NEW."variant_id" AND r."effective_from" > NEW."effective_from") THEN
		RAISE EXCEPTION 'menu_depletion_rules is monotonic: effective_from % is earlier than the latest rule for this variant (rows go in order)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_option_offers_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_key"(NEW."option_value_id");
	IF NEW."effective_from" < now() THEN
		RAISE EXCEPTION 'menu_option_offers rows are never back-dated: effective_from % is in the past (omit it to start now)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	IF EXISTS (SELECT 1 FROM "menu_option_offers" o WHERE o."store_id" = NEW."store_id" AND o."option_value_id" = NEW."option_value_id"
	            AND o."channel" = NEW."channel" AND o."effective_from" > NEW."effective_from") THEN
		RAISE EXCEPTION 'menu_option_offers is monotonic: effective_from % is earlier than the latest row for this store, value and channel (rows go in order)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_history_update_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: a row is never updated (insert the next row instead)', TG_TABLE_NAME
		USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_history_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."effective_from" <= now() THEN
		RAISE EXCEPTION '% is append-only: a row in effect (since %) is never deleted, only a scheduled future one', TG_TABLE_NAME, OLD."effective_from"
			USING ERRCODE = '23514';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint

-- A scheduled rule may be deleted only if no live offer would be left with no rule in force at its effective_from.
CREATE FUNCTION "menu_depletion_rules_delete_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_key"(OLD."variant_id");
	IF OLD."effective_from" <= now() THEN
		RAISE EXCEPTION 'menu_depletion_rules is append-only: a rule in effect (since %) is never deleted, only a scheduled future one', OLD."effective_from"
			USING ERRCODE = '23514';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "menu_offers" o
		 WHERE o."variant_id" = OLD."variant_id" AND NOT o."withdrawn" AND o."effective_from" >= OLD."effective_from"
		   AND NOT EXISTS (SELECT 1 FROM "menu_depletion_rules" r
		                    WHERE r."variant_id" = OLD."variant_id" AND r."id" <> OLD."id" AND r."effective_from" <= o."effective_from")
	) THEN
		RAISE EXCEPTION 'this depletion rule cannot be deleted: a live offer would be left with no depletion rule in force (cancel or withdraw the offer first)'
			USING ERRCODE = '23514';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_offers_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_type text;
	v_vstatus text;
	v_istatus text;
	v_item uuid;
BEGIN
	SELECT v."menu_item_id" INTO v_item FROM "menu_item_variants" v WHERE v."id" = NEW."variant_id";
	PERFORM "menu_lock_keys"(ARRAY[v_item]);
	PERFORM "menu_lock_key"(NEW."variant_id");
	IF NEW."effective_from" < now() THEN
		RAISE EXCEPTION 'menu_offers rows are never back-dated: effective_from % is in the past (omit it to start now)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	IF EXISTS (SELECT 1 FROM "menu_offers" o WHERE o."store_id" = NEW."store_id" AND o."variant_id" = NEW."variant_id"
	            AND o."channel" = NEW."channel" AND o."effective_from" > NEW."effective_from") THEN
		RAISE EXCEPTION 'menu_offers is monotonic: effective_from % is earlier than the latest row for this store, variant and channel (rows go in order)', NEW."effective_from"
			USING ERRCODE = '23514';
	END IF;
	SELECT i."item_type", v."status", i."status" INTO v_type, v_vstatus, v_istatus
	  FROM "menu_item_variants" v JOIN "menu_items" i ON i."id" = v."menu_item_id"
	 WHERE v."id" = NEW."variant_id";
	-- v_type is NULL only when the variant does not exist; the foreign key reports that.
	IF NEW."bundle_heads" IS NOT NULL AND v_type IS NOT NULL AND v_type <> 'package' THEN
		RAISE EXCEPTION 'bundle pricing is only for a package variant (this one belongs to a % item)', v_type
			USING ERRCODE = '23514';
	END IF;
	IF NOT NEW."withdrawn" THEN
		IF v_vstatus = 'retired' OR v_istatus = 'retired' THEN
			RAISE EXCEPTION 'a live offer cannot be set for a retired variant or a variant of a retired item' USING ERRCODE = '23514';
		END IF;
		IF v_type = 'refill' AND (NEW."amount" IS NOT NULL OR NEW."pricing_mode" <> 'fixed') THEN
			RAISE EXCEPTION 'a refill offer carries no amount and no price rule (a refill is a zero-price serving)' USING ERRCODE = '23514';
		END IF;
		IF v_type IS NOT NULL AND v_type <> 'refill' AND NEW."pricing_mode" = 'fixed' AND NEW."amount" IS NULL THEN
			RAISE EXCEPTION 'a live fixed offer for a % item needs an amount', v_type USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM "menu_depletion_rules" r
		                WHERE r."variant_id" = NEW."variant_id" AND r."effective_from" <= NEW."effective_from") THEN
			RAISE EXCEPTION 'a live offer needs a depletion rule in force at its effective_from (%): set the variant''s depletion rule first', NEW."effective_from"
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_depletion_rules_insert_guard" BEFORE INSERT ON "menu_depletion_rules"
	FOR EACH ROW EXECUTE FUNCTION "menu_depletion_rules_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_depletion_rules_update_guard" BEFORE UPDATE ON "menu_depletion_rules"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_update_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_depletion_rules_delete_guard" BEFORE DELETE ON "menu_depletion_rules"
	FOR EACH ROW EXECUTE FUNCTION "menu_depletion_rules_delete_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_offers_insert_guard" BEFORE INSERT ON "menu_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_offers_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_offers_update_guard" BEFORE UPDATE ON "menu_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_update_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_offers_delete_guard" BEFORE DELETE ON "menu_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_delete_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_option_offers_insert_guard" BEFORE INSERT ON "menu_option_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_option_offers_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_option_offers_update_guard" BEFORE UPDATE ON "menu_option_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_update_guard"();--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ENABLE ALWAYS TRIGGER "menu_depletion_rules_update_guard";--> statement-breakpoint
ALTER TABLE "menu_offers" ENABLE ALWAYS TRIGGER "menu_offers_update_guard";--> statement-breakpoint
ALTER TABLE "menu_option_offers" ENABLE ALWAYS TRIGGER "menu_option_offers_update_guard";--> statement-breakpoint
CREATE TRIGGER "menu_option_offers_delete_guard" BEFORE DELETE ON "menu_option_offers"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_delete_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Categories.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_categories_parent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."parent_id" IS NOT NULL THEN
		IF EXISTS (SELECT 1 FROM "menu_categories" p WHERE p."id" = NEW."parent_id" AND p."parent_id" IS NOT NULL) THEN
			RAISE EXCEPTION 'a category''s parent cannot itself have a parent (one level only)' USING ERRCODE = '23514';
		END IF;
		IF EXISTS (SELECT 1 FROM "menu_categories" c WHERE c."parent_id" = NEW."id") THEN
			RAISE EXCEPTION 'a category that has sub-categories cannot itself get a parent (one level only)' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_categories_retire_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "menu_items" i WHERE i."category_id" = NEW."id" AND i."status" = 'active') THEN
		RAISE EXCEPTION 'this category cannot be retired: it still holds active items (move or retire them first)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_categories_parent_guard" BEFORE INSERT OR UPDATE OF "parent_id" ON "menu_categories"
	FOR EACH ROW EXECUTE FUNCTION "menu_categories_parent_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_categories_retire_guard" BEFORE UPDATE OF "status" ON "menu_categories"
	FOR EACH ROW WHEN (NEW."status" = 'retired' AND OLD."status" IS DISTINCT FROM 'retired')
	EXECUTE FUNCTION "menu_categories_retire_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Items.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_items_category_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."status" = 'active' AND EXISTS (SELECT 1 FROM "menu_categories" c WHERE c."id" = NEW."category_id" AND c."status" = 'retired') THEN
		RAISE EXCEPTION 'an active item cannot sit in a retired category' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_items_type_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_keys"(ARRAY[NEW."id"]);
	PERFORM "menu_lock_keys"(ARRAY(SELECT v."id" FROM "menu_item_variants" v WHERE v."menu_item_id" = NEW."id"));
	IF EXISTS (SELECT 1 FROM "menu_offers" o JOIN "menu_item_variants" v ON v."id" = o."variant_id" WHERE v."menu_item_id" = NEW."id") THEN
		RAISE EXCEPTION 'item_type is fixed once any variant of the item has an offer (even a withdrawn one)' USING ERRCODE = '23514';
	END IF;
	IF EXISTS (SELECT 1 FROM "menu_package_refills" pr WHERE pr."refill_item_id" = NEW."id")
	   OR EXISTS (SELECT 1 FROM "menu_package_refills" pr JOIN "menu_item_variants" v ON v."id" = pr."package_variant_id" WHERE v."menu_item_id" = NEW."id") THEN
		RAISE EXCEPTION 'item_type is fixed while menu_package_refills references the item (unlink its refills first)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "menu_items_retire_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_keys"(ARRAY[NEW."id"]);
	PERFORM "menu_lock_keys"(ARRAY(SELECT v."id" FROM "menu_item_variants" v WHERE v."menu_item_id" = NEW."id"));
	IF EXISTS (SELECT 1 FROM "menu_item_variants" v WHERE v."menu_item_id" = NEW."id" AND "menu_variant_has_live_offer"(v."id")) THEN
		RAISE EXCEPTION 'this item cannot be retired while an offer for one of its variants is in force or scheduled (withdraw first)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_items_category_guard" BEFORE INSERT OR UPDATE OF "category_id", "status" ON "menu_items"
	FOR EACH ROW EXECUTE FUNCTION "menu_items_category_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_items_type_guard" BEFORE UPDATE OF "item_type" ON "menu_items"
	FOR EACH ROW WHEN (NEW."item_type" IS DISTINCT FROM OLD."item_type")
	EXECUTE FUNCTION "menu_items_type_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_items_retire_guard" BEFORE UPDATE OF "status" ON "menu_items"
	FOR EACH ROW WHEN (NEW."status" = 'retired' AND OLD."status" IS DISTINCT FROM 'retired')
	EXECUTE FUNCTION "menu_items_retire_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Variants.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_item_variants_retire_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_key"(NEW."id");
	IF "menu_variant_has_live_offer"(NEW."id") THEN
		RAISE EXCEPTION 'this variant cannot be retired while an offer for it is in force or scheduled (withdraw first)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

-- DEFERRED constraint trigger: checked at commit, so a default swap (new default, then retire the old) works in one
-- transaction. An item that is itself retired may lose its default.
CREATE FUNCTION "menu_item_variants_default_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD."is_default" AND OLD."status" = 'active' AND (NOT NEW."is_default" OR NEW."status" <> 'active') THEN
		IF EXISTS (SELECT 1 FROM "menu_items" i WHERE i."id" = NEW."menu_item_id" AND i."status" = 'active')
		   AND NOT EXISTS (SELECT 1 FROM "menu_item_variants" v WHERE v."menu_item_id" = NEW."menu_item_id" AND v."is_default" AND v."status" = 'active') THEN
			RAISE EXCEPTION 'an active item keeps exactly one active default variant: make another variant the default first, or retire the item' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

-- The parent of a variant is fixed once anything depends on it: an offer (even withdrawn or bundle) or a package refill.
CREATE FUNCTION "menu_item_variants_parent_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "menu_lock_keys"(ARRAY[OLD."menu_item_id", NEW."menu_item_id"]);
	PERFORM "menu_lock_key"(NEW."id");
	IF EXISTS (SELECT 1 FROM "menu_offers" o WHERE o."variant_id" = NEW."id")
	   OR EXISTS (SELECT 1 FROM "menu_package_refills" pr WHERE pr."package_variant_id" = NEW."id") THEN
		RAISE EXCEPTION 'menu_item_id of a variant is fixed once it has an offer or a package refill (the parent item cannot change)' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_item_variants_parent_guard" BEFORE UPDATE OF "menu_item_id" ON "menu_item_variants"
	FOR EACH ROW WHEN (NEW."menu_item_id" IS DISTINCT FROM OLD."menu_item_id")
	EXECUTE FUNCTION "menu_item_variants_parent_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_item_variants_retire_guard" BEFORE UPDATE OF "status" ON "menu_item_variants"
	FOR EACH ROW WHEN (NEW."status" = 'retired' AND OLD."status" IS DISTINCT FROM 'retired')
	EXECUTE FUNCTION "menu_item_variants_retire_guard"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "menu_item_variants_default_guard" AFTER UPDATE OF "is_default", "status" ON "menu_item_variants"
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "menu_item_variants_default_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Package refills: package variant -> refill item only (I10).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_package_refills_pair_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_pkg text;
	v_refill text;
	v_pkg_item uuid;
BEGIN
	SELECT v."menu_item_id" INTO v_pkg_item FROM "menu_item_variants" v WHERE v."id" = NEW."package_variant_id";
	PERFORM "menu_lock_keys"(ARRAY[v_pkg_item, NEW."refill_item_id"]);
	PERFORM "menu_lock_key"(NEW."package_variant_id");
	SELECT i."item_type" INTO v_pkg FROM "menu_item_variants" v JOIN "menu_items" i ON i."id" = v."menu_item_id" WHERE v."id" = NEW."package_variant_id";
	SELECT i."item_type" INTO v_refill FROM "menu_items" i WHERE i."id" = NEW."refill_item_id";
	-- NULL means the row does not exist; the foreign key reports that.
	IF v_pkg IS NOT NULL AND v_pkg <> 'package' THEN
		RAISE EXCEPTION 'the package side of a package refill must be a variant of a package item (this one is a % item)', v_pkg USING ERRCODE = '23514';
	END IF;
	IF v_refill IS NOT NULL AND v_refill <> 'refill' THEN
		RAISE EXCEPTION 'the refill side of a package refill must be a refill item (this one is a % item)', v_refill USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_package_refills_pair_guard" BEFORE INSERT ON "menu_package_refills"
	FOR EACH ROW EXECUTE FUNCTION "menu_package_refills_pair_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Item requests (R14): a request resolves once; its identity is frozen.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_item_requests_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."name" IS DISTINCT FROM OLD."name" OR NEW."store_id" IS DISTINCT FROM OLD."store_id"
	   OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by" OR NEW."item_type" IS DISTINCT FROM OLD."item_type" THEN
		RAISE EXCEPTION 'name, store_id, requested_by and item_type of an item request are frozen (withdraw it and file a new one)' USING ERRCODE = '23514';
	END IF;
	IF OLD."status" <> 'open' THEN
		RAISE EXCEPTION 'a resolved item request (%) never changes again', OLD."status" USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_item_requests_guard" BEFORE UPDATE ON "menu_item_requests"
	FOR EACH ROW EXECUTE FUNCTION "menu_item_requests_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- v1 POS links (R7): a link points only at an active variant that has a depletion rule in force now.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_pos_v1_links_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_item uuid;
	v_vstatus text;
	v_istatus text;
	v_loc_org uuid;
	v_loc_store uuid;
BEGIN
	IF TG_OP = 'UPDATE' AND (NEW."variant_id" IS DISTINCT FROM OLD."variant_id" OR NEW."store_id" IS DISTINCT FROM OLD."store_id"
	   OR NEW."pos_item_key" IS DISTINCT FROM OLD."pos_item_key") THEN
		RAISE EXCEPTION 'variant_id, store_id and pos_item_key of a link are immutable (relink = deactivate and insert a new link)' USING ERRCODE = '23514';
	END IF;
	IF NEW."location_id" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."location_id" IS DISTINCT FROM OLD."location_id") THEN
		SELECT l."org_id", l."store_id" INTO v_loc_org, v_loc_store FROM "stock_locations" l WHERE l."id" = NEW."location_id";
		-- another org's location is reported by the same-org foreign key
		IF v_loc_org = NEW."org_id" AND v_loc_store <> NEW."store_id" THEN
			RAISE EXCEPTION 'the stock location must belong to the link''s store' USING ERRCODE = '23514';
		END IF;
	END IF;
	IF NEW."status" = 'active' AND (TG_OP = 'INSERT' OR OLD."status" <> 'active') THEN
		SELECT v."menu_item_id" INTO v_item FROM "menu_item_variants" v WHERE v."id" = NEW."variant_id";
		IF v_item IS NOT NULL THEN
			PERFORM "menu_lock_keys"(ARRAY[v_item]);
			PERFORM "menu_lock_key"(NEW."variant_id");
			SELECT v."status", i."status" INTO v_vstatus, v_istatus
			  FROM "menu_item_variants" v JOIN "menu_items" i ON i."id" = v."menu_item_id" WHERE v."id" = NEW."variant_id";
			IF v_vstatus = 'retired' OR v_istatus = 'retired' THEN
				RAISE EXCEPTION 'a link cannot point at a retired variant or a variant of a retired item' USING ERRCODE = '23514';
			END IF;
			IF NOT EXISTS (SELECT 1 FROM "menu_depletion_rules" r WHERE r."variant_id" = NEW."variant_id" AND r."effective_from" <= now()) THEN
				RAISE EXCEPTION 'a link needs a depletion rule in force now for its variant: set the rule first' USING ERRCODE = '23514';
			END IF;
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_pos_v1_links_guard" BEFORE INSERT OR UPDATE ON "menu_pos_v1_links"
	FOR EACH ROW EXECUTE FUNCTION "menu_pos_v1_links_guard"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Usage-source switches (R7): immediate, append-only history.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "menu_usage_source_switches_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."created_at" := now();
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "menu_usage_source_switches_insert_guard" BEFORE INSERT ON "menu_usage_source_switches"
	FOR EACH ROW EXECUTE FUNCTION "menu_usage_source_switches_insert_guard"();--> statement-breakpoint
CREATE TRIGGER "menu_usage_source_switches_update_guard" BEFORE UPDATE ON "menu_usage_source_switches"
	FOR EACH ROW EXECUTE FUNCTION "menu_history_update_guard"();--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ENABLE ALWAYS TRIGGER "menu_usage_source_switches_update_guard";--> statement-breakpoint

ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_item_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_item_variants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_values" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_group_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_package_refills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_package_refills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_depletion_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_offers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_option_offers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "menu_item_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_item_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_pos_v1_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_usage_source_switches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "menu_categories_org_isolation" ON "menu_categories"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_items_org_isolation" ON "menu_items"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_item_variants_org_isolation" ON "menu_item_variants"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_option_groups_org_isolation" ON "menu_option_groups"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_option_values_org_isolation" ON "menu_option_values"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_option_group_links_org_isolation" ON "menu_option_group_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_package_refills_org_isolation" ON "menu_package_refills"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_depletion_rules_org_isolation" ON "menu_depletion_rules"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_offers_org_isolation" ON "menu_offers"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_option_offers_org_isolation" ON "menu_option_offers"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

CREATE POLICY "menu_item_requests_org_isolation" ON "menu_item_requests"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_pos_v1_links_org_isolation" ON "menu_pos_v1_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "menu_usage_source_switches_org_isolation" ON "menu_usage_source_switches"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "menu_categories" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_items" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_item_variants" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_option_groups" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_option_values" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_option_group_links" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_package_refills" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_depletion_rules" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_offers" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "menu_option_offers" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_item_requests" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "menu_pos_v1_links" TO "shareat_app";--> statement-breakpoint
GRANT SELECT, INSERT ON "menu_usage_source_switches" TO "shareat_app";

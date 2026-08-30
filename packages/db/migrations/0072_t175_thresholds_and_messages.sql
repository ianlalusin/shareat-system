-- 0072 — T-175: low stock becomes an order, and the order has a conversation.
--
-- HAND-WRITTEN, like 0020-0071. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⛔ THERE IS NO POLICY OBJECT AND NO ALERT TABLE, and that is a finding rather than a shortcut.
-- v1's `itemReorderPolicies` and `reorderAlerts` are DEAD SCHEMA — `docs/discovery/14` §D grepped
-- `src/lib/**` and `functions/**` and found zero references to either name. `01-data-model.md`
-- lists them; nothing uses them. The live mechanism is ONE FIELD plus a summed-on-read query.
--
-- ⚠️ v1's item master also still exposes `reorderPoint` and `reorderQuantity` on every edit form
-- that nothing reads — vestiges of a smart-reorder system that was removed. They are not added
-- back here, and T-145's `items` correctly has neither.

CREATE TABLE "store_item_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	-- ⚠️ Zero is allowed and MEANS something: "tell me the moment it runs out". It is not the same
	-- as having no threshold, which is a different state with its own finding.
	"low_stock_threshold" numeric(14, 3) NOT NULL,
	"set_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "store_item_thresholds_non_negative_check" CHECK ("low_stock_threshold" >= 0)
);--> statement-breakpoint

ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_item_id_items_id_fk"
	FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "store_item_thresholds" ADD CONSTRAINT "store_item_thresholds_set_by_persons_id_fk"
	FOREIGN KEY ("set_by") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- ⭐ Per STORE, per item — not per location. v1 sums a store's rooms before comparing, and that is
-- right: a branch with three kilos in the kitchen and one in the stockroom has four kilos, and a
-- per-room threshold would cry low stock while a shelf next door is full.
CREATE UNIQUE INDEX "store_item_thresholds_key" ON "store_item_thresholds" ("store_id", "item_id");--> statement-breakpoint
CREATE INDEX "store_item_thresholds_org_idx" ON "store_item_thresholds" ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ The conversation that belongs to an order. In v1 this was a phone call.
CREATE TABLE "trade_order_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_order_messages_body_not_blank_check" CHECK (length(trim("body")) > 0)
);--> statement-breakpoint

ALTER TABLE "trade_order_messages" ADD CONSTRAINT "trade_order_messages_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "trade_order_messages" ADD CONSTRAINT "trade_order_messages_order_id_trade_orders_id_fk"
	FOREIGN KEY ("order_id") REFERENCES "trade_orders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trade_order_messages" ADD CONSTRAINT "trade_order_messages_author_id_persons_id_fk"
	FOREIGN KEY ("author_id") REFERENCES "persons"("id") ON DELETE RESTRICT;--> statement-breakpoint

CREATE INDEX "trade_order_messages_order_idx" ON "trade_order_messages" ("order_id", "created_at");--> statement-breakpoint

-- ⭐ APPEND-ONLY, and that is the whole value. This is the audit trail of a commercial
-- conversation between two stores — who asked for a substitution, who agreed to it, when somebody
-- said the crate was short. ⚠️ An editable audit trail is not one. Same treatment T-161 gives the
-- stock ledger, and DEF-041's lesson stated as a constraint rather than as a convention: *an
-- invariant phrased as "our code does not do X" is a convention.*
CREATE FUNCTION "trade_order_messages_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'trade_order_messages is append-only — a message cannot be % (order %)',
		lower(TG_OP), COALESCE(OLD."order_id"::text, '?');
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trade_order_messages_append_only_trg"
	BEFORE UPDATE OR DELETE ON "trade_order_messages"
	FOR EACH ROW EXECUTE FUNCTION "trade_order_messages_append_only"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- ⭐ THE SUGGESTED QUANTITY, and why it is not v1's zero.
--
-- v1 queues a low-stock item onto the branch's open draft at quantity **0**. `docs/discovery/14` §D
-- asks whether that is used or whether it just clutters drafts with 0-qty lines nobody fills in.
-- ⚠️ A zero-quantity line is a to-do item wearing an order line's clothes.
--
-- The suggestion is computable from data v2 already has — `threshold − onHand` — so the line
-- arrives with a number the branch can accept or type over, which is one keystroke fewer than
-- typing into a blank.
--
-- ⛔ It is WRITTEN ONCE at append and never refreshed. It is a suggestion recorded on the line, not
-- a second stored balance: a number that silently changes under somebody filling in a form is
-- worse than a stale one.
ALTER TABLE "trade_order_lines" ADD COLUMN "suggested_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_suggested_quantity_check"
	CHECK ("suggested_quantity" IS NULL OR "suggested_quantity" > 0);--> statement-breakpoint

-- ⭐ ONE line per item per order — what makes the auto-append idempotent. A second usage post that
-- crosses the same threshold must not add the item twice, and the rule belongs here rather than in
-- the appending function, which is one caller among the several a UI grows.
-- ⚠️ Scoped to INTERNAL order lines only: an external sale may legitimately list the same item
-- twice at different rates (a tiered price, a partial free-of-charge), and forbidding that would
-- impose a rule about ordering onto selling.
--
-- ⛔ The predicate tests `requested_quantity IS NOT NULL` rather than the order's
-- `requested_by_store_id`, because **a partial index predicate cannot reach another table** —
-- Postgres rejects it with *"cannot use subquery in index predicate"*, which is how 0068's count
-- freeze ended up a trigger. The proxy is sound rather than lucky: `trade_orders_submit_hardening`
-- refuses to submit an internal order with a line missing `requested_quantity`, so every internal
-- line that survives to matter carries one.
CREATE UNIQUE INDEX "trade_order_lines_internal_item_key"
	ON "trade_order_lines" ("order_id", "item_id")
	WHERE "requested_quantity" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS — ENABLE **and** FORCE (bible row 112).
--
-- ⚠️ Both words, every time. `ENABLE` alone leaves the table OWNER exempt, which is the role the
-- app connects as in several paths — so an enabled-but-unforced table reads as protected and is
-- not. T-120's invariant 9 catches it, and caught this migration: it shipped with neither, and the
-- registry entry alone does not create the policy.
ALTER TABLE "store_item_thresholds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_item_thresholds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trade_order_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "trade_order_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "store_item_thresholds_org_isolation" ON "store_item_thresholds"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint
CREATE POLICY "trade_order_messages_org_isolation" ON "trade_order_messages"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

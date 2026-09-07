-- T-230 — sales channels: the admin surface (DEF-207) + per-channel wastage policy (bible §13 row
-- 180). docs/tasks/230-sales-channels-admin-and-wastage-policy.md.
--
-- ⚠️ Hand-written from `schema/sales-days.ts` and `schema/order-wastage.ts`, per DEF-073 / DEF-121
-- — `drizzle-kit generate`'s snapshot chain has been dead since 0019 and the tool opens by asking
-- whether `expenses.supplier_invoice_id`, created ninety migrations ago, is a rename. Same
-- convention as 0131 and 0132, which say so in their own headers.
--
-- Three things happen here, and they are one package because they are one table:
--
--   1. `sales_channels.wastage_type_mode` — the channel carries the policy. Ian, 2026-09-07.
--   2. `order_wastages.channel_id` — a real pointer, replacing resolution-by-name-at-posting-time.
--   3. The normalised unique index the first human create path requires.

-- ---------------------------------------------------------------------------------------------
-- 1. The per-channel wastage policy — bible §13 row 180.
--
-- ⭐ NOT NULL WITH A DEFAULT, unlike `is_remitted_daily` on the same table, and the difference is
-- deliberate. There is no safe value for remittance behaviour, so that column refuses to have one
-- ("a channel whose remittance behaviour nobody stated is a channel whose money nobody can account
-- for"). There IS a safe value here: `tracked` keeps the Wastage Monitor, the 48-hour dispute
-- window and the 15-day auto-charge backstop; `instant` removes all three. A default that silently
-- disables a control would be the wrong default.
--
-- ⛔ NO NAME HEURISTIC IN THE BACKFILL. Every existing row becomes `tracked`, including anything
-- called "Dine-in". Guessing a policy from a channel's name is exactly `posSalesChannelId`'s
-- "dine" substring match (discovery 23 §2), whose consequence was recorded as "the day simply
-- reports less money". A store that wants `instant` says so on the screen.
-- ⚠️ On production this backfill touches nothing: DEF-207's whole point is that `sales_channels`
-- has no production writer, and there are no organizations yet.
ALTER TABLE "sales_channels" ADD COLUMN "wastage_type_mode" text DEFAULT 'tracked' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_wastage_type_mode_check"
	CHECK ("wastage_type_mode" IN ('tracked', 'instant'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `order_wastages.channel_id` — the pointer T-178 deferred and T-230 can afford.
--
-- T-178 resolved the channel BY NAME at posting time and said why: "that is the one moment a party
-- is actually needed for the 1220 leg". ⭐ **T-230 removes that reason.** The mode must be derived
-- from the channel when the wastage is CREATED, so the channel is resolved there anyway — and a
-- text key that is only dereferenced later is a key that breaks under a rename. It did: renaming a
-- channel with an open tracked wastage against it left the row unresolvable by a human AND by the
-- 15-day backstop, because `findChannelByName` no longer matched.
--
-- ⚠️ `channel` (text) STAYS and is not redundant. It is the name the wastage was recorded under —
-- what the posted memo says. Renaming a channel must not retroactively change what a posted memo
-- claims. `channel_id` answers *which channel*; `channel` answers *what it was called at the time*.
ALTER TABLE "order_wastages" ADD COLUMN "channel_id" uuid;--> statement-breakpoint

UPDATE "order_wastages" w SET "channel_id" = c.id
	FROM "sales_channels" c
	WHERE c.org_id = w.org_id AND c.store_id = w.store_id
	  AND lower(trim(c.name)) = lower(trim(w.channel));--> statement-breakpoint

-- ⚠️ IF THE NEXT STATEMENT FAILS, a database holds an `order_wastages` row whose channel name
-- matches no channel — which is the free-text typo this task exists partly to close, made visible.
-- ⛔ That is a DATA fix on that database (delete the orphan, or create the channel it names). It is
-- NEVER a reason to leave this column nullable: a nullable pointer is the by-name design again,
-- wearing a uuid. Production holds zero `order_wastages` rows; there are no organizations yet.
ALTER TABLE "order_wastages" ALTER COLUMN "channel_id" SET NOT NULL;--> statement-breakpoint

-- ⛔ RESTRICT, matching every other FK on this table: a channel with wastages against it is
-- DEACTIVATED, never deleted. v1 shipped a hard delete beside its own isActive flag; that is the
-- verb T-230 corrects rather than duplicates.
ALTER TABLE "order_wastages" ADD CONSTRAINT "order_wastages_channel_id_sales_channels_id_fk"
	FOREIGN KEY ("channel_id") REFERENCES "sales_channels"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- The posting path and the settlement matcher both key on this now.
CREATE INDEX "order_wastages_channel_id_idx" ON "order_wastages" ("channel_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Uniqueness on NORMALISED identity — bible §4.4 rule 3, DEF-205.
--
-- The shipped index is `(org_id, store_id, name)`: case- and whitespace-SENSITIVE, so `Rent` and
-- `rent ` both insert. Harmless while `sales_channels` had no writer at all; live the moment
-- T-230's create path ships, which is why it lands in THIS migration and not a later one. The
-- rule's own words: "A manual add that collides with a seeded row is rejected BY THE DATABASE."
--
-- ⚠️ Drizzle's builder cannot express an expression index, so `schema/sales-days.ts` now carries a
-- NOTE comment where its `uniqueIndex(...)` line used to be — exactly as `positions`
-- (`employment.ts:126-134`) already documents for its own identity rule. Restoring that line would
-- let a future `db:generate` "fix" the drift by dropping this index and recreating the broken one.
--
-- ⚠️ It spans ACTIVE AND INACTIVE rows on purpose. `findChannelByName` resolves with `limit 1` and
-- no ordering; two rows sharing a name — one retired, one live — would make which receivable a
-- wastage posts against a matter of which row Postgres happened to return first.
DROP INDEX "sales_channels_org_id_store_id_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_org_id_store_id_name_unique"
	ON "sales_channels" ("org_id", "store_id", lower(trim("name")));

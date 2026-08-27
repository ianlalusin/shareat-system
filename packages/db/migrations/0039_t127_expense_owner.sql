-- 0039 — T-127: a PERSONAL expense names its owner.
--
-- HAND-WRITTEN, like 0020-0038. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ A personal expense put through the business belongs to a specific owner, and that owner's
-- policy decides where it lands: `1260` Due from owners when the money is expected back, `3200`
-- Owner's drawings when it is not.
--
-- ⛔ Without this column the expense cannot name the owner, and an unattributed personal expense
-- ESCAPES THAT OWNER'S DRAWING LIMIT entirely — the money leaves, and the cap never sees it.
--
-- ⚠️ Nullable, and enforced at APPROVE rather than by a CHECK: a draft may legitimately exist before
-- anyone has chosen the owner, and the category that makes it required is on another table. The
-- block lives in `routeExpense`, which names the reason the way invariant 7 does for an unmapped
-- category — it never defaults to "some owner".
--
-- ⚠️ This should have ridden along with 0036. It did not, and the schema was ahead of the database
-- until the expense tests failed loudly on the missing column — which is the gate working.

ALTER TABLE "expenses" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_owner_id_owners_id_fk"
	FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict;

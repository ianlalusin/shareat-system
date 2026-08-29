-- 0060 — T-152: the remittance cadence and the un-remitted ceiling. Bible row 129.
--
-- HAND-WRITTEN, like 0020-0059. See DEF-073 for why `db:generate` cannot be used here.
--
-- ⭐ WHY THIS EXISTS: T-143 shipped POOLING — the capability that lets a store's cash sit across
-- several days before it is carried to the office — and its own §7 rule 5 says plainly that it
-- *"surfaces the figure [the ceiling] watches but does not enforce the ceiling."*
-- **So the risk shipped and the guard did not.** This is the guard.
--
-- ⛔ THE CHECK CONSTRAINT IS THE WHOLE DESIGN, so it is worth stating why it is shaped this way.
--
-- Row 129's warning is not "a long cadence is bad" and not "no ceiling is bad" — it is that the
-- two together are the failure: *"a store on a weekly cadence accumulates seven days of cash, and
-- ₱200/day versus ₱20,000/day is the same number of days and a completely different amount sitting
-- in a drawer. The risk is the AMOUNT, not the days."*
--
-- So the constraint makes that COMBINATION unrepresentable rather than merely discouraged:
--
--   remittance_cadence = 'daily'  ->  ceiling optional (daily remittance is itself the bound)
--   anything else                 ->  ceiling REQUIRED
--
-- You cannot opt into pooling without naming the number that bounds it. Same instinct as T-136 §6's
-- closed cadence list: *if a setting can be set to something unsafe, eventually it will be, and
-- nobody will notice.*
--
-- ⚠️ AND WHY THESE ARE COLUMNS ON `stores`, NOT A `store_cash_policies` TABLE.
--
-- Row 129: *"a store with none configured must not silently mean 'never'. Default to daily, the
-- safe end."* A NOT NULL column with a DEFAULT on the row every store already has makes "unset"
-- impossible by construction. A separate table reintroduces exactly that hole as a MISSING ROW
-- instead of a null column — which is harder to notice, not easier. The grouping a policy table
-- would buy is worth less than the guarantee.
--
-- ⚠️ NOT NULL with a DEFAULT is safe on an existing table here: every current row takes 'daily',
-- which is what every store does today, so no backfill and no behaviour change.

ALTER TABLE "stores"
  ADD COLUMN "remittance_cadence" text NOT NULL DEFAULT 'daily';--> statement-breakpoint

ALTER TABLE "stores"
  ADD COLUMN "unremitted_ceiling" numeric(14, 2);--> statement-breakpoint

ALTER TABLE "stores"
  ADD CONSTRAINT "stores_remittance_cadence_check"
  CHECK ("remittance_cadence" in ('daily', 'every_3_days', 'weekly', 'monthly'));--> statement-breakpoint

-- ⭐ The one that matters. See the header.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_pooling_requires_ceiling_check"
  CHECK ("remittance_cadence" = 'daily' OR "unremitted_ceiling" IS NOT NULL);--> statement-breakpoint

-- A ceiling of zero would mean "remit before you sell anything", which is not a policy anyone
-- wants and is far more likely to be an unfilled form than an intention.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_unremitted_ceiling_positive_check"
  CHECK ("unremitted_ceiling" IS NULL OR "unremitted_ceiling" > 0);

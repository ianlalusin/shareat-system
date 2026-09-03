-- 0121 — T-172: the branch-order WORKFLOW the ledger side (0070) was built for. DEF-136.
--
-- HAND-WRITTEN, like 0020-0120. See DEF-073 / DEF-121 for why `db:generate` cannot be used here.
--
-- 0070 added the columns, the one-open-order index and the submit-hardening trigger, and then the
-- eight functions that would drive them were never built (DEF-136). Building them on 2026-09-03
-- found two rules the database still refused, and one it did not yet enforce:
--
-- 1. ⭐ A FULFILLED QUANTITY OF ZERO IS A REAL ANSWER. v1's markOrderReadyAction says so in its own
--    comment — "zero is the commissary's way of saying 'we couldn't fulfill this line'" — and a
--    REJECTED substitution is zero-fulfilled too ("declined — don't bill it"). But 0053's
--    `trade_order_lines_total_positive_check` (`line_total > 0`) made both unrepresentable, so
--    the only way to say "none of this" was to delete the branch's own line, which invariant 10
--    forbids the commissary from doing. Relaxed for exactly that case and no other: a line may
--    total zero when, and only when, its fulfilled quantity is zero. A sale line still cannot
--    bill nothing.
--
-- 2. ⭐ DISPATCH OF A BRANCH ORDER NEEDS THE SAME DATABASE-SIDE GUARD SUBMIT HAS. The commissary
--    must have marked it ready, and no commissary-added line may still be awaiting the branch's
--    answer (invariant 5). The trigger function is REPLACED to cover the dispatch flip as well as
--    the submit one — the name is kept, because the name is what 0070's tests and comments cite.
--
-- 3. The stage columns 0070 added have SHAPES that were only ever described: ready implies
--    accepted; accepted implies a branch order; a rejection carries who and why and voids the row.
--    Written down as CHECKs, per RULES §6.3 — "the database enforces the rules, not the service
--    layer."
--
-- ⛔ No new status values. 0070 kept `draft | confirmed | dispatched | received | void` on purpose
-- and added `accepted_at` / `ready_at` / `rejected_at` instead: submitted, accepted and ready are
-- DERIVED stages of a `confirmed` order (bible §4.2 — derive, don't store), and a status that
-- changes nothing about the books is a label, not a state.

-- ---------------------------------------------------------------------------------------------
-- 1. Zero fulfilment.
ALTER TABLE "trade_order_lines" DROP CONSTRAINT "trade_order_lines_total_positive_check";--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_total_positive_check"
	CHECK ("line_total" > 0 OR ("fulfilled_quantity" IS NOT NULL AND "fulfilled_quantity" = 0 AND "line_total" = 0));--> statement-breakpoint
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_fulfilled_quantity_check"
	CHECK ("fulfilled_quantity" IS NULL OR "fulfilled_quantity" >= 0);--> statement-breakpoint
-- ⚠️ A branch's ask is never zero. v1 queued auto-order lines at quantity 0 and then had to block
-- submit on them; v2 arrives with a suggestion instead (T-175), so a zero here is a bug, not a
-- placeholder.
ALTER TABLE "trade_order_lines" ADD CONSTRAINT "trade_order_lines_requested_quantity_check"
	CHECK ("requested_quantity" IS NULL OR "requested_quantity" > 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Stage shapes on the order.
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_branch_stage_check"
	CHECK (("ready_at" IS NULL OR "accepted_at" IS NOT NULL)
	   AND ("accepted_at" IS NULL OR "requested_by_store_id" IS NOT NULL)
	   AND (("accepted_at" IS NULL) = ("accepted_by" IS NULL))
	   AND (("ready_at" IS NULL) = ("ready_by" IS NULL)));--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_rejected_shape_check"
	CHECK ((("rejected_at" IS NULL) = ("rejected_by" IS NULL))
	   AND (("rejected_at" IS NULL) = ("reject_reason" IS NULL))
	   AND ("rejected_at" IS NULL OR "status" = 'void'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. The trigger, now guarding BOTH flips.
--
-- ⚠️ The child table carries NO `line_no` — lines are identified by id (0070's own note). And a
-- plpgsql body is not validated until it RUNS: a wrong column name here applies cleanly and fails
-- in front of a user. `branch-orders.test.ts` exercises every RAISE below for that reason.
CREATE OR REPLACE FUNCTION "trade_orders_submit_hardening"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	bad_line text;
BEGIN
	-- Only an INTERNAL branch request is hardened here; an external sale has its own rules.
	IF NEW."requested_by_store_id" IS NULL THEN RETURN NEW; END IF;

	-- ---- SUBMIT: draft -> confirmed, exactly as 0070 wrote it. ------------------------------
	IF OLD."status" = 'draft' AND NEW."status" = 'confirmed' THEN
		SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
		WHERE l."order_id" = NEW."id"
		  AND (l."requested_quantity" IS NULL OR l."requested_quantity" <= 0)
		LIMIT 1;
		IF bad_line IS NOT NULL THEN
			RAISE EXCEPTION 'line % has no requested quantity', bad_line;
		END IF;

		SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
		WHERE l."order_id" = NEW."id" AND l."expense_category_id" IS NULL AND NOT l."is_ledger_only"
		LIMIT 1;
		IF bad_line IS NOT NULL THEN
			RAISE EXCEPTION 'line % has no expense category — the receipt would have nothing to post against', bad_line;
		END IF;

		SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
		WHERE l."order_id" = NEW."id" AND l."approval" = 'pending'
		LIMIT 1;
		IF bad_line IS NOT NULL THEN
			RAISE EXCEPTION 'line % is a commissary addition awaiting the branch decision', bad_line;
		END IF;

		RETURN NEW;
	END IF;

	-- ---- DISPATCH: anything -> dispatched. ---------------------------------------------------
	-- ⭐ Invariant 5's second half, at the database: a pending line counts toward nothing and lets
	-- the order reach neither "ready" nor the truck. And "ready" is the commissary's statement that
	-- the list is final — a branch order goes out only after it.
	IF NEW."status" = 'dispatched' AND OLD."status" <> 'dispatched' THEN
		IF NEW."ready_at" IS NULL THEN
			RAISE EXCEPTION 'a branch order is dispatched only after the commissary marks it ready';
		END IF;

		SELECT l."id"::text INTO bad_line FROM "trade_order_lines" l
		WHERE l."order_id" = NEW."id" AND l."approval" = 'pending'
		LIMIT 1;
		IF bad_line IS NOT NULL THEN
			RAISE EXCEPTION 'line % is a commissary addition awaiting the branch decision', bad_line;
		END IF;

		RETURN NEW;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- 0242 - T-511 S6a: several loan legs per channel settlement, and one acknowledgement of a difference.
-- docs/tasks/511-settlement-upload-s6-spec.md "S6a" (migration bullet); hand-authored per ADR-012 s5. Journal idx 242 (provisional, BOSS sets the final number at rebase time).
--
-- WHY. A Grab payout can dock two loans in one day (the Lipa October files carry loans of 591.24 and 1,771.88), and the settlement holds ONE loan in
-- channel_settlements.loan_id / loan_owner_store_id. This migration moves the loan out of the header into one row per leg, and gives the header a place for the
-- reason a person gave when they accepted a difference between the file and the day (either sign: a shortfall past tolerance used to be refused outright).
--
-- SHAPE.
--   channel_settlement_loan_legs      (id, org_id, settlement_id, loan_id, owner_store_id NOT NULL, amount numeric(14,2) > 0 and finite). Unique (settlement, loan,
--                                     owner store). A same-store leg carries the paying store's own id as owner (the backfill uses coalesce(loan_owner_store_id, store_id)).
--   channel_settlements               DROPS loan_id, loan_owner_store_id, channel_settlements_loan_shape_check and the two same-org twins (0194 owner store, 0213 loan);
--                                     ADDS difference_reason (text, NULL allowed, never blank when present). loan_deduction STAYS: it is the sum of the legs.
--   deferred constraint trigger       at commit sum(legs.amount) = channel_settlements.loan_deduction; a non-zero deduction needs at least one leg and a zero deduction has none
--                                     (SQLSTATE 23514, constraint channel_settlement_loan_legs_sum_check). A plain (origin) validator, NOT ENABLE ALWAYS: it is not an
--                                     immutability guard (the separate append-only guard of section 6 is). Copied from the closest precedent, 0218's inter_entity_shipments_check_billed_sum: runs as the invoker, sets app.org_id to the
--                                     ROW's organisation for its two lookups (RLS would otherwise hide the rows at commit), tolerates a header written before its legs.
--
-- BACKFILL. One leg per existing settlement that had a loan (any status, voided included), amount = loan_deduction, owner = coalesce(loan_owner_store_id, store_id). It runs BEFORE
-- RLS is forced and BEFORE the trigger exists, then a check proves every settlement's deduction equals the sum of its legs, so the new invariant holds from the first commit.
--
-- FOREIGN KEYS. Composite-only same-org twins (org_id, col) -> parent (org_id, id), never a bare single-column FK (t398 C1); the (org_id, id) uniques on channel_settlements
-- (0213), loans (0213) and stores (0194) already exist. MONEY. numeric(14,2) with the t327 finite check.
-- RLS and GRANTS (ADR-012 s5 rules 4 and 4a). ENABLE + FORCE and the policy channel_settlement_loan_legs_org_isolation on app_current_org(); the app role gets SELECT and INSERT
-- only: legs are history, a void reverses the journal entry and leaves them (no UPDATE, no DELETE, no TRUNCATE, no column-level UPDATE).
--
-- LOCK BUDGET. channel_settlements is a small table. First statement SET LOCAL lock_timeout = '5s' (resets at commit). Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1. the legs table
CREATE TABLE "channel_settlement_loan_legs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"owner_store_id" uuid NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	CONSTRAINT "channel_settlement_loan_legs_amount_positive_check" CHECK ("amount" > 0),
	CONSTRAINT "channel_settlement_loan_legs_amount_finite_check" CHECK ("amount" > '-Infinity'::numeric AND "amount" < 'Infinity'::numeric),
	CONSTRAINT "channel_settlement_loan_legs_settlement_loan_owner_key" UNIQUE ("settlement_id", "loan_id", "owner_store_id")
);
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" ADD CONSTRAINT "channel_settlement_loan_legs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" ADD CONSTRAINT "channel_settlement_loan_legs_settlement_id_same_org_fk" FOREIGN KEY ("org_id", "settlement_id") REFERENCES "public"."channel_settlements"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" ADD CONSTRAINT "channel_settlement_loan_legs_loan_id_same_org_fk" FOREIGN KEY ("org_id", "loan_id") REFERENCES "public"."loans"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" ADD CONSTRAINT "channel_settlement_loan_legs_owner_store_id_same_org_fk" FOREIGN KEY ("org_id", "owner_store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "channel_settlement_loan_legs_org_loan_idx" ON "channel_settlement_loan_legs" ("org_id", "loan_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. backfill: one leg per existing settlement that had a loan. Runs as the owner before RLS is forced and before the trigger exists.
DO $$
DECLARE
	n bigint;
BEGIN
	SELECT count(*) INTO n FROM "channel_settlements" WHERE "loan_id" IS NOT NULL AND "loan_deduction" <= 0;
	IF n > 0 THEN
		RAISE EXCEPTION '0242: % channel settlement(s) name a loan but deduct no positive amount; fix them before this migration can make one leg of each.', n;
	END IF;
END;
$$;
--> statement-breakpoint
INSERT INTO "channel_settlement_loan_legs" ("org_id", "settlement_id", "loan_id", "owner_store_id", "amount")
SELECT cs."org_id", cs."id", cs."loan_id", coalesce(cs."loan_owner_store_id", cs."store_id"), cs."loan_deduction"
FROM "channel_settlements" cs
WHERE cs."loan_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
	n bigint;
BEGIN
	SELECT count(*) INTO n FROM "channel_settlements" cs
	WHERE cs."loan_deduction" <> coalesce((SELECT sum(l."amount") FROM "channel_settlement_loan_legs" l WHERE l."settlement_id" = cs."id"), 0);
	IF n > 0 THEN
		RAISE EXCEPTION '0242: % channel settlement(s) have a loan_deduction that is not the sum of their backfilled legs.', n;
	END IF;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. channel_settlements: the single loan goes (dropping a column drops its single-column FK), difference_reason arrives
ALTER TABLE "channel_settlements" DROP CONSTRAINT "channel_settlements_loan_shape_check";
--> statement-breakpoint
ALTER TABLE "channel_settlements" DROP CONSTRAINT "channel_settlements_loan_id_same_org_fk";
--> statement-breakpoint
ALTER TABLE "channel_settlements" DROP CONSTRAINT "channel_settlements_loan_owner_store_id_same_org_fk";
--> statement-breakpoint
ALTER TABLE "channel_settlements" DROP COLUMN "loan_id";
--> statement-breakpoint
ALTER TABLE "channel_settlements" DROP COLUMN "loan_owner_store_id";
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD COLUMN "difference_reason" text;
--> statement-breakpoint
ALTER TABLE "channel_settlements" ADD CONSTRAINT "channel_settlements_difference_reason_not_blank_check" CHECK ("difference_reason" IS NULL OR length(btrim("difference_reason", E' \t\r\n')) > 0);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. RLS and grants on the new table
ALTER TABLE "channel_settlement_loan_legs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "channel_settlement_loan_legs_org_isolation" ON "channel_settlement_loan_legs" USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "channel_settlement_loan_legs" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "channel_settlement_loan_legs" TO "shareat_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. the deferred "legs add up to loan_deduction" check, on both tables
CREATE FUNCTION "channel_settlement_loan_legs_check_sum"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
	v_ids uuid[];
	v_org uuid;
	v_prev text;
	v_id uuid;
	v_deduction numeric;
	v_sum numeric;
	v_n bigint;
	v_found boolean;
BEGIN
	-- As 0218's billed-sum check: the check must not depend on the org context the session carries when it runs at commit (RLS would hide the header and the check would
	-- skip). It runs as the invoker (no new definer) and sets app.org_id to the ROW's own organisation for the two lookups, then puts the previous value back.
	-- Deferred to the end of the transaction: the domain writes the header first, its legs after.
	IF TG_TABLE_NAME = 'channel_settlements' THEN
		IF TG_OP = 'DELETE' THEN
			RETURN NULL;
		END IF;
		v_ids := ARRAY[NEW."id"];
		v_org := NEW."org_id";
	ELSE
		v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD."org_id" ELSE NEW."org_id" END;
		v_ids := ARRAY[]::uuid[];
		IF TG_OP <> 'DELETE' THEN v_ids := v_ids || NEW."settlement_id"; END IF;
		IF TG_OP <> 'INSERT' THEN v_ids := v_ids || OLD."settlement_id"; END IF;
	END IF;
	v_prev := coalesce(current_setting('app.org_id', true), '');
	FOR v_id IN SELECT DISTINCT x FROM unnest(v_ids) x LOOP
		PERFORM set_config('app.org_id', v_org::text, true);
		SELECT s."loan_deduction" INTO v_deduction FROM "channel_settlements" s WHERE s."id" = v_id;
		v_found := FOUND;
		SELECT count(*), coalesce(sum(l."amount"), 0) INTO v_n, v_sum FROM "channel_settlement_loan_legs" l WHERE l."settlement_id" = v_id;
		PERFORM set_config('app.org_id', v_prev, true);
		IF NOT v_found THEN
			-- Header gone (a purge deletes legs, then the header): nothing to check. Legs without a header cannot stand.
			IF v_n > 0 THEN
				RAISE EXCEPTION 'A loan leg has no channel settlement.' USING ERRCODE = '23514', CONSTRAINT = 'channel_settlement_loan_legs_sum_check';
			END IF;
			CONTINUE;
		END IF;
		-- v_sum is 0 when there is no leg, so one comparison covers all three rules: legs = deduction, a deduction needs a leg, a zero deduction has none.
		IF v_sum <> v_deduction THEN
			RAISE EXCEPTION 'The loan legs add up to % but the settlement deducts % for loans (% leg(s)).', v_sum, v_deduction, v_n
				USING ERRCODE = '23514', CONSTRAINT = 'channel_settlement_loan_legs_sum_check';
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "channel_settlement_loan_legs_check_sum"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "channel_settlements_loan_legs_sum_trg"
	AFTER INSERT OR UPDATE OF "loan_deduction" ON "channel_settlements"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "channel_settlement_loan_legs_check_sum"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "channel_settlement_loan_legs_sum_trg"
	AFTER INSERT OR UPDATE OF "amount", "settlement_id" OR DELETE ON "channel_settlement_loan_legs"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "channel_settlement_loan_legs_check_sum"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. legs are append-only history: a leg is never edited or removed (a void reverses the journal entry and leaves the legs). House pattern: 0183 sales_day_pos_corrections,
-- 0221 pay_rates, 0239 business_rule_values. BEFORE UPDATE OR DELETE, ENABLE ALWAYS (T-354 / DEF-487) so session_replication_role = replica cannot switch it off. The cutover
-- purge uses TRUNCATE, which a row trigger does not see.
CREATE FUNCTION "channel_settlement_loan_legs_refuse_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A settlement loan leg is never changed or removed (% on row % is refused). A void reverses the settlement and leaves its legs as history.',
		TG_OP, COALESCE(OLD.id::text, '?')
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "channel_settlement_loan_legs_refuse_mutation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "channel_settlement_loan_legs_append_only"
	BEFORE UPDATE OR DELETE ON "channel_settlement_loan_legs"
	FOR EACH ROW EXECUTE FUNCTION "channel_settlement_loan_legs_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "channel_settlement_loan_legs" ENABLE ALWAYS TRIGGER "channel_settlement_loan_legs_append_only";

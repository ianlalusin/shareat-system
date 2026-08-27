-- 0029 — T-142: the five money accounts every store must always have. Bible row 156.
--
-- Ian, 2026-08-26: "all stores must have these accounts, seeded and configurable but can never be
-- terminated as long as store is active … these 5 accounts must always be present and available
-- since they are the foundation of money movement."
--
-- ## ⭐ Why a TRIGGER and not a service call
--
-- There is no `createStore` service. Stores arrive from the seed, from the ETL, from the cutover,
-- and one day from an admin screen — four paths, and "must always be present" is an invariant, not
-- a step any of them should have to remember. The same reasoning already put ledger balance,
-- immutability and period-open in triggers rather than in callers.
--
-- ⚠️ And it is load-bearing NOW, not eventually: since T-139 a cash expense payment must name a
-- money account, so a store without one cannot record a cash expense at all. A store created
-- without its five is a store that silently cannot trade.

--> statement-breakpoint
ALTER TABLE "money_accounts" ADD COLUMN "is_foundation" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ⛔ One foundation account per shape per store — so a re-run cannot mint a second "Cashier cash".
CREATE UNIQUE INDEX "money_accounts_foundation_unique"
	ON "money_accounts" ("store_id", "instrument", "custodian")
	WHERE "is_foundation";--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- The seeder, callable and idempotent.
-- ---------------------------------------------------------------------------------------
-- ⚠️ ON CONFLICT DO NOTHING against the partial index, so calling it twice is free. That matters:
-- the backfill below and the trigger both call it, and a store created during the migration would
-- otherwise be seeded twice.
CREATE OR REPLACE FUNCTION "seed_foundation_money_accounts"(p_org_id uuid, p_store_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_foundation)
	VALUES
		-- The GL code is DERIVED from kind + holder, exactly as glCodeFor() does in the domain.
		-- Cash splits by custodian because each is reconciled separately; every wallet shares 1140
		-- because the line names which one (ADR-010 §2).
		(p_org_id, p_store_id, 'Cashier cash',   'cash',    '1110', 'cashier', true),
		(p_org_id, p_store_id, 'Cashier online', 'ewallet', '1140', 'cashier', true),
		(p_org_id, p_store_id, 'Office cash',    'cash',    '1130', 'office',  true),
		(p_org_id, p_store_id, 'Office online',  'ewallet', '1140', 'office',  true),
		(p_org_id, p_store_id, 'Staff float',    'cash',    '1120', 'staff',   true)
	ON CONFLICT DO NOTHING;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Every new store gets them, whichever path created it.
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "trg_seed_foundation_money_accounts"()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM seed_foundation_money_accounts(NEW.org_id, NEW.id);
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "stores_seed_foundation_money_accounts"
	AFTER INSERT ON "stores"
	FOR EACH ROW
	EXECUTE FUNCTION "trg_seed_foundation_money_accounts"();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Backfill: adopt what already matches, then fill the gaps.
-- ---------------------------------------------------------------------------------------
-- ⭐ ADOPT BEFORE SEEDING, and in this order on purpose. A store that already has a hand-made
-- "Cashier drawer" (cash/cashier) should keep it — with its name, its notes and, crucially, its
-- JOURNAL HISTORY. Seeding first and adopting second would leave two tills per store, one holding
-- every peso ever counted and one holding nothing.
UPDATE money_accounts ma SET is_foundation = true
WHERE NOT ma.is_foundation
	AND ma.is_active
	AND (ma.instrument, ma.custodian) IN
		(('cash','cashier'), ('ewallet','cashier'), ('cash','office'), ('ewallet','office'), ('cash','staff'))
	-- ⚠️ Only when it is the store's ONLY account of that shape. Where a store already has two
	-- wallets, which one is "the" cashier wallet is a judgement this migration must not make
	-- silently — it seeds a fresh one instead and leaves the existing ones ordinary.
	AND (
		SELECT count(*) FROM money_accounts m2
		WHERE m2.store_id = ma.store_id AND m2.instrument = ma.instrument
			AND m2.custodian = ma.custodian AND m2.is_active
	) = 1;--> statement-breakpoint

DO $$
DECLARE s RECORD;
BEGIN
	FOR s IN SELECT id, org_id FROM stores LOOP
		PERFORM seed_foundation_money_accounts(s.org_id, s.id);
	END LOOP;
END;
$$;

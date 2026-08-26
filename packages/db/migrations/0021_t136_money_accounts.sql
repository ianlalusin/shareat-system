-- 0021 — T-136 / ADR-010 (docs/decisions/ADR-010-money-locations-and-ownership.md,
-- bible rows 142–147): `money_accounts` — every place money physically sits, and who holds it.
--
-- Hand-written, no drizzle-kit snapshot, matching 0002/0004/0005/0020's precedent. The RLS
-- policy below is the reason: drizzle-kit does not generate policies, and a registry entry
-- without one is "a promise, not a control" (packages/db/src/rls/registry.ts's own words).
--
-- ## Why a table and not more accounts
--
-- ADR-010's test: does it get reconciled against something OUTSIDE the books? A drawer is
-- counted, a safe is counted, a wallet has a statement — each is a real place, so each is a row.
-- Nobody reconciles "the cashier" against an external document, so ownership is an ATTRIBUTE of
-- the place, never a tick on a transaction (DEF-058).
--
-- ⚠️ The chart is NOT extended per wallet. v1 minted `online__{paymentAccountId}` GL accounts and
-- the chart grew with the business — and the v1 audit rolled every one of them back up into a
-- single 1140 line anyway. A new wallet here is a new ROW; the chart never moves.
--
-- ## The two views this enables, from ONE set of journal lines
--
--   general  (the accountant's)  group by gl_account_code   -> "Cash on hand … E-wallets …"
--   internal (Ian's)             join here, group by custodian
--                                -> "cashier holds ₱18,400 cash + ₱6,200 online"
--
-- ⭐ And UNDEPOSITED FUNDS falls out for free (bible row 143): it is the balance of every money
-- account whose custodian is 'cashier'. No account for it, no posting, nothing to drift — which
-- is why the earlier plan to add one was withdrawn.

--> statement-breakpoint
CREATE TABLE "money_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instrument" text NOT NULL,
	"gl_account_code" text NOT NULL,
	"custodian" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "money_accounts_custodian_check" CHECK ("money_accounts"."custodian" in ('cashier', 'office', 'staff')),
	CONSTRAINT "money_accounts_instrument_check" CHECK ("money_accounts"."instrument" in ('cash', 'ewallet', 'bank')),
	-- A money account must roll into a money-holding account. Without this a wallet could be
	-- pointed at 4100 revenue, and the internal view would silently include figures that are
	-- not money at all.
	CONSTRAINT "money_accounts_gl_code_is_money_check" CHECK ("money_accounts"."gl_account_code" ~ '^11[0-9]{2}$'),
	CONSTRAINT "money_accounts_name_not_blank_check" CHECK (length(trim("money_accounts"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- One name per store. Two "GCash" rows at one branch is exactly the ambiguity this table exists
-- to remove: per ACCOUNT, not per provider (bible row 142), so they must be named apart.
CREATE UNIQUE INDEX "money_accounts_org_store_name_unique" ON "money_accounts" ("org_id","store_id","name");--> statement-breakpoint
CREATE INDEX "money_accounts_org_custodian_idx" ON "money_accounts" ("org_id","custodian");--> statement-breakpoint
CREATE INDEX "money_accounts_org_store_idx" ON "money_accounts" ("org_id","store_id");--> statement-breakpoint

-- RLS. FORCE is required as well as ENABLE: without it the table owner bypasses its own policy,
-- and the owner is what migrations and any superuser connection run as. The business reason is
-- sharper here than for most tables — a franchise seeing another org's money accounts would learn
-- which banks and e-wallet providers it uses from the names alone.
ALTER TABLE "money_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "money_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "money_accounts_org_isolation" ON "money_accounts"
	FOR ALL
	USING ("org_id" = app_current_org())
	WITH CHECK ("org_id" = app_current_org());

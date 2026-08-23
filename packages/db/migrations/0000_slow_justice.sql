-- Hand-augmented per docs/tasks/101-core-schema.md Contract §8. Drizzle cannot express:
--   1. the btree_gist extension (this statement)
--   2. the EXCLUDE USING gist no-overlap constraint on fiscal_periods
--   3. the expression-based unique index on person_identities
--   4. the cross-row "postable accounts may not have children" trigger on accounts
--      (Contract §5 — required by the spec's imperative "enforce", but not one of the
--      three augmentations the Method section names; see the task report).
-- Once applied, this file is never edited (bible §2 rule 8) — a further change is a new
-- migration.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "organizations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Manila' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "person_identities_kind_check" CHECK ("person_identities"."kind" in ('firebase_uid', 'phone', 'email', 'staff_no', 'device_hash'))
);
--> statement-breakpoint
-- Hand-added (Contract §8): the identity-defining rule. An expression index — Drizzle's
-- uniqueIndex().on() builder takes columns, not arbitrary SQL expressions here. One
-- normalised phone/email/etc. cannot belong to two people, and case/whitespace variants
-- of the same value collide with it.
CREATE UNIQUE INDEX "person_identities_kind_value_unique" ON "person_identities" ("kind", lower(trim("value")));
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"normal_balance" text NOT NULL,
	"parent_id" uuid,
	"is_postable" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"legacy_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" in ('asset', 'liability', 'equity', 'income', 'expense')),
	CONSTRAINT "accounts_normal_balance_check" CHECK ("accounts"."normal_balance" in ('debit', 'credit')),
	CONSTRAINT "accounts_status_check" CHECK ("accounts"."status" in ('active', 'reserved', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "fiscal_periods_status_check" CHECK ("fiscal_periods"."status" in ('open', 'closed', 'locked')),
	CONSTRAINT "fiscal_periods_ends_on_check" CHECK ("fiscal_periods"."ends_on" >= "fiscal_periods"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_person_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_source_check" CHECK ("audit_log"."source" in ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl'))
);
--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identities" ADD CONSTRAINT "person_identities_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_persons_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_person_id_persons_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-added (Contract §6 / §8): no two fiscal periods in the same org may cover
-- overlapping dates. Requires btree_gist (created at the top of this migration) for the
-- org_id WITH = operator to be available to a gist index.
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_no_overlap" EXCLUDE USING gist (
	"org_id" WITH =,
	daterange("starts_on", "ends_on", '[]') WITH &&
);
--> statement-breakpoint
-- Hand-added (Contract §5): "a postable account may not have children" is cross-row — it
-- depends on the OTHER row's is_postable, not just the row being written — so it cannot
-- be a plain CHECK constraint. Enforced both directions: a new/updated child may not
-- point at a postable parent, and an account with existing children may not be marked
-- postable.
CREATE FUNCTION "accounts_enforce_postable_no_children"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	parent_is_postable boolean;
	child_count integer;
BEGIN
	IF NEW.parent_id IS NOT NULL THEN
		SELECT is_postable INTO parent_is_postable FROM accounts WHERE id = NEW.parent_id;
		IF parent_is_postable THEN
			RAISE EXCEPTION
				'account % cannot reference % as parent_id because % is postable (is_postable = true)',
				NEW.id, NEW.parent_id, NEW.parent_id;
		END IF;
	END IF;

	IF NEW.is_postable THEN
		SELECT count(*) INTO child_count FROM accounts WHERE parent_id = NEW.id;
		IF child_count > 0 THEN
			RAISE EXCEPTION
				'account % cannot be marked is_postable = true because it has % child account(s)',
				NEW.id, child_count;
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "accounts_postable_no_children"
	BEFORE INSERT OR UPDATE ON "accounts"
	FOR EACH ROW EXECUTE FUNCTION "accounts_enforce_postable_no_children"();
--> statement-breakpoint
CREATE UNIQUE INDEX "stores_org_id_code_unique" ON "stores" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "person_identities_person_id_idx" ON "person_identities" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_id_code_unique" ON "accounts" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_id_legacy_code_unique" ON "accounts" USING btree ("org_id","legacy_code") WHERE "accounts"."legacy_code" is not null;--> statement-breakpoint
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");
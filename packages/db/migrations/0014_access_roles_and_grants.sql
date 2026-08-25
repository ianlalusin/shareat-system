-- 0014 — T-121: roles and access. docs/tasks/121-roles-and-access.md, bible rows 114-116,
-- CAPABILITY-MATRIX.md.
--
-- Three tables because the three axes are independent (bible row 114): organization (T-120,
-- already done) · store scope (rows, never a bypass) · role + per-person grants (what a
-- person may do). None substitutes for another — `authorize()` (packages/auth) checks all
-- three, always.
--
-- CREATE TABLE / FK / index statements below this comment are DRIZZLE-GENERATED from
-- packages/db/schema/access.ts, unedited. The RLS section at the end of this file is
-- HAND-ADDED, following the exact pattern migration 0011 established (drizzle-kit does not
-- generate RLS policies): ENABLE + FORCE ROW LEVEL SECURITY, then a policy per table, scoped
-- per its packages/db/src/rls/registry.ts entry. 0000-0013 are applied and never edited
-- (bible §2 rule 8).

CREATE TABLE "person_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"grant_name" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "person_roles_role_check" CHECK ("person_roles"."role" in ('super_admin', 'admin', 'manager', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "person_store_scope" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_grants" ADD CONSTRAINT "person_grants_granted_by_persons_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_granted_by_persons_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_store_scope" ADD CONSTRAINT "person_store_scope_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_store_scope" ADD CONSTRAINT "person_store_scope_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_store_scope" ADD CONSTRAINT "person_store_scope_granted_by_persons_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_grants_person_id_idx" ON "person_grants" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_grants_active_person_grant_unique" ON "person_grants" USING btree ("person_id","grant_name") WHERE "person_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "person_roles_person_id_idx" ON "person_roles" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_roles_org_id_idx" ON "person_roles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_roles_active_person_org_unique" ON "person_roles" USING btree ("person_id","org_id") WHERE "person_roles"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "person_store_scope_person_id_store_id_unique" ON "person_store_scope" USING btree ("person_id","store_id");--> statement-breakpoint
CREATE INDEX "person_store_scope_person_id_idx" ON "person_store_scope" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_store_scope_store_id_idx" ON "person_store_scope" USING btree ("store_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- RLS — hand-added, matching packages/db/src/rls/registry.ts entries for these three
-- tables exactly. A registry entry with no policy here is a promise, not a control.
-- ---------------------------------------------------------------------------------------

-- person_roles carries org_id directly — org_column, same pattern as persons/accounts.
ALTER TABLE "person_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_roles_org_isolation" ON "person_roles" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint

-- person_store_scope and person_grants have no org_id of their own — derived through the
-- person they name, same pattern as person_identities in migration 0011.
ALTER TABLE "person_store_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person_store_scope" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_store_scope_via_person" ON "person_store_scope" FOR ALL
	USING (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_store_scope"."person_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_store_scope"."person_id" AND p."org_id" = app_current_org()));
--> statement-breakpoint

ALTER TABLE "person_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_grants_via_person" ON "person_grants" FOR ALL
	USING (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_grants"."person_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_grants"."person_id" AND p."org_id" = app_current_org()));
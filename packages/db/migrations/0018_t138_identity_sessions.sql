CREATE TABLE "person_credentials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"store_id" uuid,
	"secret_hash" text,
	"lookup_hash" text,
	"external_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "person_credentials_kind_check" CHECK ("person_credentials"."kind" in ('pin', 'firebase', 'biometric')),
	CONSTRAINT "person_credentials_shape_check" CHECK (
        ("person_credentials"."kind" = 'pin' and "person_credentials"."store_id" is not null and "person_credentials"."secret_hash" is not null
           and "person_credentials"."lookup_hash" is not null and "person_credentials"."external_id" is null)
        or ("person_credentials"."kind" = 'firebase' and "person_credentials"."external_id" is not null
           and "person_credentials"."secret_hash" is null and "person_credentials"."lookup_hash" is null)
        or ("person_credentials"."kind" = 'biometric' and "person_credentials"."store_id" is not null)
      )
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"token_hash" text NOT NULL,
	"person_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_kind" text NOT NULL,
	"store_id" uuid,
	"device_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_credential_kind_check" CHECK ("sessions"."credential_kind" in ('pin', 'firebase', 'biometric')),
	CONSTRAINT "sessions_ended_reason_check" CHECK ("sessions"."ended_reason" is null or "sessions"."ended_reason" in ('signed_out', 'shift_end', 'revoked', 'superseded')),
	CONSTRAINT "sessions_ended_pair_check" CHECK (("sessions"."ended_at" is null and "sessions"."ended_reason" is null) or ("sessions"."ended_at" is not null and "sessions"."ended_reason" is not null)),
	CONSTRAINT "sessions_expiry_after_issue_check" CHECK ("sessions"."expires_at" > "sessions"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "person_credentials" ADD CONSTRAINT "person_credentials_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_credentials" ADD CONSTRAINT "person_credentials_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_credentials" ADD CONSTRAINT "person_credentials_revoked_by_persons_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_credential_id_person_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."person_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_credentials_lookup_hash_unique" ON "person_credentials" USING btree ("lookup_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "person_credentials_external_id_unique" ON "person_credentials" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "person_credentials_person_id_idx" ON "person_credentials" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_credentials_store_id_kind_idx" ON "person_credentials" USING btree ("store_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_person_id_idx" ON "sessions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "sessions_store_id_idx" ON "sessions" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- Row Level Security — hand-written; drizzle-kit does not generate policies.
-- Both tables reach their org through `persons`, the same pattern expense_payments uses
-- through expenses. FORCE matters as always: without it the owner bypasses its own policy,
-- so every test run as the owner would pass while a real tenant sees something else.
--
-- ⚠️ The org boundary is load-bearing here beyond the usual reason. A credential row visible
-- across orgs would expose which staff exist in another franchise, and a session row would
-- expose who is signed in, where, and until when — both before any question of the secrets,
-- which are hashed anyway.
-- ---------------------------------------------------------------------------------------

ALTER TABLE "person_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "person_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "person_credentials_via_person" ON "person_credentials" FOR ALL
	USING (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_credentials"."person_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "person_credentials"."person_id" AND p."org_id" = app_current_org()));
--> statement-breakpoint

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sessions_via_person" ON "sessions" FOR ALL
	USING (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "sessions"."person_id" AND p."org_id" = app_current_org()))
	WITH CHECK (EXISTS (SELECT 1 FROM "persons" p WHERE p."id" = "sessions"."person_id" AND p."org_id" = app_current_org()));

-- No GRANTs: migration 0011's ALTER DEFAULT PRIVILEGES already covers tables created later.

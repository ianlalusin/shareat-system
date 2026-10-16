-- 0202 - T-424 S5: pos_terminal_links, which POS v2 tablet is which ERP terminal person (Ruling 5, B1 fix).
-- docs/tasks/424-pos-v2-server-approvals.md; hand-authored per ADR-012 s5. Builds on 0201 (journal head).
--
-- WHY. A manager approval on the POS v2 server charges a wrong PIN to the TABLET's own bucket (an ERP terminal person, T-416).
-- The server must therefore map (POS store id, device id) to that person from a source a tablet cannot write: this table, written
-- only by the provisioning writer (provision_clock_terminal capability, audited), never by a request and never from Firestore.
--
-- SHAPE. One row per link; ACTIVE while revoked_at IS NULL. At most one active link per ERP store (ADR-015 A3: one tablet per
-- store) and per device id. A reinstall makes a new device id: the writer revokes the old row in the same transaction. Nothing is
-- ever deleted (no DELETE grant). pos_v1_store_links gains UNIQUE (org_id, id), the target of the same-org composite FK (T-398).
--
-- GRANTS. SELECT, INSERT, UPDATE for shareat_app (the writer revokes a row by UPDATE); no DELETE, TRUNCATE, REFERENCES, TRIGGER.
-- RLS. ENABLE + FORCE, one org-isolation policy through app_current_org() (DEF-077) with WITH CHECK (DEF-183).
-- No data is read, moved or deleted: nothing to precheck.
ALTER TABLE "pos_v1_store_links" ADD CONSTRAINT "pos_v1_store_links_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
CREATE TABLE "pos_terminal_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"pos_v1_store_link_id" uuid NOT NULL,
	"terminal_no" integer NOT NULL,
	"device_id" uuid NOT NULL,
	"terminal_person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "pos_terminal_links_terminal_no_check" CHECK ("terminal_no" > 0),
	CONSTRAINT "pos_terminal_links_revoked_shape_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_pos_link_id_fk" FOREIGN KEY ("pos_v1_store_link_id") REFERENCES "public"."pos_v1_store_links"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_terminal_person_id_persons_id_fk" FOREIGN KEY ("terminal_person_id") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_created_by_persons_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_revoked_by_persons_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_store_id_same_org_fk" FOREIGN KEY ("org_id", "store_id") REFERENCES "public"."stores"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_terminal_person_id_same_org_fk" FOREIGN KEY ("org_id", "terminal_person_id") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_created_by_same_org_fk" FOREIGN KEY ("org_id", "created_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_revoked_by_same_org_fk" FOREIGN KEY ("org_id", "revoked_by") REFERENCES "public"."persons"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ADD CONSTRAINT "pos_terminal_links_pos_v1_store_link_id_same_org_fk" FOREIGN KEY ("org_id", "pos_v1_store_link_id") REFERENCES "public"."pos_v1_store_links"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_terminal_links_active_store_unique" ON "pos_terminal_links" ("store_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pos_terminal_links_active_device_unique" ON "pos_terminal_links" ("device_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "pos_terminal_links_org_store_idx" ON "pos_terminal_links" ("org_id", "store_id");
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pos_terminal_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pos_terminal_links_org_isolation" ON "pos_terminal_links"
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "pos_terminal_links" FROM "shareat_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pos_terminal_links" TO "shareat_app";

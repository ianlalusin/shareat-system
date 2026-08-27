-- 0032 — T-141: the files the books point at. ADR-002 §3, bible row 155.
--
-- ## ⭐ Postgres stores the PATH, never the bytes
--
-- Which is what keeps the bucket a replaceable detail: moving to another bucket later is a copy
-- job plus a path rewrite, not a re-architecture.
--
-- ## ⛔ There is no public URL column
--
-- A stored URL is a PERMANENT UNAUTHENTICATED GRANT — exactly what getDownloadURL() hands out, and
-- exactly what this task exists to remove. Reads go through a route that calls authorize() and
-- mints a signed URL good for minutes.
--
-- ## ⭐ One table, not a URL column per feature
--
-- v1 grew SIX separate uploaders and none of them shared a check.

--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	-- Nullable: an org-level export belongs to no store.
	"store_id" uuid,
	"purpose" text NOT NULL,
	-- ⭐ Derived server-side from the session, NEVER accepted from the client.
	"storage_path" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum" text NOT NULL,
	-- Null until something claims it; the orphan sweep collects what is still null after a day.
	"linked_to" text,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_size_positive_check" CHECK ("stored_files"."byte_size" > 0),
	-- ⛔ The path must be the shape the broker builds. A row whose path did not come from the
	-- deriver is the one thing that would make every other guarantee here decorative.
	CONSTRAINT "stored_files_path_shape_check" CHECK ("stored_files"."storage_path" ~ '^orgs/[0-9a-f-]{36}/'),
	CONSTRAINT "stored_files_purpose_check" CHECK ("stored_files"."purpose" in
		('receipt_photo','ar_collection_proof','memo_document','wastage_dispute','onboarding_document'))
);
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_store_id_stores_id_fk"
	FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_persons_id_fk"
	FOREIGN KEY ("uploaded_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "stored_files_org_purpose_idx" ON "stored_files" ("org_id","purpose");--> statement-breakpoint
CREATE INDEX "stored_files_unlinked_idx" ON "stored_files" ("uploaded_at") WHERE "linked_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_path_unique" ON "stored_files" ("storage_path");--> statement-breakpoint

ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stored_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "stored_files_org_isolation" ON "stored_files" FOR ALL
	USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------------------
-- The expense seam. ⭐ The gate then checks a ROW, not a string.
-- ---------------------------------------------------------------------------------------
-- T-122 §5 says "no photo, no posting" and that control fires — but receipt_photo_url is a plain
-- text field, so it is satisfied by typing `x`. Pointing at a stored_files row makes the gate mean
-- what it says, and lets the service check the file belongs to the same org and store.
--
-- ⚠️ EXPAND ONLY (bible §15.5): receipt_photo_url stays for now. Contracting it is a separate
-- migration once nothing reads it.
ALTER TABLE "expenses" ADD COLUMN "receipt_file_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_file_id_stored_files_id_fk"
	FOREIGN KEY ("receipt_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE no action;

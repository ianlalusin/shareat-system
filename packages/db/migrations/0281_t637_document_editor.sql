-- 0281 - T-637: a document editor (JSON documents, field tags, letterhead, A4 page) and document kinds Ian edits. docs/tasks/637-document-editor.md; hand-authored per ADR-012 s5.
-- Journal idx 281: 0278-0280 are reserved by other lanes (the journal test allows a gap); `when` = 0277's + 86400000 x 4 (one day per index).
--
-- WHY. Templates were plain text with a tiny markup and a hard-coded list of five kinds. Ian (25 Nov): a real editor (bold, alignment, font, size, tables), fill-in field tags
-- inserted by typing {{, a letterhead, an exact A4 preview, and kinds he adds himself ("Explanation letter", "Incident report").
--
-- WHAT IT ADDS
--   document_kinds                      the org's list of kinds: name (1-40, trimmed, unique per org ignoring case), sort order, status active|retired. KEEP (master data).
--                                       Seeded for EVERY org with the five old kinds under readable names plus Explanation letter and Incident report.
--                                       (No numbering code column: the number DOC-YYYY-NNNN does not use the kind, so a code would be a field nothing reads.)
--   document_templates.kind_id          replaces the `kind` text column: NOT NULL, same-org composite FK, backfilled from the old value (coe, memo, nte, contract, other).
--   document_template_versions          + body_doc jsonb (the JSON document), margins (narrow|normal|wide, default normal), header_doc, footer_doc (jsonb, optional).
--   issued_document_versions            + body_doc jsonb. Older rows keep body_doc NULL and keep printing from `body`: an issued document is never rewritten.
--
-- NO ROW OF AN APPEND-ONLY TABLE IS TOUCHED. Existing template versions keep body_doc NULL; the app converts their `body` to a document in memory (`legacyBodyToDoc`) when one is opened,
-- and the first save writes a NEW version with body_doc. The old `body` column stays on every row for history (and holds the plain text of every new version).
--
-- BACKFILL (inside this file). Every template's `kind` is matched to its org's kind of that name. It STOPS (raises, nothing applied) if any template cannot be matched (a kind value outside the old five,
-- which the old CHECK made impossible), so no template can end with a NULL kind. The seed uses a fresh uuidv7 per row; an org with no templates simply gets the seven kinds.
-- GRANTS (ADR-012 s5 4a). shareat_app: SELECT, INSERT on document_kinds; UPDATE (name, sort_order, status, updated_at); never DELETE. document_templates' column UPDATE grant moves from `kind` to `kind_id`.
-- RLS ENABLE + FORCE, one org_isolation policy through app_current_org(). LOCK BUDGET: lock_timeout 5s first; one new table, ADD COLUMN with constant defaults (no rewrite), one UPDATE of document_templates (a handful of rows).
-- No new capability (manage_document_templates covers kinds), so log_break_glass_approval is untouched. No new trigger.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "document_kinds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "document_kinds_org_id_id_unique" UNIQUE ("org_id", "id"),
	CONSTRAINT "document_kinds_name_check" CHECK (char_length("name") BETWEEN 1 AND 40 AND "name" = btrim("name")),
	CONSTRAINT "document_kinds_status_check" CHECK ("status" IN ('active', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "document_kinds" ADD CONSTRAINT "document_kinds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "document_kinds_org_name_unique" ON "document_kinds" ("org_id", lower("name"));
--> statement-breakpoint
-- the seed: this list is also packages/db/seed/document-kinds.ts (a unit test keeps the two equal)
INSERT INTO "document_kinds" ("org_id", "name", "sort_order")
SELECT o."id", v."name", v."sort_order"
FROM "organizations" o
CROSS JOIN (VALUES
	('Certificate of employment', 10), ('Memo', 20), ('Notice to explain', 30), ('Contract', 40), ('Other', 50), ('Explanation letter', 60), ('Incident report', 70)
) AS v("name", "sort_order");
--> statement-breakpoint
ALTER TABLE "document_kinds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_kinds" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_kinds_org_isolation" ON "document_kinds" FOR ALL USING ("org_id" = app_current_org()) WITH CHECK ("org_id" = app_current_org());
--> statement-breakpoint
GRANT SELECT, INSERT ON "document_kinds" TO "shareat_app";
--> statement-breakpoint
GRANT UPDATE ("name", "sort_order", "status", "updated_at") ON "document_kinds" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "document_templates" ADD COLUMN "kind_id" uuid;
--> statement-breakpoint
DO $do$
DECLARE
	left_over integer;
BEGIN
	UPDATE "document_templates" t SET "kind_id" = k."id"
	FROM "document_kinds" k
	WHERE k."org_id" = t."org_id" AND k."name" = CASE t."kind"
		WHEN 'coe' THEN 'Certificate of employment' WHEN 'memo' THEN 'Memo' WHEN 'nte' THEN 'Notice to explain'
		WHEN 'contract' THEN 'Contract' WHEN 'other' THEN 'Other' END;
	SELECT count(*) INTO left_over FROM "document_templates" WHERE "kind_id" IS NULL;
	IF left_over > 0 THEN
		RAISE EXCEPTION 'T-637 STOP: % document template(s) have a kind that maps to no document kind. Report to BOSS; nothing was changed.', left_over;
	END IF;
END;
$do$;
--> statement-breakpoint
ALTER TABLE "document_templates" ALTER COLUMN "kind_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_templates" DROP COLUMN "kind";
--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_kind_id_document_kinds_id_fk" FOREIGN KEY ("kind_id") REFERENCES "document_kinds" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_kind_same_org_fk" FOREIGN KEY ("org_id", "kind_id") REFERENCES "document_kinds" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "document_templates_kind_idx" ON "document_templates" ("kind_id");
--> statement-breakpoint
GRANT UPDATE ("kind_id") ON "document_templates" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD COLUMN "body_doc" jsonb;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD COLUMN "margins" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD COLUMN "header_doc" jsonb;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD COLUMN "footer_doc" jsonb;
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_margins_check" CHECK ("margins" IN ('narrow', 'normal', 'wide'));
--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_docs_check" CHECK (
	("body_doc" IS NULL OR jsonb_typeof("body_doc") = 'object') AND ("header_doc" IS NULL OR jsonb_typeof("header_doc") = 'object') AND ("footer_doc" IS NULL OR jsonb_typeof("footer_doc") = 'object')
);
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD COLUMN "body_doc" jsonb;
--> statement-breakpoint
ALTER TABLE "issued_document_versions" ADD CONSTRAINT "issued_document_versions_body_doc_check" CHECK ("body_doc" IS NULL OR jsonb_typeof("body_doc") = 'object');

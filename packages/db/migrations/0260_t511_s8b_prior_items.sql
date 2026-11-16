-- 0260 - T-511 S8b: an Appendix B charge keeps its Official Document Number, and an upload keeps the earlier items its Appendix C lists.
-- docs/tasks/511-settlement-upload-s8-spec.md "S8b" items 2 and 5; hand-authored per ADR-012 s5. Journal idx 260 follows 0257 (main's head at c7c5275).
--
-- WHY. A Foodpanda weekly statement ends with "Appendix C, Outstanding Amount From Previous Periods": the earlier charge documents Foodpanda netted out of THIS payout (each
-- printed with the document's OFFICIAL number). The charge itself arrives on another, earlier invoice. To net the right charges from the right payout the system must be able to
-- say "the charge whose official document number is X" and "the items this payout lists". Both are facts of the FILE, written once when the file is read; nothing is ever
-- updated afterwards (an upload's replacement is a new row).
--
-- WHAT IT ADDS (no new table, so the RLS registry, the trigger registry and the cutover classification are unchanged).
--   settlement_other_lines.official_document  text NULL. The number printed on the charge's Appendix B row; NULL for every line staged before S8b, for Grab and for a row that
--                                             printed none. 1 to 40 characters when present (never ''), the same cap the reader applies. A PARTIAL, non-unique index on
--                                             (org_id, official_document) where it is not null: the netting looks a charge up by it. Not unique: the same charge staged by
--                                             two uploads of one invoice (a re-issue) is legitimate; one booked copy is enforced by the duplicate-copy rule in code.
--   settlement_uploads.prior_items            jsonb NOT NULL default '[]'. The signed items of Appendix C as the reader returned them: [{document, date, amount}]. CHECK it is a
--                                             json array (the reader's cap of 50 lives in the reader). Existing rows read [].
-- GRANTS. shareat_app keeps INSERT and SELECT plus its COLUMN-LEVEL UPDATE on superseded_by / is_current (0228), and gains ONE more column-level UPDATE: settlement_other_lines.official_document.
--   Why: a charge staged before this migration has no document number; uploading the same file again fills it (`settlementIntakeRepo.fillOfficialDocument`, which writes this column only,
--   and only where it is still NULL). prior_items stays insert-only history. No money column, kind or booked state becomes updatable.
--
-- LOCK BUDGET. Both tables are small. ADD COLUMN with a constant default is a catalogue change on PostgreSQL 11 and later (the repo runs 18): no rewrite. The two CHECKs scan a
-- small table once. First statement SET LOCAL lock_timeout = '5s' (resets at commit). Every statement is its own breakpoint.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD COLUMN "official_document" text;
--> statement-breakpoint
ALTER TABLE "settlement_other_lines" ADD CONSTRAINT "settlement_other_lines_official_document_check" CHECK ("official_document" IS NULL OR char_length("official_document") BETWEEN 1 AND 40);
--> statement-breakpoint
CREATE INDEX "settlement_other_lines_org_official_document_idx" ON "settlement_other_lines" ("org_id", "official_document") WHERE "official_document" IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE ("official_document") ON "settlement_other_lines" TO "shareat_app";
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD COLUMN "prior_items" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "settlement_uploads" ADD CONSTRAINT "settlement_uploads_prior_items_array_check" CHECK (jsonb_typeof("prior_items") = 'array');

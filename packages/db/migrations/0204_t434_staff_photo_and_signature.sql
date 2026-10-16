-- 0204 - T-434: staff photo and signature. docs/tasks/434-staff-photo-and-signature.md decision 2; hand-authored per ADR-012 s5.
-- Builds on 0203 (T-433). Idx 202 is reserved for POS v2 and is deliberately absent.
--
-- WHY. A signature is a legal mark of the PERSON (not of a job), so it lives on persons.signature_file_id (nullable, restrict).
-- The photo stays on employments.photo_file_id (0080). Both files are filed through the T-141 broker, which needs two new purposes
-- in stored_files_purpose_check: staff_photo and staff_signature. The same-org twin FK (T-398 S1 convention) needs stored_files (org_id, id) unique. No table is added, so no classification / RLS registry change.
ALTER TABLE "persons" ADD COLUMN "signature_file_id" uuid;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_signature_file_id_stored_files_id_fk" FOREIGN KEY ("signature_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_org_id_id_unique" UNIQUE ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_signature_file_id_same_org_fk" FOREIGN KEY ("org_id", "signature_file_id") REFERENCES "stored_files" ("org_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";
--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("stored_files"."purpose" in ('receipt_photo','ar_collection_proof','memo_document','wastage_dispute','onboarding_document','staff_photo','staff_signature')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "stored_files" VALIDATE CONSTRAINT "stored_files_purpose_check";

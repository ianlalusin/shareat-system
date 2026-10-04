-- 0181 - T-374 S7 (DEF-578), docs/tasks/374-money-push-follow-ups.md section S7, ruling R13.
--
-- A POS usage pull can now be voided as a document (voidPosUsagePull): every usage record it made is reversed
-- and the pull is marked `void` with who, when and why. The three audit columns mirror stock_usage_records
-- (voided_at / voided_by / void_reason), and the shape CHECK mirrors stock_usage_void_shape_check, with one
-- addition: the reason must hold a non-space character. Nothing wrote `status = 'void'` before this, so no row can violate it.
--
-- PRECHECK (run read-only before apply; must return 0 - no writer of 'void' existed):
--   select count(*) from pos_usage_pulls where status = 'void';
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

ALTER TABLE "pos_usage_pulls"
	ADD COLUMN "voided_at" timestamp with time zone,
	ADD COLUMN "voided_by" uuid,
	ADD COLUMN "void_reason" text;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_voided_by_persons_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."persons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pos_usage_pulls" ADD CONSTRAINT "pos_usage_pulls_void_shape_check" CHECK ("status" <> 'void' or ("voided_at" is not null and "voided_by" is not null and "void_reason" is not null and "void_reason" ~ '[^[:space:]]'));

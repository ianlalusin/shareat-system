-- 0268 - T-612 (Ian, 19 Nov 2026; supersedes bible row 340 and T-609's "no separate suspend switch"): every person has an ACCOUNT STATUS.
-- docs/tasks/612-staff-account-status.md. pending (hired, waiting for a manager) / active / suspended (rights kept, paused) / ended (T-609 ended the last job).
-- The column default is 'active', so every row written by older code (and every legacy fixture) keeps working; the hire path
-- (`createPerson`) and re-hire (`createEmployment`) set 'pending' explicitly. `persons.is_active` stays, unread, and is dropped by a later clean-up task.
-- Backfill: is_active true -> active, false -> suspended; a terminal is always active (the CHECK below). Nobody who works today is locked out on deploy.
ALTER TABLE "persons" ADD COLUMN "account_status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
UPDATE "persons" SET "account_status" = CASE WHEN "kind" = 'terminal' OR "is_active" THEN 'active' ELSE 'suspended' END;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_account_status_check" CHECK ("account_status" in ('pending', 'active', 'suspended', 'ended'));
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_terminal_always_active_check" CHECK ("kind" <> 'terminal' OR "account_status" = 'active');

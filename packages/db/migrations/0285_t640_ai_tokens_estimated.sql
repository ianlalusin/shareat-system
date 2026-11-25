-- 0285 - T-640 (security audit): ai_calls.tokens_estimated. docs/tasks/640-ai-hub.md; hand-authored per ADR-012 s5.
-- Journal idx 285, "when" = 0284's + 86400000. 0284 is already applied, so this is a new migration, never an edit of it.
--
-- WHY. A provider reply with missing or zero usage used to be logged at cost 0, so a call that answered looked free and the monthly cap never saw it. The router now estimates the tokens from the text
-- (about 4 characters a token, at least 1) and must say it did: this column is that statement. false for every row that exists (their tokens came from the provider).
-- ADD COLUMN with a constant default: no table rewrite. ai_calls stays append-only (the app role keeps SELECT and INSERT only; this column is written on insert). LOCK BUDGET: lock_timeout 5s first.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD COLUMN "tokens_estimated" boolean DEFAULT false NOT NULL;

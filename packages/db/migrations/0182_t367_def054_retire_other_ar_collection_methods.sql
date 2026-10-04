-- T-367 S5 (DEF-054): retire `other` and `ar_collection` as expense payment methods (Ian, 2026-10-04, A1).
-- NOT VALID: legacy rows may still hold either value and are NOT rewritten; only new/updated rows are checked.
ALTER TABLE expense_payments DROP CONSTRAINT expense_payments_method_check;--> statement-breakpoint
ALTER TABLE expense_payments ADD CONSTRAINT expense_payments_method_check CHECK (method in ('cash','online','credit','reimbursable')) NOT VALID;

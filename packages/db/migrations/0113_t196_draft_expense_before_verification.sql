-- T-196 — a draft expense may sit against a PENDING supplier invoice; verification posts it.
-- docs/tasks/196-draft-expense-on-a-pending-invoice.md.
--
-- ⭐ THE CHANGE, IN ONE SENTENCE. The gate moves from "an expense may not EXIST until its
-- invoice is verified" to "an expense may not POST until its invoice is verified." T-130's
-- `expenses_check_invoice_open_for_recording()` (migration 0043) checked `inv_status <> 'verified'`
-- unconditionally, on every INSERT and UPDATE alike — so a draft could never even be written. This
-- migration REPLACES the function body only; the trigger itself (`expenses_require_verified_invoice`,
-- BEFORE INSERT OR UPDATE) is untouched, because `CREATE OR REPLACE FUNCTION` on an identical
-- signature (no args, returns trigger) is picked up by the existing trigger without re-creating it.
--
-- Ian, 2026-08-31: *"we will improve that unverified receipt can then be posted against draft
-- expense so cashier does not need verification to start recording. when receipt is verified the
-- expense are posted. when receipt is rejected voided the draft expense is deleted or the posted
-- expense is also voided."*
--
-- ⭐ THE CAPACITY ARITHMETIC NEEDS NO CHANGE, AND THAT IS THE POINT. It already sums
-- `status <> 'voided'`, which includes drafts, so a pending invoice cannot be over-committed by
-- drafts any more than a verified one can be over-recorded by postings — "one receipt, many
-- expenses" (DEF-057) survives this change for free.
--
-- ⚠️ The early `RETURN NEW` on `NEW.status = 'voided'` is load-bearing, same as before: a void is
-- never blocked by its parent invoice's status, because `voidInvoice` (packages/domain/src/ap)
-- must always be able to flip a linked expense to voided regardless of what happened to the
-- invoice meanwhile (T-196 §5 — `voidInvoice` now branches: a DRAFT is deleted via
-- `deleteExpenseDraft`, never voided; a POSTED expense is voided via `voidExpense`, which is the
-- path this early return protects).
--
-- ⛔ NOT relaxed further than this. A `voided` invoice still refuses EVERYTHING — draft or
-- posted — because voiding is permanent (v1: "re-enter a new receipt instead") and nothing may be
-- recorded against a bill that no longer stands. Only the POSTED gate moves; existence (draft) and
-- the void wall do not.
CREATE OR REPLACE FUNCTION "expenses_check_invoice_open_for_recording"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	inv_status text;
	inv_total numeric;
	recorded numeric;
BEGIN
	-- A void is never blocked by its parent invoice — see the comment above.
	IF NEW.status = 'voided' THEN
		RETURN NEW;
	END IF;

	SELECT status, total_amount INTO inv_status, inv_total
	FROM supplier_invoices WHERE id = NEW.supplier_invoice_id;

	IF inv_status IS NULL THEN
		RAISE EXCEPTION 'supplier invoice % does not exist', NEW.supplier_invoice_id;
	END IF;

	IF inv_status = 'voided' THEN
		RAISE EXCEPTION 'supplier invoice % is voided — nothing further may be recorded against it', NEW.supplier_invoice_id;
	END IF;

	-- ⭐ T-196 — the gate moved from EXISTENCE to POSTING. A draft (NEW.status = 'draft', the
	-- INSERT createExpense performs) may stand against a 'pending' invoice; only a row reaching
	-- 'posted' (the UPDATE approveExpense performs) still requires the invoice to be 'verified'.
	IF NEW.status = 'posted' AND inv_status <> 'verified' THEN
		RAISE EXCEPTION 'supplier invoice % is % — a draft may stand against it, but it cannot post until it is verified', NEW.supplier_invoice_id, inv_status;
	END IF;

	-- capacity check: UNCHANGED from migration 0043.
	SELECT coalesce(sum(total_amount), 0) INTO recorded
	FROM expenses
	WHERE supplier_invoice_id = NEW.supplier_invoice_id AND status <> 'voided' AND id <> NEW.id;

	IF recorded + NEW.total_amount > inv_total + 0.005 THEN
		RAISE EXCEPTION 'supplier invoice % has only % remaining (total %, already recorded %) — this expense (%) does not fit',
			NEW.supplier_invoice_id, (inv_total - recorded), inv_total, recorded, NEW.total_amount;
	END IF;

	RETURN NEW;
END;
$$;

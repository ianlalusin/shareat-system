-- T-367 S2 — the supplier-invoice gate, two fixes to one function. docs/tasks/367-ap-ar-money.md
-- §S2, R4, R7. `CREATE OR REPLACE FUNCTION` on the same signature (no args, returns trigger) is
-- picked up by the existing `expenses_require_verified_invoice` trigger without re-creating it —
-- same discipline as 0113.
--
-- ⭐ R4 (DEF-396) — `FOR NO KEY UPDATE`. The invoice read below is now a LOCKING read, so every
-- writer — this trigger, `lockInvoiceForRecording` (createExpense/approveExpense/editExpense), and
-- `lockInvoiceForUpdate` (voidInvoice, `FOR UPDATE`) — serialises on the same row regardless of
-- which code path reaches it, including a raw `UPDATE expenses` or a future ETL insert that never
-- goes through the domain layer at all. `FOR NO KEY UPDATE` does not conflict with the
-- `FOR KEY SHARE` every expense row's own FK insert takes against `supplier_invoices`, so an
-- unrelated recording on a DIFFERENT invoice is never blocked by this lock.
-- ⚠️ Stays `origin`/`validator`, never `always` (same reasoning as 0174's DEF-436 trigger): under
-- `session_replication_role=replica` (the cutover ETL) this trigger does not fire at all, so it
-- neither locks the invoice nor checks the store match on that path — a historical load is not
-- otherwise protected here.
--
-- ⭐ R7 (DEF-508) — the store check. `NEW.store_id <> inv_store` raises for ANY non-voided row,
-- the same "expense and its invoice must agree on where they happened" rule `createExpense`'s own
-- domain-layer check enforces (`packages/domain/src/expenses/create.ts`) — this is the backstop
-- when that layer is bypassed. Placed right after the not-found check and before the voided/status
-- checks below, so a store mismatch is reported as its own fact rather than masked by some other
-- raise firing first on the same row.
--
-- ⛔ Prechecks run (read-only, local lane DB and shareat_dev) before this migration, mirroring
-- T-367 S1's P2-style census:
--   P2: select count(*) from expenses e join supplier_invoices si on si.id = e.supplier_invoice_id
--       where e.store_id <> si.store_id and e.status <> 'voided';           -- expect 0
--   P3: select count(*) from expenses e join supplier_invoices si on si.id = e.supplier_invoice_id
--       where si.status = 'voided' and e.status <> 'voided';                -- expect 0 (DEF-396)
--   P4: select count(*) from ap_payment_allocations apa
--       join ap_payments ap on ap.id = apa.ap_payment_id
--       join expenses e on e.id = apa.expense_id
--       where ap.status = 'posted' and e.status = 'voided';                 -- expect 0
-- A non-zero P2/P3 result would mean this migration's new RAISE fires against EXISTING rows on
-- its very next UPDATE (e.g. a later void) — it would not fire at migration time itself, since this
-- function only runs on INSERT OR UPDATE of `expenses`, never as a one-time backfill scan.
CREATE OR REPLACE FUNCTION "expenses_check_invoice_open_for_recording"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	inv_status text;
	inv_total numeric;
	inv_store uuid;
	recorded numeric;
BEGIN
	-- A void is never blocked by its parent invoice — see 0113's comment.
	IF NEW.status = 'voided' THEN
		RETURN NEW;
	END IF;

	-- ⭐ R4 (DEF-396) — FOR NO KEY UPDATE: this read now takes a lock, not just a snapshot.
	SELECT status, total_amount, store_id INTO inv_status, inv_total, inv_store
	FROM supplier_invoices WHERE id = NEW.supplier_invoice_id
	FOR NO KEY UPDATE;

	IF inv_status IS NULL THEN
		RAISE EXCEPTION 'supplier invoice % does not exist', NEW.supplier_invoice_id;
	END IF;

	-- ⭐ R7 (DEF-508) — an expense and its invoice must be at the same store.
	IF NEW.store_id <> inv_store THEN
		RAISE EXCEPTION 'expense % is at a different store from supplier invoice %', NEW.id, NEW.supplier_invoice_id;
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

	-- capacity check: UNCHANGED from migration 0043/0113.
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

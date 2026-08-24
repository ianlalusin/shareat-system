-- 0012 — 2120 Goods received not invoiced (ADR-009 amendment, bible row 117).
--
-- A delivery will post a PROVISIONAL valued inventory layer on receipt and credit this account;
-- when its expense document links, the provisional cost is corrected and this clears into
-- 2110 Accounts payable.
--
-- Why it exists: today nothing posts until the manual delivery→expense link happens, and that
-- IS the expensing lag ADR-009 measured (91% → 76%, worst in the most recent month). Since
-- stock turns over in 1–2 weeks, the most recent deliveries ARE the stock on hand — so the cost
-- basis was weakest for exactly the stock the 31 December count has to value.
--
-- Ian asked for 2140; 2140 is already 'Customer store credits payable'. 2120 was free and is
-- the better home anyway: GRNI is an accrued liability and belongs immediately after 2110 in
-- the flow goods received → GRNI → AP.
--
-- Deliberately NOT requires_party. The supplier is known on the delivery, but until the invoice
-- arrives the amount owed to that supplier is not established, and forcing a party here would
-- assert a subledger balance the business has not yet agreed. It clears into 2110, which does
-- carry the party.
--
-- 0000-0011 are applied and are therefore never edited (bible §2 rule 8).
INSERT INTO "accounts" ("org_id", "code", "name", "type", "normal_balance", "parent_id", "is_postable", "is_system", "status")
SELECT o."id", '2120', 'Goods received not invoiced', 'liability', 'credit', p."id", true, true, 'active'
FROM "organizations" o
JOIN "accounts" p ON p."org_id" = o."id" AND p."code" = '2000'
WHERE NOT EXISTS (
	SELECT 1 FROM "accounts" a WHERE a."org_id" = o."id" AND a."code" = '2120'
);

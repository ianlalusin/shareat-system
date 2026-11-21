# T-623: the manager checks wallet payments marked "to check"

**Owner:** builder (Sonnet), laptop (`_test` database). Auditor: Sonnet (money path). **Spec:** BOSS (Opus), 21 Nov 2026.
**Ian, 21 Nov 2026:** "the manager checks it." **No migration** (columns and guard exist since 0238). **No new capability.**

## Why

At payment the cashier can mark a GCash/Maya payment "to check" (a reference number is required for that,
`pos_sales_receipt_payments_to_check_reference_check`). The columns `checked_by` / `checked_at` exist
(`packages/db/schema/pos-v2.ts:590-608`) and trigger `pos_sales_receipt_payments_frozen` already lets them go
NULL → a value once (`packages/db/src/triggers/registry.ts` ~1569), but **no code ever writes them**, so a "to check"
payment can never be cleared. Lipa does about 3.7 wallet/cash conversions a day.

## Rule

- **Who:** a person holding `approve_pos_correction` at the store (managers and admins; the same right that approves POS
  corrections). Anyone else is refused.
- **When:** any time; there is no deadline and the Z reading is never blocked by it.
- **What "checked" means:** the manager saw the money arrive in the store's wallet account under that reference number.
  If it did not arrive, the manager does not check it; they use the existing Correct payment flow
  (`apps/erp/src/app/pos/receipts/CorrectPayment.tsx`) to move it to the right tender. A checked payment cannot be
  unchecked (the trigger refuses it); say so in the confirm.

## What to build

1. **Repo** `packages/db/src/repo/pos-v2.ts`: `markPaymentChecked(tx, { orgId, storeId, paymentId, checkedBy, at })`,
   updating only a row of that org/store with `to_check = true and checked_at is null`; returns whether it wrote.
   `listPaymentsToCheck(tx, orgId, storeId)`: unchecked to-check payments with receipt no., time, tender name, amount,
   reference no., newest first.
2. **Domain** `packages/domain/src/pos/` (beside the correction code): `checkWalletPayment(tx, actor, { storeId,
   paymentId })`: `authorize(tx, actor, 'approve_pos_correction', { storeId })` FIRST; refuses a payment that is not
   "to check" or already checked, in plain words ("This payment was already checked by Ana at 2:14 pm."); audit row
   `pos.payment_checked` (entity = payment id; after: receipt no., amount, reference no.). Catalogue entry + honest ceiling
   pins (t402-s1b, t453). Already-checked by a race → the plain refusal, nothing written.
3. **Screen** `/pos/receipts` (`apps/erp/src/app/pos/receipts/page.tsx`): for a person who holds the right, a
   "Wallet payments to check (3)" section above today's receipts, each row: time, receipt no., tender, ₱ amount, reference,
   and a **Checked** button with a light confirm ("Mark ₱450.00 GCash ref 1234 as checked? You saw it arrive. This
   cannot be undone."). Hidden for people without the right. Show the last 7 days of unchecked ones, not only today's.
   Online only (it is a server action); offline the section says "Needs the internet."
4. **Z reading**: `toCheckCount` (`packages/domain/src/pos/day-close.ts:242`, query `pos-v2.ts` ~1174) counts only the
   still-unchecked ones (`p.to_check and p.checked_at is null`), label "Wallet payments still to check". The Z is frozen
   once written, so it records the count at close time.

## Tests (each with a mutant that goes red)

1. Integration: manager checks a to-check payment → columns set, audit row; second check → plain refusal, nothing
   written; cashier refused (mutant: drop `authorize` → red); a payment not marked to-check refused; another store's
   payment id refused (mutant: drop the store filter → red).
2. Integration: Z `toCheckCount` drops by one after a check (mutant: old count query → red).
3. Unit: the section renders for a manager with the button and is absent for a cashier.

- `npm run census:write`; `domain-actions-have-callers` (the new domain fn has an app caller).
- Browser check (forged session, `docs/SMOKETEST.md` §3) only if `/pos/receipts` opens without a paired tablet; else say so.

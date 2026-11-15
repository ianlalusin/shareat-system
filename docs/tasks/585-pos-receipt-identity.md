# T-585 — POS v2 receipts and slips print the ERP identity

> **Status:** spec written 15 Nov 2026 by the POS session (Opus) from BOSS's assignment; Ian ruled "a" (15 Nov).
> **Deadline:** merged before Fri 20 Nov (the Lipa soak is Sat 21 Nov). **Migration:** none expected — if one seems
> needed, stop and ask BOSS. Separate small PR (branch `lane/t585-receipt-identity`).

## Why
Every POS v2 receipt and X/Z slip prints only the store name: `PaymentPanel.tsx:342` and `_till/slips.ts:50` build
`header: { businessName: storeName, addressLines: [], tin: null, ... }`. A receipt must carry who issued it.

## R1 — The header data (read once, from Postgres)
- **Business name:** `organizations.legal_name`, falling back to the trading name (`organizations.name`) when null/blank.
- **TIN line:** the org's TIN plus the store's `stores.tin_branch_code` as the branch suffix, e.g. `123-456-789-00002`.
  Format the org TIN as the house already does (look for an existing TIN formatter in `packages/core` / ERP documents —
  reuse it, do not write a second one). Branch code is `^[0-9]{3,5}$` (`stores_tin_branch_code_format_check`); pad to
  5 digits only if the existing formatter/documents do. Org TIN missing → **no TIN line at all**. Branch code missing →
  print the org TIN alone.
- **Address lines:** `stores.address` (split on line breaks; trim; drop empty lines).
- **Contact:** `stores.contact_number` → one line, e.g. `Tel 0917 123 4567` only if the existing ERP documents use a
  label; otherwise the number alone.
- **Missing values print nothing, never a placeholder** ("—", "N/A", "TIN: " etc. are all refused).
- One repo read in `packages/db/src/repo/` (SQL only there), called from the till page load
  (`apps/erp/src/app/pos/till/page.tsx`, beside `posV2Repo.getOrgTaxType`) in the same transaction — once per page
  load, not per sale.

## R2 — Use it everywhere a header is built
- Receipt (`PaymentPanel.tsx`), X/Z reading slips (`_till/slips.ts`), and any other place that builds a
  `header` with `addressLines: []` / `tin: null` (grep `addressLines` under `apps/erp/src`). Pass a single `ReceiptHeader`
  object down (the existing type in `apps/erp/src/lib/pos-print/types.ts`); no new type if that one fits.
- `receipt-text.ts` / `reading-text.ts` already render `addressLines` and `tin`; check they skip empty values and print no
  label for a null TIN. Fix there only if they don't.

## R3 — Offline
The till works offline from the cached snapshot (T-530a device store). The header must come from that snapshot when
offline: add the header fields to the snapshot the till caches (follow how store name / tax type already get there).
An old snapshot without the fields must still print (store name only), never crash.

## Tests (tester writes them red first)
1. The header builder carries legal name, TIN with branch, each address line, contact number.
2. Legal name null → trading name.
3. Org TIN null → no TIN line in the rendered receipt text (and no "TIN" label); branch code null → org TIN alone.
4. Blank address / contact → no empty line.
5. Snapshot round-trip keeps the header; an old snapshot without it renders store name only.
6. A mutant: hard-code `tin: null` (or drop the branch suffix) in the builder → a test above fails. Record it.
7. Integration (CI-only is fine): the repo read returns the right org/store values and never another org's.

## Gates
`npm run typecheck`, the pos-print and till unit tests, guards the change trips (re-measure pins with repo tools).
Sonnet auditor (money document / BIR-facing text).

## Mutant record (15 Nov 2026)

- Hard-code `tin: null` in `receiptIdentityOf`: 3 tests failed.
- Drop the branch suffix in `receiptIdentityOf`: 2 tests failed.
- Remove the `identity` prop from `Orders.tsx` (the Payment panel call): the new Orders test (`t528d-orders-receipt-dom.test.ts`, "the store identity from the snapshot reaches the receipt header") failed.

All three were restored; the files match their pre-mutant state.

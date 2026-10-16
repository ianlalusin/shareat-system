# T-408: VAT type, VAT amount and the OR flag on the supplier-invoice form, plus a monthly VAT × OR list

**Status:** **DONE 2026-10-16, merged a879264 (PR #28).** Questions answered BY DEFAULT ONLY (recommended options built; Ian has not answered on the decisions page yet). | Earlier: SPEC DRAFT 2026-10-15 (Opus planner). Not built. **No migration** (every column exists since T-188).
≈1.25 lane-days, two slices. **Sonnet lane** (money: AP figures). Two questions for Ian below; the recommended option is built.

## Goal

A manager logging a supplier's bill records what the paper says: was it an official receipt (OR), what VAT type, and
the VAT amount printed on it. Each defaults from the supplier's master record. Once a month the manager pulls one list,
"invoices by VAT type × OR", per store, and matches it against the physical receipt file.

## Source

- Worklist `docs/plans/2026-10-14-ian-answers-worklist.md` #1; review `docs/feedback/2026-10-14-ian-feedback-review.md`
  item 10 ("the invoice form cannot capture VAT or OR, and there is no input-VAT list").
- Bible §13 row 75: a management ledger, **VAT is a label, not a tax engine**; nothing posts to an input-VAT account.
- Code read 2026-10-15: `apps/erp/src/app/ap/actions.ts:156` `recordInvoiceAction` (passes none of the four VAT
  fields, nor `isOfficialReceipt`); `apps/erp/src/app/ap/page.tsx:126` (the form); `packages/domain/src/ap/index.ts:426`
  `RecordInvoiceInput`, `:465` `recordInvoice` (parses the VAT figures at ~513, checks nothing about them, copies
  `isOfficialReceipt` from the supplier when omitted at ~588); `packages/db/schema/suppliers.ts` (`suppliers.vat_status`
  `vat_registered | non_vat | null`, `issues_official_receipt`; `supplier_invoices.vat_type` CHECK, `vat_rate`,
  `vat_amount`, `vat_exclusive_amount`, `is_official_receipt`); `packages/domain/src/recurring-expenses/job.ts:167`
  (the only other `recordInvoice` caller, sends no VAT). No test today sends any VAT field (grep).

## Research (row 283: v1's goal, not its method)

**v1's method** (`ERP-rebuild/src/lib/actions/receipt.actions.ts:283-325`): refuses any VAT field when the supplier is
not VAT-registered; for `vatable` it **recomputes** VAT at 12% inclusive from the total, overwriting what was sent.
**v1's goal.** VAT data that cannot disagree with the supplier or with itself.
**Where v1 misses it.** The recompute assumes the whole bill is vatable at 12%. A bill with exempt lines carries less
VAT than 12/112 of its total, and v1 stores a figure that is not on the paper, so the monthly match fails on exactly
those bills. **Count:** v1's live share of mixed bills is not measured; the lane does not need it (see R3).
**v2 design that beats it.** Keep v1's consistency refusals; record the printed VAT amount instead of inventing one;
derive the VAT-exclusive figure (never typed, like an invoice line total). Row 75 holds: a label, nothing posts.

## Rulings (planner; binding unless Ian answers otherwise)

- **R1. "Supplier's usual" is a real choice, resolved on the server.** `RecordInvoiceInput.vatType` widens to
  `SupplierInvoiceVatType | 'supplier_default' | null`. `'supplier_default'` resolves from the supplier row
  `recordInvoice` already loads: `vat_registered` → `vatable`, `non_vat` → `non_vat`, null → null. **Omitted or null
  stays null** ("not recorded"), so the recurring job is unchanged. The form's OR select sends `''` (omit, which already
  copies the supplier's habit), `yes` or `no`.
- **R2. Consistency refusals (v1's goal), each a plain sentence, all before the first write:**
  supplier `non_vat` with type `vatable` or `zero_rated`, or with any VAT amount → refused; `vatable` → amount required,
  `> 0` and `<=` the total; `zero_rated` → amount blank or 0, stored `0.00`; `exempt` / `non_vat` / null → amount must
  be blank, stored null. A supplier with `vat_status` null accepts any type (master data not filled yet).
- **R3. The amount is typed from the paper; nothing is computed at 12%.** (Q1.) `vat_exclusive_amount` is derived:
  `vatable` → total − VAT; `zero_rated` → total; otherwise null. `vat_rate` is never written (stays null).
  A caller-sent `vatRate` or `vatExclusiveAmount` that disagrees with the derived value is refused (refused, not
  skipped); the form never sends them. All arithmetic through `@shareat/core` money (`subtract`, `compare`); no float.
- **R4. The list** is `/ap/vat?store=&month=YYYY-MM`. Gate: `verify_supplier_invoice` at the chosen store (the
  manager who checks bills against paper is the verifier). Voided invoices excluded; month by `invoice_date`.
  Shows a summary grid (rows: VAT type incl. "not recorded"; columns: OR / not OR; each cell count, total, VAT) and the
  invoice list under it (date, supplier name, invoice no, total, VAT, type, OR, link to `/ap/invoices/[id]`).
  Sums are SQL `numeric` returned as strings and rendered with the existing `peso()` helper.
- **R5. The invoice detail page** shows VAT type, VAT amount and OR in its header (read-only), so what was stored
  is visible right after saving.

## Contract

| Function / file | Change |
|---|---|
| `RecordInvoiceInput.vatType`, `recordInvoice` | `packages/domain/src/ap/index.ts`: R1 resolution, R2 refusals, R3 derivation |
| `recordInvoiceAction` | `apps/erp/src/app/ap/actions.ts`: reads `vatType`, `vatAmount`, `isOfficialReceipt` (`yes`/`no`/blank) |
| invoice form | `apps/erp/src/app/ap/page.tsx`: two selects ("Official receipt?", "VAT type", both defaulting to "Supplier's usual") and a "VAT amount (as printed)" input |
| `apRepo.invoicesByVatAndOr(tx, orgId, storeId, month)` | `packages/db/src/repo/ap.ts`: new, one grouped query + one list query, explicit `org_id` and `store_id` filters |
| `/ap/vat` | new `apps/erp/src/app/ap/vat/page.tsx`; a link to it from `/ap` |
| invoice header | `apps/erp/src/app/ap/invoices/[id]/page.tsx` (R5, read-only) |

## Invariants (each with a named mutant)

1. `'supplier_default'` on a `vat_registered` supplier stores `vatable` (with the typed amount); on `non_vat` stores
   `non_vat`; on null stores null. *Mutant: default mapping inverted / ignored.*
2. Omitted `vatType` stores null even for a `vat_registered` supplier (recurring job path). *Mutant: omit treated as default.*
3. `non_vat` supplier + `vatable` → refused, no invoice row, no audit row. *Mutant: R2 check removed.*
4. `vatable` with blank amount, amount `0`, amount `>` total → each refused. *Mutant: each bound dropped in turn.*
5. `vatable` 1,120.00 with VAT 100.00 stores `vat_exclusive_amount = 1020.00`, `vat_rate` null. *Mutants: 12/112
   recompute (stores 120.00); exclusive typed instead of derived.*
6. `zero_rated` stores VAT `0.00`, exclusive = total; `exempt` with an amount → refused. *Mutant: amounts passed through.*
7. Caller `vatExclusiveAmount` that disagrees → refused. *Mutant: silently overwritten.*
8. OR `no` on a supplier whose habit is OR stores `false`; blank copies the habit. *Mutant: action ignores the field.*
9. `/ap/vat` for March: a voided invoice and an April invoice are absent; cell sums equal the hand-computed fixture
   (exact strings). *Mutants: void not filtered; month on `created_at`.*
10. A staff actor, and a manager not scoped to the store, are refused the list. *Mutant: authorize removed.*
11. Another store's and another org's invoices never appear. *Mutant: `store_id` filter dropped.*

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Domain R1-R3 + form + action + detail header | `packages/domain/tests/integration/t408-s1-invoice-vat.test.ts` (1-7); `apps/erp/tests/integration/t408-s1-invoice-vat-web.test.ts` (8, and the form round trip) | `packages/domain/src/ap/index.ts` (`RecordInvoiceInput`, `recordInvoice` only), `apps/erp/src/app/ap/actions.ts` (`recordInvoiceAction` only), `apps/erp/src/app/ap/page.tsx`, `apps/erp/src/app/ap/invoices/[id]/page.tsx` | 0.75 |
| **S2** | Repo query + `/ap/vat` page | `apps/erp/tests/integration/t408-s2-vat-list.test.ts` (9-11) | `packages/db/src/repo/ap.ts` (new function), `apps/erp/src/app/ap/vat/page.tsx` (new), `apps/erp/src/app/ap/page.tsx` (one link) | 0.5 |

Tests first and red; builder greps its diff for the named mutants before hand-back.

## Out of scope

- Posting input VAT to its own account (a new posting pattern; row 75 says none; separate decision).
- Recomputing VAT on old invoices or back-filling `vat_type` (they stay null, shown as "not recorded").
- A client-side live default (showing the supplier's VAT status as the supplier is picked): needs a client component;
  "Supplier's usual" plus R5 covers it.
- Editing VAT on an existing invoice (no invoice edit exists today).

## Done when

S1-S2 merged; invariants 1-11 green with each mutant shown red once; typecheck, lint, unit and the AP + recurring
integration tests green (`t379-s3b-ap-fees-web`, `t389-s1-invoice-lines-web`, the recurring-expense job tests unchanged).

## Risks

- **R2 refuses a bill a manager could log yesterday** only when they choose a VAT type; blank type is unchanged.
- **Supplier master quality:** many suppliers may have `vat_status` null, so "Supplier's usual" stores null. The list
  shows them as "not recorded", which is the honest answer and tells the manager whom to fix.

## Questions for Ian (the recommended option is built)

- **Q1. VAT amount: type it from the paper, or let the system work it out as 12/112 of the total?**
  (a) Type what is printed; the system only checks it is not more than the total. (b) Auto-compute 12/112 like v1;
  wrong for any bill with VAT-exempt items. **Recommended (a)**: the list is for matching paper, so it must hold the
  paper's number.
- **Q2. Who sees the monthly VAT × OR list?** (a) Managers and admins at their own stores (the people who verify
  bills). (b) Admins only. **Recommended (a)**: the manager holds the physical receipt file.

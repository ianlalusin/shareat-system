# T-188 — Supplier master data

> **Status:** specced 2026-08-30 · chosen by Ian from the v1→v2 parity section (suppliers, 67%)
> **Reference read at source:** `ERP-rebuild/src/types/index.ts` `SupplierPlain`,
> `src/app/financial/suppliers/supplier-editor.tsx`, `src/lib/actions/supplier.actions.ts`
> **Live v1 data probed 2026-08-30** — 129 supplier documents across 7 stores, read-only, fill rates only

---

## 1. ⭐ Verdict — build it, but a **different and smaller** thing than the parity figure implies

**The 67% parity score is real and almost entirely misleading**, and the live data is what says so.
That figure counts *fields*. Fields are not equally real.

⛔ **The reason I gave for prioritising this does NOT hold.** I wrote *"you cannot pay a supplier
from v2's record — the bank details are not in it."* True, and irrelevant:

```
bankAccounts filled:  5 of 129 suppliers   (3.9%)
```

**v1 cannot pay 96% of its suppliers from the record either.** Porting `bankAccounts` faithfully
would move a field nobody fills. Saying so is the most useful output of this pass.

**What the probe found instead — three things worth building, none of which were on the parity list:**

1. ⛔ **A supplier can be CREATED but never EDITED.** `apRepo.updateSupplier` exists, is fully
   written, and **has no caller** — no domain service, no screen. A typo in a supplier name is
   permanent today. *This is the whole task.*
2. ⛔ **`/ap/suppliers` and `/ap/invoices` are nav links to routes that do not exist** — only
   `[id]` detail pages were ever built. Two entries in the main nav are 404s.
3. ⭐ **`issuesOfficialReceipt` is the one missing field that actually does work** — 66% filled,
   and in v1 it *defaults the receipt type* when a supplier is chosen. v2 has no equivalent, on
   the supplier or on the invoice.

---

## 2. The evidence — every v1 supplier field, measured not guessed

Read-only probe of the live v1 project, 129 documents across all 7 stores. **Fill rates only; no
field's value was read out, because these are bank accounts and TINs.**

| v1 field | filled | drives anything in v1? | verdict |
|---|---:|---|---|
| `businessName` | **100%** | the identity | ✅ v2 has it (`name`) |
| `classification` | **96.1%** | ⛔ **nothing** — written by the form, never read | ✅ **port as a plain field** (see §4.2) |
| `isActive` | 97.7% | yes | ✅ v2 has it (`status`) |
| `issuesOfficialReceipt` | **65.9%** | ⭐ **YES** — defaults `isOfficialReceipt` on a receipt | ⭐ **BUILD, both halves** |
| `vatStatus` | 61.2% | yes | ✅ v2 has it |
| `outstandingBalance` | 52.7% | yes | ⛔ **deliberately not stored** — v2 derives it from the AP ledger, and v1's copy drifts |
| `representativeName` | 11.6% | no | ✅ build — one column |
| `businessAddress` | 10.1% | no | ✅ v2 has it (`address`) |
| `contactNo1` | 8.5% | no | ✅ v2 has it (`contactNo`) |
| `email` | 7.8% | no | ✅ build — one column |
| `logoPath` | 4.7% | no | ⛔ **skip** |
| `linkedStoreId` | 4.7% | yes | ✅ v2 has it (`counterpartyStoreId`) |
| `bankAccounts` | **3.9%** | no | ⚠️ build as **plain columns, not a table** — §4.3 |
| `linkedArCustomerId` | 3.9% | yes (commissary mirror) | ⏸ v2 models this through `commissary_links`; out of scope |
| `notes` | 3.9% | no | ✅ v2 has it |
| `lastCreditDueDays` | 3.1% | ⛔ set to `null` by the only writer | ⛔ **skip** |
| `vatRegistrationNo` | 2.3% | no | ✅ build — BIR needs it even though nobody has filled it |
| `contactNo2` | 1.6% | no | ⛔ **skip** — a second phone on 2 of 129 |
| `paymentOptions` | **1.6%** | no | ⛔ **skip — a dead field.** Both rows hold the single value `"Cash"` |

⭐ **Weighted by use rather than counted, v2's supplier record is far closer to complete than 67%
suggests.** Exactly **one** genuinely load-bearing field is missing, and it is `issuesOfficialReceipt`.

### 2.1 ⭐ And v2 already fixes v1's largest supplier problem

```
supplier DOCUMENTS across 7 stores : 129
DISTINCT business names            :  88
                                     ---
duplicate rows                     :  41   (32%)
worst case: ONE vendor filed 20 separate times, once per store
```

v1 keys suppliers at `stores/{storeId}/suppliers`, so a fleet-wide vendor becomes seven-plus
records that must each be edited, reconciled and paid separately. **v2's `suppliers` is
org-scoped and carries no `store_id`** — the duplication is unrepresentable. Nothing to build;
worth stating, because it is the strongest thing about the v2 model and no field count shows it.

---

## 3. What the industry does, and open source

Supplier master is the most standardised record in any ERP. Odoo's `res.partner`
(`vat`, `company_type` individual/company, `bank_ids` as a child table) and ERPNext's *Supplier*
doctype (`tax_id`, `supplier_type` Individual/Company, `is_transporter`, bank details on a linked
*Bank Account*) are the two reference implementations. **Both confirm the shape**, including the
individual-vs-company split that v1 calls `classification`.

⛔ **Nothing worth adopting.** Both are AGPL-3.0 and inseparable from their host ORM. The useful
signal is negative: both put bank accounts in a **child table** because their users bank with
several institutions. ⚠️ **Ours do not** — 5 suppliers, exactly **one** account each. Copying the
child table would be importing a solution to a problem this business does not have (§4.3).

---

## 4. The structure

### 4.1 Columns added to `suppliers`

| Column | Type | Why |
|---|---|---|
| `email` | text | 7.8% today; master data people fill as they use it. One column |
| `representative_name` | text | 11.6%. Who you actually ring |
| `tin` | text | v1's `vatRegistrationNo`. ⚠️ **Renamed on purpose** — in the Philippines this IS the TIN, and `vatRegistrationNo` beside the existing `vat_status` reads like a second status field |
| `classification` | text enum | `corporate` \| `individual` \| `other`, nullable. §4.2 |
| `issues_official_receipt` | boolean NOT NULL DEFAULT true | ⭐ the load-bearing one. §4.4 |
| `bank_name`, `bank_account_name`, `bank_account_number` | text | §4.3 |

### 4.2 ⚠️ `classification` is ported as a LABEL, and the doc must say so

96% filled, and in v1 it drives **nothing**: `supplier-editor.tsx` writes it, `supplier.actions.ts`
saves it, and no code reads it for a decision. Every `classification` hit that *does* drive
behaviour in v1 belongs to `ARCustomerClassification` — a different entity with the same word.

⭐ **Ported anyway**, because people evidently fill it and a label they maintain is worth keeping.
⛔ **But nothing may branch on it** until somebody decides what it means. The natural future use is
the BIR expanded-withholding split (individual and corporate attract different EWT rates) — **that
is NOT built here and no code should assume it.**

### 4.3 ⚠️ Bank details are three COLUMNS, not a child table

The probe is unambiguous: **5 suppliers, every one with exactly 1 account.** And v1's own objects
are inconsistent — `bankName` present on 2 of 5, `accountCategory` / `providerName` /
`accountLabel` on 3 of 5. That is a half-designed structure nobody finished.

⛔ **A `supplier_bank_accounts` table for five single-row cases is inventing a dimension the
business has not got.** Three nullable columns carry every real row today. `bank_name` is
deliberately free text so an e-wallet (`GCash`, `Maya`) fits without a second concept — which is
what v1's unused `providerName` was groping towards.

⭐ **If a supplier ever genuinely needs two accounts, that is the moment to add the table** — and
the migration is trivial from here. Building it now buys nothing and costs a join on every read.

### 4.4 ⭐ `issues_official_receipt` needs BOTH halves, or it is a decoration

v1: `receipt-editor.tsx:188` — `form.setValue('isOfficialReceipt', selectedSupplier.issuesOfficialReceipt ?? true)`.
The flag's only purpose is to **default the document type on the invoice**. v2's
`supplier_invoices` has `vat_type` but no official-receipt concept at all.

So this task adds **two** things:

```
suppliers.issues_official_receipt   the DEFAULT   "this supplier normally issues an OR"
supplier_invoices.is_official_receipt  the FACT   "this document was an OR"
```

⛔ **Adding only the first would repeat the exact mistake §4.2 criticises** — a field that is
written, displayed and never read. The default is copied at invoice creation and then owned by the
invoice, because what a supplier *usually* does and what *this receipt* was are different facts,
and the second is the one a BIR audit asks about.

---

## 5. The services

| Service | Note |
|---|---|
| `editSupplier(tx, actor, input)` | ⭐ **`apRepo.updateSupplier` already exists and has no caller.** The cheapest possible win — the write path was built and never wired |
| `createSupplier` | Widened to accept the new fields |

Both gated on **`approve_supplier`**, the capability `createSupplier` already uses. ⛔ **No new
capability.** Editing a supplier is the same authority as admitting one — a name and a bank account
are the parts that decide where money goes, so a weaker gate on edit would make the stronger gate
on create pointless.

---

## 6. The screens

| Route | State today | This task |
|---|---|---|
| `/ap` | list + create forms, works | unchanged |
| `/ap/suppliers` | ⛔ **404** — nav links to it, page never existed | **built**: the supplier register, searchable |
| `/ap/suppliers/[id]` | detail: payables and payments only | **+ an edit form** |
| `/ap/invoices` | ⛔ **404** — nav links to it | nav pointed at `/ap` (DEF-107) |

⚠️ **The account number is masked in the list** (`••••1234`) and shown in full only on the detail
page. It is business banking data, not a secret, but a register that puts every account number on
one screen is a register nobody should leave open on a counter.

---

## 7. ⛔ Deliberately out of scope

| Not built | Why |
|---|---|
| `supplier_bank_accounts` child table | §4.3 — 5 suppliers, 1 account each |
| `paymentOptions` | 1.6% filled, and both rows say `"Cash"`. A dead field |
| `contactNo2`, `logoPath`, `lastCreditDueDays` | 1.6% / 4.7% / 3.1%, and the last is set to `null` by its only writer |
| `outstandingBalance` | ⭐ v2 **derives** it. v1 stores it and it drifts — porting it would import the drift |
| EWT / withholding on `classification` | §4.2 — nobody has decided the rates, and guessing them is worse than not having them |
| `linkedArCustomerId` | v2 models the commissary seam through `commissary_links`; a second link would be a second truth |
| An `/ap/invoices` list page | Out of scope for a supplier task. The nav is pointed at `/ap`, which lists invoices already |

---

## 8. Done when

1. A supplier can be **edited** — the gap that motivates the task.
2. `/ap/suppliers` renders the register and is reachable from the nav without a 404.
3. `issues_official_receipt` defaults `supplier_invoices.is_official_receipt` at creation, and the
   invoice may then disagree with the supplier. ⭐ A test asserts the default is *copied*, not read
   through — changing the supplier later must not rewrite last month's invoice.
4. The account number is masked in the register and whole on the detail page.
5. `approve_supplier` denies staff on **edit** as well as create, with a test.
6. ⭐ Driven in a browser: create, edit, search, and log an invoice that inherits the default.

## 9. Gates

`npm run typecheck` · `npm run test` · `npm run test:integration` · `npm run build`, and the
screens rendered in Chrome on port 9008.

---

## 10. ✅ Built — 2026-08-31

| Delivered | Where |
|---|---|
| 8 columns on `suppliers`, 1 on `supplier_invoices` | migration `0104`, `packages/db/schema/suppliers.ts` |
| `editSupplier` | `packages/domain/src/ap/index.ts` — gated `approve_supplier` |
| The official-receipt default, copied at invoice creation | `recordInvoice` |
| `/ap/suppliers` — the register, searchable, masked account numbers | new route |
| The edit form | `/ap/suppliers/[id]` |
| Tests | 12 integration + 9 unit |
| DEF-106, DEF-107 | `docs/DEFECTS-REGISTER.md` |

### 10.1 ⭐ The assessment changed the build, which is the point of doing one

**I recommended this task on a reason that turned out to be false.** *"You cannot pay a supplier
from v2's record"* — true, and worthless as an argument, because **v1 cannot pay 96% of its
suppliers from the record either.** The probe is what said so:

```
bankAccounts filled     5 of 129   (3.9%)   — and every one has exactly ONE account
paymentOptions filled   2 of 129   (1.6%)   — both rows hold the single value "Cash"
vatRegistrationNo       3 of 129   (2.3%)
contactNo2              2 of 129   (1.6%)
```

⛔ **Had I built the proposal as written** — widen the table, add a `supplier_bank_accounts` child
table, port every field — the result would have been a join on every read to serve five rows, and
four columns nobody fills. The parity score counted fields; fields are not equally real.

### 10.2 ⭐ What the probe found that the parity score could not

| Finding | Consequence |
|---|---|
| `apRepo.updateSupplier` had **no caller** | **DEF-106.** A supplier could be created and never corrected. This became the task |
| `/ap/suppliers` and `/ap/invoices` were nav links with no page | **DEF-107.** Two 404s in the main nav |
| `issuesOfficialReceipt` is 66% filled **and drives the receipt type** | The only ported field that does work — and it needed BOTH halves (§4.4) |
| `classification` is 96% filled and **drives nothing** | Ported as a label, with the ban on branching written into the enum's own docblock |
| 129 documents hold **88 distinct suppliers** | v2's org scoping already removes 41 duplicate rows and a vendor filed 20 times |

### 10.3 ⚠️ One thing the build changed about the spec

`EditSupplierInput` was specced as extending `CreateSupplierInput`, which made `name` **required**
on an edit. The integration test that edits only `issuesOfficialReceipt` would not compile — and
that is the test catching a real design error, not a typing inconvenience: a required `name` pushes
every caller into sending a whole object, which is exactly the shape that blanks the fields a form
did not happen to render. It is now `Partial<CreateSupplierInput>`.

## 11. Gates — 2026-08-31

`typecheck` ✅ · `unit` ✅ · `integration` ✅ · `build` ✅ · `/ap/suppliers` and the edit form driven
in Chrome: created, edited, searched by representative and by bank, account number masked on the
list and whole on the detail page.

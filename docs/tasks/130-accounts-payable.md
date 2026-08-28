# T-130 — Accounts payable: supplier invoices, payments, open-item allocation

> **Status:** Spec ready, not yet implemented. **Depends on:** T-118 (subledger party pattern,
> DEF-037), T-122 (expenses — the credit-method booking leg already exists), T-129 (customers —
> the counterparty pattern this mirrors), ADR-010 (money locations, bible row 142).
> **Blocks:** T-131 (AR — needs the aging-basis decision this spec raises settled first),
> `loans.lender_name` (T-126, already written expecting this task to add the FK).
> **Written by:** Sonnet, 2026-08-27, in-session — not the Opus planner. Bible §3.1a/row 93 assigns
> specs to Opus; this one was written directly because the full discovery pass (below) was already
> in-context and re-deriving it cold in a fresh Opus agent would have cost more than it returned.
> Flagged for a planner pass before implementation starts, not as a formality — §16.10's rules
> below (aging basis, duplicate detection) are cross-module decisions this task cannot ratify
> alone (§14: a spec that amends the bible is itself a defect). **Bible §3.3 format.**

## Why this task, and what it actually is

`2110 Accounts payable` has been `requires_party` since T-118 closed DEF-037, and
`expense.credit.ap` has been posting to it since T-122 — **but every credit-method expense today
names its supplier with opaque text** (`expenses.supplier_id: text`, "no suppliers table exists
until Wave 3" per that file's own comment). Nothing has ever *paid down* a 2110 balance, so
`packages/db/src/repo/liabilities.ts`'s `positionOf` pattern — sum a control account by party,
`outstanding = charged − paid`, no stored balance — has never been proven for a control account
with **more than one open item per party**. That is what makes this task different from T-126
(loans) and T-128 (liabilities): a lender or a liability has one balance; a supplier has many open
invoices, and a payment must say **which ones** it settles. This task builds: (1) a real
`suppliers` table, (2) a `supplier_invoices` header so a payment can name what it is paying rather
than pay "the supplier" in the abstract, (3) `ap_payments` + `ap_payment_allocations` so a single
payment can span several open invoices, funded by exactly one account, and (4) the aging/open-item
query that answers "what do we owe, and how late."

## Grounding — read as requirements, not design (bible §1.2b)

Everything below is cited to a specific file in `ERP-rebuild` (read-only, never modified) or to
this project's own settled decisions. Nothing here is invented.

- **`src/types/index.ts:392` `SupplierPlain`** — the real v1 supplier record. Has
  `linkedStoreId`/`linkedArCustomerId` ("Commissary feature: when set, this supplier is a
  system-managed mirror of an AR customer on another store... kept in sync on subsequent edits...
  locked down to system writes only"), `reconciledAsOfDate`/`reconciledAt`/`reconciledByUid` ("Same
  shape as `ARCustomerPlain`"), and — DEF-075's family again — `outstandingBalance?: number | null`.
  **The counterparty link is real and system-managed, the stored balance is the defect.**
- **`src/types/index.ts:441` `ReceiptPlain`** — a v1 supplier invoice: `supplierId`, `receiptNo`,
  `receiptDate`, `totalAmount`, `status` (`pending|verified|voided`), `recordingStatus`
  (`open|closed|locked`), `recordedAmount`. One receipt can be broken into several `expenses`
  postings over time (`ExpensePreviewItem`, `ReceiptExpensesProjection`), which is exactly the
  "Credit Expense (Receipt)" tab and "Pay receipt" flow in
  `src/app/financial/ap/[id]/ap-details-client.tsx`.
  ⚠️ **Naming trap, logged to `docs/GLOSSARY.md` as part of this spec:** "receipt" already means a
  **sales** receipt everywhere else in this project's four reference repos. Reusing it for a
  supplier invoice would be exactly the ambiguity the glossary exists to prevent. **v2 calls this
  `supplier_invoices`.**
- **`src/lib/actions/receipt.actions.ts`, `src/lib/financial/receipt/{eligibility,recording}.ts`
  and `expense.actions.ts:141-521`** — **the real create→verify→record mechanism**, read on Ian's
  direct instruction after the first spec draft mischaracterized it (§2's history below). This is
  the pattern Contract §2 now ports:
  - `canTagExpenseToReceipt(receipt) = status==='verified' && recordingStatus==='open'`
    (`eligibility.ts:4-8`) — the actual gate. A **pending** receipt cannot be tagged at all.
  - `recordingStatus` starts **`locked`** on create, flips to **`open`** only inside
    `verifyReceiptAction`'s transaction, and is recomputed to **`closed`** once
    `unrecordedAmount < RECEIPT_FULLY_RECORDED_TOLERANCE` (**₱1** — `recording.ts:13`, chosen
    because sub-peso residuals are VAT-split/rounding noise, not real balance left to record).
    It is a **cache**, always recomputed together with `recordedAmount` in the same transaction —
    never independently hand-set — which is why it's a different case from DEF-072/074/075's
    stored-balance defects. It still needed a standing repair action
    (`reconcileReceiptBalance`, admin-only) for when it drifts anyway — **that repair action
    existing at all is the argument for v2 not storing the cache in the first place** (see
    Contract §2's "not stored" call).
  - **The photo gate fires at CREATE, not at verify** (`receipt.actions.ts:267-281`) — this spec's
    prior draft had that backwards. Exempted only for a commissary-mirror supplier
    (`isCommissaryMirrorSupplier`) or a receipt minted for an already-received, unlinked delivery
    of the same supplier (`isReceiptForRecordedDelivery`) — Phase 3, not built here.
  - **Receipt-date authority** (`expense.actions.ts:179-197`, doc-18, Ian 2026-07-15): a linked
    expense's business date is **forced server-side** from the invoice's own date, ignoring
    whatever date the client sent. Ported as-is (Invariants, below).
  - **`expenseData.receiptId` is OPTIONAL in v1 today** — no validation anywhere in `upsertExpense`
    requires it. **Ian's decision makes it mandatory in v2, for every supplier expense including
    cash** — a deliberate v2 tightening, not something v1 already enforces. Said plainly so nobody
    reads this Contract as "just what v1 does."
  - **Void cascades, and must reuse the existing primitive, never reimplement it**
    (`voidReceiptAction`, `receipt.actions.ts:568-602`): it calls the shared `voidExpense()` for
    every linked expense rather than reversing journal legs inline. The comment names exactly why —
    an earlier inline version silently skipped budget release, cash-request liquidation, the
    expense-summary projection, and a CAPEX asset's live-depreciation guard. **Four real things
    missed** by not reusing the primitive. This is the single most load-bearing lesson in this
    citation and is written into Invariants below.
  - **Duplicate-invoice detection was already built and is currently dead code**
    (`findDuplicateReceiptsAction`, `receipt.actions.ts:143-175`, un-exported 2026-07-22, zero
    callers). Warn-only, keyed on `(supplierId, receiptNo)`, excluding the record being edited —
    exactly bible §16.10's rule. **v2 finishes wiring what v1 already designed correctly**, not a
    new invention (Invariant 10, unchanged by this correction).
  - **VAT is real and active on v1's receipt**, not merely displayed: `vatType`/`vatRate`/
    `vatAmount`/`vatExclusiveAmount`, recomputed server-side from the supplier's own VAT
    registration status (`receipt.actions.ts:283-325`), refusing VAT fields outright on a
    non-VAT-registered supplier rather than silently accepting bad client data. Flagged as a
    scope question below — capturing the data is cheap and lossless; posting it to a separate
    input-VAT account is a bigger question this spec does not resolve.
- **`src/lib/financial/ap/ap-projection.server.ts`** — `ap_open/{supplierId}/{expenseId}`, a
  hand-maintained Firestore projection of open items, upserted on every expense write and deleted
  when closed. **This is the exact shape invariant 3 (bible §16.1) forbids** — a parallel writable
  balance that can and did drift: `[[project_ap_open_stale_receiptid]]`, a real production
  incident where `receiptId` was absent on projections written before that field existed, so the
  "Pay receipt" grouping silently showed 1 of 7 open items. **Logged fresh as DEF-076** (below) —
  not previously in this register. v2 cannot repeat this class of bug **structurally**: there is no
  stored open-item projection at all (see Contract §4).
- **`src/lib/financial/journal/builders/ap-payment.builder.ts`** — v1's payment posting: up to
  three legs — funding account OUT (full amount), `ap__{supplierId}` OUT (allocated amount only),
  `supplier_advance__{supplierId}` IN (unallocated amount, overpayment only). **This is already
  `docs/POSTING-PATTERNS.md` lines 429–457** (`ap_payment.simple`, `ap_payment.overpayment`) —
  verified, not re-derived.
- **`src/lib/actions/payment.actions.ts`** — the allocation mechanism: `AllocationInput[{ apId,
  amountApplied }]` where `apId` is an **expense id** (comment: *"id: string // Should be the
  expenseId for idempotency"*, *"apId: string // Add this to make it explicit"*). Validated before
  posting: every allocated expense belongs to the **same supplier**, is `status === 'posted'`, is
  still open (`outstandingAmount > 0`), and `sum(allocations) <= payment.amount` (over-allocation
  refused outright, not clamped). This is the open-item allocation this task's title names.
- **`docs/discovery/17-industry-erp-patterns.md` §4** (cited already by `journal.ts`'s own header
  comment) — the counterparty-on-the-line pattern this task's schema continues, not reopened here.
- **Bible §16.10** (posting-pattern rules adopted from the `accounting-systems` skill,
  2026-08-22) — the specific rules this task must satisfy: pick ONE aging basis and hold it for AP
  *and* AR; payments must name the open items they settle, never float; duplicate-invoice
  detection on supplier + invoice number + date, warn at minimum; withholding tax recognised at
  invoice posting, not payment; three-way match wherever POs exist.
- **Bible row 158** (loans, 2026-08-27) — *"there is no `loan_payments` table: a payment is not a
  thing beside the ledger, it IS a ledger entry."* Same discipline applies here: no stored
  `outstandingBalance` anywhere in this task's schema, full stop.

## Goal

No expense — cash or credit — can be recorded until its supplier invoice is verified; a supplier
can then be owed money through one or more of those verified invoices; a payment can settle part or
all of one or several of them, funded from exactly one account; every AP balance — per supplier,
per invoice, and the `2110` control total — is derived from `journal_lines`, never stored; and
`loans.lender_name` gains the FK it has been waiting for since T-126.

## Scope

**New files**
- `packages/db/schema/suppliers.ts` — `suppliers`, `supplier_invoices`.
- `packages/db/schema/ap-payments.ts` — `ap_payments`, `ap_payment_allocations`.
- `packages/db/src/repo/ap.ts` — the only place SQL is written for this task (mirrors
  `repo/liabilities.ts`'s `positionOf`): per-supplier control balance, per-invoice open-item
  query, aging buckets. No business rules here — reads only, plus the two inserts a posted payment
  needs inside its own transaction.
- `packages/domain/src/ap/**` — `recordInvoice`, `verifyInvoice`, `voidInvoice` (Contract §2),
  `recordPayment`, `voidPayment` (Contract §3). Follows `domain/src/liabilities`'s one-module shape
  unless the verb count argues for `expenses`'s per-file split — implementer's call, not fixed here
  (bible §0.1).
- `packages/db/migrations/00NN_t130_accounts_payable.sql`, hand-written — **DEF-073: `db:generate`
  is unusable.** Journal it with `previous.when + 86400000` in
  `packages/db/migrations/meta/_journal.json`. The last entry as of this spec is idx 42
  (`0042_t129_customers_and_price_lists`, `when: 1789702307084`) — the new entry is
  `idx: 43, when: 1789788707084`.
- `apps/erp/src/app/ap/**` — supplier list/detail, invoice list, record-payment screen, aging
  report. Mirrors `apps/erp/src/app/liabilities` and `apps/erp/src/app/customers`.

**Existing files this task modifies**
- `packages/db/schema/expenses.ts`:
  - `supplierId: text` → `supplierId: uuid NOT NULL` FK `suppliers.id`, `onDelete: 'restrict'`.
    **Required, not nullable** — every expense recorded through this module names a supplier now
    (Contract §2). **Clean replacement, not expand/contract (bible §15.5):** no real postings exist
    yet — the project runs for real starting October 2026 (bible §1.4), today is 2026-08-27, so
    existing `expenses` rows are dev/test data, freely alterable. ⚠️ **Flagged for confirmation**:
    if pilot data already exists that must be preserved, this becomes expand/contract instead.
  - Add `supplierInvoiceId: uuid NOT NULL` FK `supplier_invoices.id`, `onDelete: 'restrict'` —
    replaces `ExpenseV2Plain.receiptId`'s role, now mandatory (Contract §2).
  - **Retire `receiptPhotoUrl` / `receiptFileId`** — the evidence relocates to
    `supplier_invoices` (Contract §2). DEF-055 is not un-fixed, its enforcement point moves; noted
    in the register entry below so a future reader isn't confused when these stop being read.
- `packages/domain/src/expenses/create.ts` (T-122) — gains the `openForRecording` precondition and
  the create-and-post-together behaviour Ian specified (*"expense may already be posted, no need
  for draft"*): when the trigger's precondition already holds, `create()` posts in the same call
  it used to leave in `draft`. **Does not touch `void.ts`** — `voidInvoice` (Contract §2) calls the
  existing void primitive, it does not modify it, mirroring how `voidReceiptAction` calls
  `voidExpense` without editing it. ⚠️ **Flagged for the implementer, not decided here**:
  invariant 2 makes the verified-invoice gate universal, so `approve.ts`'s separate draft→posted
  step may have no remaining caller — check for one (an edit-then-approve path, say) before
  assuming it's dead; if none exists, that's a real finding to report, not silently leave unused.
- `packages/db/schema/loans.ts` — add `lenderId: uuid` FK to `suppliers.id` (nullable — not every
  lender is a supplier-shaped counterparty), `onDelete: 'restrict'`, beside the existing
  `lenderName`. Per that file's own comment: *"When it lands this gains an FK beside the name; the
  party on the LINE does not change."* The party stays `party_type='loan'` (row 158) — this FK is
  informational/lookup only, never posted.
- `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts` — every new
  table classified and registered, per this repo's own build gate (an unlisted table fails the
  build by design). Check how `customers`/`suppliers`-shaped master data vs. `expenses`-shaped
  transactional data were classified for the nearest precedent before picking a class.
- `docs/decisions/CAPABILITY-MATRIX.md` — new capabilities for "verify a supplier invoice" and
  "record an expense against one" (Contract §2's open role question), each with a test proving the
  ✗ fires, per this repo's own rule for that file.
- `docs/GLOSSARY.md` — add the "receipt" entry above.
- `docs/DEFECTS-REGISTER.md` — DEF-076 (below), already added as part of this research pass; the
  DEF-055 relocation note also lands here as part of implementation, not this spec.

## Contract

### 1. `suppliers`

```
suppliers
  id                     uuid PK default uuidv7()
  org_id                 uuid NOT NULL FK organizations, restrict
  name                   text NOT NULL
  address                text
  contact_no             text
  counterparty_store_id  uuid FK stores, restrict, nullable
                           -- v1 SupplierPlain.linkedStoreId. System-managed only (see Invariants) —
                           -- never editable from the ordinary supplier form.
  status                 text NOT NULL default 'active', check in ('active','inactive')
  notes                  text
  reconciled_as_of       date
  reconciled_at          timestamptz
  reconciled_by          uuid FK persons, restrict
  created_by             uuid NOT NULL FK persons, restrict
  created_at             timestamptz NOT NULL default now()
  updated_at             timestamptz

  unique (org_id, name)
  check: name not blank
  check: reconciled_as_of / reconciled_at / reconciled_by all-or-nothing (customers.ts's shape)
```

**Deliberately omitted, and why:**
- `counterparty_org_id` — v1's `SupplierPlain` has no cross-org link (unlike `customers`'s
  franchise case). Not adding a field with no v1 precedent and no stated need (bible §16.4:
  "it might be useful later" is not a reason).
- `vat_registration_no`, `bank_accounts` — v1 carries these, no posting or validation behaviour
  reads them anywhere. Out of scope.
- `vat_status` — **coupled to the VAT flag in Contract §2, not independently decided.** v1's
  receipt VAT fields are only valid when the *supplier's* `vatStatus === 'VAT Reg'`
  (`receipt.actions.ts:283-325` — a non-VAT supplier gets its VAT fields rejected outright, not
  silently zeroed). If Contract §2's VAT recommendation is taken, this column comes with it,
  same task, same decision. If not, this stays out too — adding it alone would be DEF-071's shape,
  a field with no behaviour behind it.
- `outstanding_balance` — DEF-075, the sixth time, refused before it's written.

### 2. `supplier_invoices` — the gate every expense in this module now passes through

⚠️ **Corrected 2026-08-27, by Ian, directly, twice.** First: this spec's original draft called
v1's `pending → verified` receipt lifecycle redundant with expense approval and dropped it. Ian:
*"receipt and expense are 2 separate record[s], before an expense can be recorded it needs a
verified receipt — but expense may already be posted, no need for draft."* And it applies to
**every supplier expense, cash included, not only credit/AP ones** — confirmed explicitly, not
inferred. Second: told directly to *"look at how v1 expense is recorded and use that pattern"* —
so this section now ports v1's actual mechanism (Grounding, above), not a re-derived approximation
of it.

```
supplier_invoices
  id                 uuid PK default uuidv7()
  org_id             uuid NOT NULL FK organizations, restrict
  store_id           uuid NOT NULL FK stores, restrict
  supplier_id        uuid NOT NULL FK suppliers, restrict
  invoice_no         text                      -- supplier's own reference. Nullable — not every
                                                -- purchase carries one (v1's receiptNo is optional too)
  invoice_date       date NOT NULL
  due_date           date                      -- typed and real, nullable — informal supplier terms
                                                -- are real. Aging (invariant 11) falls back to
                                                -- invoice_date when this is null.
  total_amount       numeric(14,2) NOT NULL, check > 0
  notes              text
  status             text NOT NULL default 'pending', check in ('pending','verified','voided')
  receipt_photo_url  text                      -- the evidence — required at CREATE, not verify
                                                -- (v1's actual gate; see Invariants). RELOCATES
                                                -- expenses.receiptPhotoUrl (DEF-055) here.
  receipt_file_id    uuid                      -- T-141 brokered file, same role
  verified_by        uuid FK persons, restrict
  verified_at        timestamptz
  created_by         uuid NOT NULL FK persons, restrict
  created_at         timestamptz NOT NULL default now()
  updated_at         timestamptz
  voided_by          uuid FK persons, restrict
  voided_at          timestamptz
  void_reason        text

  check: status <> 'verified' or (verified_by is not null and verified_at is not null)
                                                -- ⚠️ CORRECTED during implementation: first
                                                -- written as a biconditional (customers.ts's
                                                -- reconciled_* shape), which rejected every void
                                                -- of an already-verified invoice — voiding must
                                                -- KEEP the anchor as history, not clear it. One-
                                                -- directional instead: reaching 'verified'
                                                -- requires the anchor; leaving it does not erase it.
                                                -- Caught by this task's own void-cascade test.
```

**Deliberately NOT a DB CHECK on the photo columns.** v1's own photo rule isn't a flat "always
required" either — it exempts a commissary-mirror supplier and a delivery-linked receipt
(Grounding, above), and a CHECK constraint can't safely join out to `suppliers` to test that. This
stays a service-layer rule in `recordInvoice`, matching where v1 puts it. **Recommendation:**
require the photo at create unless `suppliers.counterparty_store_id` is set (the commissary
exemption ports cleanly — the field already exists in Contract §1); the delivery exemption does
not port, because no delivery table exists yet (Phase 3).

**No stored `recorded_amount` / `unrecorded_amount` / `recordingStatus` columns — a deliberate
departure from v1, not an oversight.** v1's version is a *derived* cache (always recomputed
together with the facts that drive it, never hand-set independently — a different case from
DEF-072/074/075), but it still needed `reconcileReceiptBalance` as a standing repair path for when
it drifted anyway. v2 has no cache to drift: `capacityOf(invoiceId)` and `assertOpenForRecording(...)`
(`packages/db/src/repo/ap.ts`) compute `total_amount - SUM(expenses.total_amount)` live, every time.

⚠️ **Two DIFFERENT tolerances, corrected during implementation after conflating them caught a real
bug (a capacity test failed).** `FULLY_RECORDED_TOLERANCE = 1` — v1's own
`RECEIPT_FULLY_RECORDED_TOLERANCE`, ported as a named constant — answers *"is what's left small
enough to stop OFFERING this invoice for more recording"* (the picker in
`apps/erp/src/app/expenses/new`). The hard capacity check inside `assertOpenForRecording` (and the
matching DB trigger) answers a different question — *"does THIS posting fit"* — and needs its own
much tighter `CAPACITY_EPSILON = 0.005` (decimal rounding only). Using the ₱1 figure for both let a
single expense overshoot an invoice's total by up to a peso.

**The gate itself — enforced as a trigger, not just application code**, matching how this schema
already enforces account-eligibility and period-open (`journal.ts`'s header comment): `BEFORE
INSERT OR UPDATE on expenses`, when `supplier_invoice_id` is set, reject unless
`openForRecording(supplier_invoice_id)` is true at that instant. Application code should still
pre-check and return a clean error — the trigger is the backstop that makes it true regardless of
which code path writes the row, the same reasoning DEF-037/T-118's party-requirement trigger
already established for this codebase.

**Receipt-date authority, ported exactly** (`expense.actions.ts:179-197`): when an expense names a
`supplier_invoice_id`, its `business_date` is set server-side from `supplier_invoices.invoice_date`
— never trusted from the client, standalone (non-invoice) expenses untouched.

**`recordInvoice(input): { invoiceId, duplicateWarning? }`** — creates a `pending` row, running the
Grounding-section duplicate check (`supplier_id + invoice_no + invoice_date`, excluding nothing
since this is a create) and returning a warning, never blocking.

**`verifyInvoice(invoiceId, actorId)`** — flips `pending → verified`, stamps `verified_by`/
`verified_at`, requires the photo (service-layer check above). Nothing else changes; recording the
first expense against it is a separate call, matching v1's two actions (`verifyReceiptAction`,
`upsertExpense`) rather than v1's UI possibly chaining them together for the common case.

**`voidInvoice(invoiceId, reason, actorId)`** — **must call T-122's existing expense-void primitive
for every live linked expense, in a loop, never reimplement the reversal.** This is the single
most load-bearing lesson in this task's grounding (v1's inline version silently skipped budget
release, cash-request liquidation, the expense-summary projection, and a CAPEX asset's
live-depreciation guard — four real things, not a hypothetical). Sequential, fail-fast, retry-safe:
if one linked expense's void fails, the ones already voided stay voided and the invoice is not
flipped, matching `voidReceiptAction`'s exact contract.

**Open, and flagged rather than guessed:** who may verify, and who may record an expense against a
verified invoice. Load-bearing enough to need a real answer in
`docs/decisions/CAPABILITY-MATRIX.md`, not an assumption buried in code. **Recommendation:**
manager level for both, matching this system's other posting-adjacent approvals (row 153, T-122's
`approve()`); logging a *pending* invoice — before anyone has verified anything — can reasonably
sit lower, since nothing has posted and nothing is trusted yet.

**Flagged, not resolved: VAT.** v1's receipt carries real, server-recomputed
`vatType`/`vatRate`/`vatAmount`/`vatExclusiveAmount` (Grounding, above) — not a display-only field.
**Recommendation:** capture the same four fields on `supplier_invoices` (duplicate what's good,
it's cheap and lossless), but do **not** build new input-VAT GL posting in this task — nothing in
`POSTING-PATTERNS.md`'s `expense.credit.ap` splits VAT today, and inventing that split without a
discovery pass on how it should hit the chart of accounts would be the exact kind of unconfirmed
scope this task's Out of scope section already refuses for withholding tax. If Ian wants VAT data
captured now, it is additive to this Contract; if it should also post, that is materially bigger
and belongs in its own task.

### 3. `ap_payments` / `ap_payment_allocations`

⚠️ **Corrected during implementation, before any code shipped.** This spec's first draft gave
`ap_payments` its own `funding_source` enum (`cashier|office|staff|online|other`), mirroring what
looked like `expense_payments`'s shape. Re-reading `routing.ts`'s actual, already-fixed behaviour
(DEF-058) caught the mistake: `expense_payments` does **not** have a custodian enum any more — cash
and online are ONE branch there, both keyed by a real `money_account_id`, precisely *because* a
user-typed custodian label is how v1's office-drawer bypass happened (ADR-010). Giving `ap_payments`
its own enum would have reintroduced the exact anti-pattern this schema already removed elsewhere.
Fixed before the migration was finalized — `money_account_id` is simply always required.

```
ap_payments
  id                uuid PK default uuidv7()
  org_id            uuid NOT NULL FK organizations, restrict
  store_id          uuid NOT NULL FK stores, restrict
  supplier_id       uuid NOT NULL FK suppliers, restrict
  business_date     date NOT NULL
  amount            numeric(14,2) NOT NULL, check > 0        -- the TOTAL handed over
  money_account_id  uuid NOT NULL FK money_accounts, restrict -- ALWAYS required — no funding_source
                                                               -- enum (see correction above). The
                                                               -- account's own custodian/instrument
                                                               -- decide the GL code, never typed.
  cash_request_id   uuid FK cash_requests, restrict            -- attribution only, mirrors
                                                               -- expense_payments.cash_request_id's
                                                               -- role exactly. ⭐ A REAL FK, unlike
                                                               -- that column's opaque text — T-144
                                                               -- (cash_requests) didn't exist when
                                                               -- that column was written; it does now
  reference_no      text
  notes             text
  status            text NOT NULL default 'draft', check in ('draft','posted','voided')
  journal_entry_id  uuid FK journal_entries, restrict
  created_by        uuid NOT NULL FK persons, restrict
  posted_at         timestamptz
  voided_by         uuid FK persons, restrict
  voided_at         timestamptz
  void_reason       text
  created_at        timestamptz NOT NULL default now()
  updated_at        timestamptz

ap_payment_allocations
  id               uuid PK default uuidv7()
  ap_payment_id    uuid NOT NULL FK ap_payments, cascade
  expense_id       uuid NOT NULL FK expenses, restrict
  amount_applied   numeric(14,2) NOT NULL, check > 0

  unique (ap_payment_id, expense_id)
```

**`recordPayment(input): { paymentId }`** (`packages/domain/src/ap`)
1. Load every allocation's expense; reject the whole payment (no partial apply) if any: belongs to
   a different supplier than `input.supplierId`; `status !== 'posted'`; has no open balance
   (`creditPortion(expense) - sum(existing posted allocations) <= 0`); or is not a **credit-method**
   expense at all (an `expense_payments` row with `method='credit'`, `supplierId` set — the invoice
   booking T-122 already builds).
2. `sum(allocations.amountApplied) > input.amount` → reject outright (bible §16.10: never floats,
   never clamps).
3. `allocated = sum(allocations.amountApplied)`, `unallocated = input.amount - allocated`.
4. Build the journal entry exactly per `POSTING-PATTERNS.md` `ap_payment.simple` /
   `.overpayment`: **Dr** `2110` `allocated` (`party_type='supplier'`, `party_id=supplierId`) ·
   **Dr** `1240` `unallocated` if `> 0` (same party) · **Cr** the resolved funding account
   `input.amount`. Call `postEntry` (T-105) — never hand-build the entry.
5. Insert `ap_payments` (`status='posted'`, `journal_entry_id` set) and its
   `ap_payment_allocations` rows in the same transaction as the posting.

**`voidPayment(paymentId, reason)`** — `reverseEntry` (T-106) on the payment's journal entry; flip
`ap_payments.status` to `'voided'`. The allocation rows are **not deleted** — a voided payment's
allocations must stay visible so the invoice's open-item query (below) correctly shows the
expense open again. Matches invariant 5 (posted records immutable; corrections are new entries).

### 4. Open items and aging — queries, never a projection

`packages/db/src/repo/ap.ts`:

- **`positionOf(supplierId): { controlBalance }`** — `SUM(credit - debit) FROM journal_lines WHERE
  account_id = 2110's id AND party_type = 'supplier' AND party_id = supplierId`. Mirrors
  `repo/liabilities.ts`'s function of the same name exactly.
- **`openItems(supplierId): OpenItem[]`** — one row per credit-method expense with a positive
  outstanding balance: joins `expenses` (`method='credit'`, `status='posted'`) to
  `expense_payments` (the credit leg's amount) to `ap_payment_allocations` (posted payments only,
  via `ap_payments.status='posted'`), `outstanding = creditAmount - COALESCE(SUM(allocated), 0)`,
  filtered `> 0`. This — **not a stored table** — is v1's `ap_open` projection, and it cannot go
  stale the way DEF-076 did: there is nothing to upsert and forget.
- **`aging(orgId, asOfDate): AgingRow[]`** — buckets `openItems` by
  `asOfDate - <aging basis>` into current / 1–30 / 31–60 / 61–90 / 90+, grouped by supplier.
  ⚠️ **Aging basis is an open decision, not made here** — see Invariants.
- **Invariant 6 check** (already proven for `2110` by T-118; this task's own integration test
  re-proves it for the first control account with >1 open item per party):
  `SUM(openItems.outstanding) per supplier` must equal `positionOf(supplier).controlBalance` for
  every supplier with any activity.

## Invariants

Cited to `docs/discovery/` and the bible per §3.3's requirement.

1. **No stored balance anywhere in this task's schema** — bible §16.1 invariant 3, DEF-075's
   pattern (found five times before this task; this is the sixth chance to not repeat it).
2. **No expense may be created without a `supplier_invoice` that is `verified` and has remaining
   capacity — universal, cash included.** Ian, 2026-08-27, confirmed explicitly against the
   alternative (credit/AP-only) this spec offered. Enforced by the `openForRecording` trigger on
   `expenses` (Contract §2), mirroring `canTagExpenseToReceipt`'s gate exactly
   (`eligibility.ts:4-8`) — **a v2 tightening beyond what v1 itself enforces today**
   (`expenseData.receiptId` is optional in `upsertExpense`), not a carry-over.
3. **Receipt-date authority** — an invoice-linked expense's `business_date` is set server-side from
   `supplier_invoices.invoice_date`, never trusted from the client. Ported exactly from
   `expense.actions.ts:179-197` (doc-18, Ian 2026-07-15); standalone expenses are unaffected — there
   are none left under invariant 2, but the rule's scope is stated precisely in case that changes.
4. **Every `2110`/`1240` line carries a party** — the T-118 trigger already enforces this at the
   database level; this task's rows must supply `party_type='supplier'` correctly, not rely on the
   trigger to catch a missing one at the last moment.
5. **A payment must name what it settles** — bible §16.10. `ap_payment_allocations` is the only
   way money leaves `2110`; there is no "pay the supplier" path that skips naming invoices.
6. **Overpayment is a named asset, never unallocated cash** — `1240 Advances to suppliers`,
   already seeded (`packages/db/seed/chart-of-accounts.ts:141`), `requires_party: true`. Verified
   against the live seed, not assumed.
7. **`counterparty_store_id` is system-managed, never hand-edited** — v1's own rule
   (`SupplierPlain.linkedStoreId` comment: "locked down to system writes only"). This task should
   surface it read-only on the supplier form; the write path that sets it (when a commissary AR
   customer names a branch) is `customers`/T-129's concern, not new work here, unless discovery
   during implementation shows otherwise.
8. **Posted payments are immutable; void reverses, never edits** — bible invariant 5. Extends to
   `supplier_invoices`: `voidInvoice` cascades through T-122's existing expense-void primitive for
   every live linked expense, **never a reimplemented reversal** — `voidReceiptAction`
   (`receipt.actions.ts:568-602`) documents exactly what an inline version silently missed: budget
   release, cash-request liquidation, the expense-summary projection, and a CAPEX asset's
   live-depreciation guard. Sequential, fail-fast, retry-safe — already-voided expenses are
   filtered out on retry, matching v1's contract precisely.
9. **Period-open enforced on every posting path** — inherited free from `postEntry`; no
   AP-specific bypass may be introduced.
10. **Duplicate-invoice detection is a warning, not a block** — bible §16.10 says "warn at
    minimum," and a corrected re-entry of the same supplier/number/date is a real, legitimate case.
    Service-layer check (`supplier_id + invoice_no + invoice_date`) on `recordInvoice`, **not** a
    unique constraint — completing `findDuplicateReceiptsAction`
    (`receipt.actions.ts:143-175`), which v1 built correctly and simply never wired up.
11. **Aging basis: DUE DATE — decided by Ian, 2026-08-27.** §16.10 requires ONE basis, consistent
   across AP and AR; T-131 must follow this. `supplier_invoices.due_date` is where it reads from.
   An invoice with no due date (informal supplier terms — real, not hypothetical) falls back to
   `invoice_date` for aging purposes only. ⚠️ **Not yet a bible row** — §14: "a Sonnet implementer
   never amends it, it reports a conflict and stops." The exact row text is drafted and ready
   below; an Opus pass copy-pastes it in, bumps Version/Last amended, and this footnote comes out.

   > **Draft bible §13 row** (next row number after 161 — confirm against the live decision log
   > before pasting, in case another row landed first): *2026-08-27 — **AGING IS BY DUE DATE, NOT
   > INVOICE DATE, FOR BOTH AP AND AR.** Ian: "due date." An invoice/charge with no stated due date
   > (informal supplier or customer terms) falls back to its own document date for aging only —
   > the fallback does not change which basis governs when a due date exists. T-131 (AR) must use
   > the same basis; this decision is made once, here, not re-litigated per module. No — a
   > reporting convention, reversible if wrong.*
12. **Withholding tax and three-way match are out of scope, named so the omission is a decision**
    — §16.10 lists both as rules for *when* they exist. No expanded-withholding-tax accounts or
    PO/receiving module exist in this schema today (POs are not a table anywhere in
    `packages/db/schema/`). Building either here would be inventing requirements no discovery pass
    has confirmed. A future task owns each, informed by this task's `invoice posting` timing note
    for whichever lands first. VAT sits differently — Contract §2 flags it as a live, resolvable
    scope question, not a flat omission.

## Tests

Written before implementation (bible §3.2). Integration tests against real Postgres (§9.3).

1. Book a ₱10,000 credit expense against a new supplier invoice (T-122's existing path, now with a
   real `supplier_id`/`supplier_invoice_id`) → `openItems(supplier)` shows one row, outstanding
   ₱10,000; `positionOf(supplier).controlBalance` = ₱10,000.
2. Pay it in full → `ap_payments` posts Dr 2110 10,000 / Cr funding 10,000; `openItems` now empty;
   trial balance still ties.
3. Pay it partially (₱4,000) → outstanding drops to ₱6,000; the expense is still `posted` and still
   open; a second payment can still allocate against it.
4. Overpay by ₱500 on the remaining ₱6,000 → legs are Dr 2110 6,000 / Dr 1240 500 / Cr funding
   6,500, exactly `POSTING-PATTERNS.md`'s worked example.
5. One payment allocates across **two** open invoices from the **same** supplier, amounts summing
   to less than the payment total → both invoices' outstanding drops correctly; the remainder
   routes to 1240; invariant 6 re-check (test in Contract §4) passes for that supplier.
6. An allocation naming an expense that belongs to a **different** supplier → the whole payment is
   rejected, nothing is posted, no partial apply.
7. `sum(allocations) > payment.amount` → rejected before any write.
8. Allocating against an expense that already has no open balance → rejected. (Draft-status expenses
   are no longer reachable through the normal create path — invariant 2 — but the check still
   guards any expense the trigger didn't see, e.g. one created before this task shipped.)
9. Void a posted AP payment → `reverseEntry` fires, the reversed legs land back through 2110/1240,
   the originally-paid invoice's `openItems` row reappears with its prior outstanding balance, and
   the original entry stays visible and immutable.
10. Booking a second invoice with the same supplier + invoice number + date as an existing one →
    `recordInvoice` succeeds but returns a duplicate warning; nothing is blocked.
11. `aging()` buckets a 45-day-old open item into 31–60 correctly against whichever basis
    invariant 11 settles on.
12. `loans.lender_id` — disburse a loan naming a `suppliers` row as lender; the FK resolves; the
    posted journal entry's party is still `party_type='loan'` (row 158), unchanged by this task.
13. Attempt to post directly to `2110` or `1240` with no party → the existing T-118 trigger rejects
    it (proves this task didn't accidentally bypass existing protection).
14. Create an expense naming a `supplier_invoice_id` whose invoice is still `pending` (not yet
    verified) → rejected by the `openForRecording` trigger, no journal entry, no expense row.
15. Verify an invoice, record one **cash**-funded expense against it (not credit/AP) → posts
    immediately, no `draft` row ever exists, and it never appears in `openItems` (cash, not AP).
    Proves invariant 2 is universal, not credit-only.
16. Record expenses against a verified invoice until its remaining capacity drops below ₱1 → a
    further expense against the same invoice is rejected (the ₱1 `RECEIPT_FULLY_RECORDED_TOLERANCE`
    ported from v1, Contract §2).
17. An invoice-linked expense's `business_date` always equals its invoice's `invoice_date`, even
    when the create call is sent a different date — receipt-date authority, server-enforced.
18. Void a verified invoice with two live linked expenses (one already paid, funding a `2110`
    balance) → both expenses are voided through the existing void primitive (not reimplemented),
    their journal effects reversed, and the invoice flips to `voided` only after both succeed. A
    second void attempt after one linked expense fails to void leaves the successfully-voided one
    voided and the invoice unflipped (retry-safe, matching `voidReceiptAction`).

## Out of scope

Expanded withholding tax on purchases · three-way match / purchase orders (no PO table exists) ·
input-VAT GL posting (VAT *data capture* is a live recommendation in Contract §2, not out of
scope — only posting it to a separate account is) · any change to `postEntry`, `reverseEntry`,
`@shareat/auth`, or `expenses.ts`'s credit-booking logic beyond the changes named in Scope ·
deliveries and inventory-valued purchases (Phase 3, per T-122's own boundary) · recurring/scheduled
AP · statement-of-account / remittance-advice documents · combining `verifyInvoice` and the first
`recordInvoice` call into one UI action (Contract §2 keeps them as two separate calls, matching
v1's two actions; a combined "verify and record" screen is a UI convenience layered on top, not a
different domain contract).

## Done when

- [x] All invariants above pass against real Postgres, including the fresh invariant-6 proof for a
      multi-open-item party (Contract §4's own check — `ap.test.ts`'s "multi" test).
- [x] Migration hand-written per DEF-073 (`0043_t130_accounts_payable.sql`), applied to both
      `shareat_dev` and `shareat_test`. Two real bugs found applying it against `shareat_dev`'s
      one pre-existing (voided) expense row and fixed before finalizing — see Contract §2 and §3's
      own "corrected during implementation" notes (the verified-shape CHECK, and the capacity
      tolerance) — both re-applied live via `CREATE OR REPLACE` since the file had already run.
- [x] `typecheck` · `npm test` (598/598) · `npm run test:integration` (996/996) green, every
      pre-existing test still passing · `npm run build` succeeds (port 9008 was free; the dev
      server used for the smoketest below was stopped first, then restarted after). **No
      `npm run lint`** — DEF-027, there isn't one.
- [x] `packages/db/src/cutover/classification.ts` and `.../rls/registry.ts` updated for every new
      table (`suppliers` keep_shell, `supplier_invoices`/`ap_payments`/`ap_payment_allocations`
      purge) — both guard tests pass.
- [x] ⭐ **Smoketested on 9008, not just green tests.** Real flow: recorded a supplier, logged an
      invoice (pending), verified it (manager), recorded a CREDIT expense against it (posted
      immediately, correct `Dr 5100 / Cr 2110` with the supplier party), recorded a CASH expense
      against the same invoice (posted immediately, `Dr 5100 / Cr 1130`, proving the gate is
      universal), watched "Recorded/Remaining" update correctly, then recorded a partial payment
      from the supplier page and watched the open item's outstanding balance drop. **Found one real
      bug this way, not by the tests**: the embedded "record expense" form on `/ap/invoices/[id]`
      failed over to `/expenses/new` on any error (a hardcoded redirect, wrong page, every field
      wiped) — surfaced by a genuine overdraft rejection mid-smoketest. Fixed with a `returnTo`
      field (`apps/erp/src/app/expenses/actions.ts`). Overpayment and void-payment/void-invoice
      paths are proven by `ap.test.ts` but not separately re-driven through the browser this
      session — a reasonable follow-up smoketest, not a gap in what shipped.
- [x] `docs/GLOSSARY.md`'s "receipt" entry and `docs/DEFECTS-REGISTER.md`'s DEF-076 stay accurate.
      DEF-055's relocation is folded into **DEF-057, marked `fixed`** — that row already prescribed
      exactly what T-130 built (a first-class, referenced receipt entity), so the closure lives
      there rather than as a separate note.
- [ ] Invariant 11's draft bible row (aging basis — decided, due date) still needs an Opus pass —
      unchanged, this is not something a Sonnet implementer may do (§14).
- [x] `docs/decisions/CAPABILITY-MATRIX.md` carries `record_supplier_invoice`,
      `verify_supplier_invoice`, `void_supplier_invoice` — each with denial-case coverage in
      `packages/auth/tests/integration/authorize.test.ts` (44 capabilities now, was 41).
      `approve_supplier`'s scope was also corrected `store` → `org` (nothing depended on the old
      value — grep-verified unused before this task).
- [x] Any spec defect found while implementing — reported, never silently worked around (§3.4a):
      three corrections documented inline at Contract §2/§3 (the funding-source anti-pattern, the
      verified-shape CHECK, the capacity-tolerance conflation), plus the browser-found `returnTo`
      bug above.

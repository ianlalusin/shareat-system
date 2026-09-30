# T-367: AP/AR money — DEF-201, DEF-396, DEF-420, DEF-499, DEF-500, DEF-395, DEF-508, DEF-054

**Status:** **S1 IN PROGRESS — reds + step 1 parked on branch `wip/2026-09-30-reds`; step 2 = migration 0173 (after 0172)** — APPROVED 2026-09-30 (orchestrator, after independent Opus review; Q4/Q5 defaults ship). Review changes
1–7 and the minors applied. Spec by the Opus planner, 2026-09-30. Batch B of the money-defect
push (Ian, 2026-09-30: *"close all open money defects in v2"*), `docs/plans/money-defects-2026-09-30.md`.
**Model:** Sonnet for each slice, tester first and then builder. One lane runs the slices in order.
**Ordering:** builds only AFTER T-364 (edits `apps/erp/src/app/expenses/actions.ts`) and T-365 (edits
`packages/domain/src/ap/index.ts` and `apps/erp/src/app/ap/actions.ts`) have committed. Line numbers below were checked
at HEAD `72a6102`; both of those tasks will shift them, so the builder re-reads each cited site before editing.
**Migrations:** up to THREE, hand-authored per ADR-012 §5, each at the **next free index at build** (T-366 holds 0172,
T-368 0173, T-372 0174, so T-367 starts at ≥ 0175): S1 (write-off unique backstop), S2 (invoice gate trigger), S5
(retire `ar_collection` in the method CHECK). Journal `when` = previous `when` + 86,400,000 × (idx − previous idx).
**Gates:** S0 (a read-only count) runs first and gates S5. ⛔ S6 is BLOCKED on Ian's Q1–Q3. Every other slice has a
default that ships unless Ian rules otherwise.

## Goal
Every AP and AR figure stays equal to the ledger it summarises, under double-clicks, concurrent writers and bad input:
- one write-off decision makes exactly one subledger row, and two write-offs can never clear more than is owed;
- a voided supplier bill can never be paid, recorded against, or leave a posted expense behind;
- an expense can only be recorded against its own store's invoice;
- an invoice total that is not a number is refused in a plain sentence, and a due date follows the supplier's terms;
- the two v1 payment methods with no mapping are resolved as Ian ruled.

## Census, verified at source (corrections marked ✎)
- **DEF-201. Confirmed.** `writeOffCharge` (`packages/domain/src/ar/index.ts:495-570`) posts with key
  `ar_write_off:{chargeId}:{amount}:{personId}` (`:535`), then calls `arRepo.insertWriteOff` unconditionally (`:556`),
  never reading `result.created`. `voidCharge` (`:141`) and `voidCollection` (`:471`) both guard with it.
  `ar_write_offs` has no unique index on `journal_entry_id` (`packages/db/schema/ar.ts:162`, migration 0049:159).
  ✎ The register's cite `:486-455` is garbled; the function is `:495-570`.
  - ✎ **DEF-517 (logged): no lock, so two DIFFERENT write-offs can clear more than is owed.** The outstanding check
    (`:518-526`) reads `openItems` with no row lock. Two admins (different keys, so different entries) each writing off
    ₱700 of a ₱1,000 charge both pass. `recordCollection` locks first (`:295`, `arRepo.lockChargesForAllocation`,
    `repo/ar.ts:336-341`); `writeOffCharge` does not. Fixed in S1.
  - ✎ **DEF-520 (logged):** `Number(input.amount)` at `:515` is NaN-blind (`NaN <= 0` and `NaN > x` are both false). Fixed in S1
    because S1 rewrites these lines; T-371 loses this site.
- **DEF-396. Confirmed, but the register's premise is out of date.** ✎ The "business question" it asks Ian was answered
  on 2026-08-31 (bible row 170, quoted in migration `0113:13-15`): *"when receipt is rejected voided the draft expense is
  deleted or the posted expense is also voided."* The obligation dies with the document, and `voidInvoice`
  (`ap/index.ts:697-726`) already cascades. So the defect is narrower, and it is concurrency plus a missing second layer:
  - `openItems` (`packages/db/src/repo/ap.ts:608-663`) never joins `supplier_invoices.status`, so any posted expense on a
    voided invoice is settleable (`recordPayment`'s re-check at `ap/index.ts:883-925` reads the same function).
  - ✎ **The cascade races (part of DEF-396; the capacity half is DEF-518, logged).** `voidInvoice` reads `liveExpensesForInvoice` with no lock and marks the invoice
    voided last (`:711-722`). A concurrent `recordExpenseForInvoice`/`approveExpense` is not blocked: its FK insert takes
    `FOR KEY SHARE`, which does not conflict with the void's `UPDATE`, and the trigger
    `expenses_check_invoice_open_for_recording` (`0113:33-75`) reads the invoice with a plain `SELECT`. Result: a POSTED
    expense on a VOIDED invoice, which is exactly DEF-396's population. The same unlocked read lets two concurrent
    recordings each fit the invoice's capacity and together exceed it.
  - ✎ **DEF-519 (logged): voiding a PAID bill.** `voidExpense` (`packages/domain/src/expenses/void.ts:33-83`) never checks
    `ap_payment_allocations`. Voiding an invoice or expense that has been paid reverses the 2110 credit while the
    payment's 2110 debit and allocation row stand: the supplier's 2110 goes to a DEBIT balance, which
    `POSTING-PATTERNS.md` §supplier.return-credit forbids (*"⛔ Not a negative balance netted into 2110"*). Not in the
    register until DEF-519. S2 ships a refusal default (Q4).
- **DEF-420. Confirmed.** `ap/index.ts:397-398`: `Number(input.totalAmount)`, `if (amount <= 0)`. ✎ Register cites
  `:305-306` (stale). The float goods totals are at `:448-450` (`recordInvoice`) and `:515-517` (`setInvoiceLines`).
  `apps/erp/src/app/ap/actions.ts:173` passes the typed total raw. Migration 0155's finite CHECK is the only backstop,
  so `'abc'` surfaces as a raw 23514, not a sentence.
- **DEF-499. Confirmed.** `recordInvoice` writes `dueDate: input.dueDate ?? null` (`ap/index.ts:421`). T-266 §5
  (`docs/tasks/266-money-lines.md:254`) promised `invoiceDate + N`. Terms now have a writer (T-362, row 249).
  An explicit due date is not validated at all (it can precede the invoice date).
- **DEF-500. Confirmed.** `packages/db/schema/suppliers.ts:144` declares `creditTermsDays` with no check; the DB has
  `suppliers_credit_terms_days_check` (migration `0141:47-48`). No migration needed.
- **DEF-395. ✎ The census site is ALREADY FIXED.** `renameMoneyAccount` parses the limit with `parseMoneyInput` after
  `authorize` (`packages/domain/src/money-accounts/index.ts:233-245`) since `33dbd3f` (T-343 S5.5s, 2026-09-27). The
  action at `money-accounts/actions.ts:71` passes a string, and the domain now refuses `'abc'` in a sentence.
  The register row is broader: it lists 21 more unguarded sites (attendance config ×11, `acknowledgedAmount`,
  `totalCost`, `threshold` …). Those stay with **T-371 (DEF-382 sweep)**. T-367 adds only a guard test (S4).
- **DEF-508. Confirmed.** `createExpense` (`packages/domain/src/expenses/create.ts:140-147`) looks the invoice up by org
  and never compares `invoice.storeId` with `input.storeId`. The action's org-scoped pre-lookup is at
  `apps/erp/src/app/expenses/actions.ts:152-158` at HEAD (✎ census `:137-143`; T-364 will move it again). No DB trigger
  checks it (✎ "not ruled out" → ruled out: `0113:33-75` reads only status and capacity). The refusal order also leaks:
  `assertOpenForRecording` (`:147`) names B's invoice state and remaining capacity, and the supplier checks (`:160-183`)
  name B's supplier, both before any store comparison. T-364's E15 is `it.todo` at
  `apps/erp/tests/integration/t364-expense-form-authorise-first.test.ts:463`.
- **DEF-054. Ruled by Ian 2026-09-30; half of it is already built.**
  - ✎ The platform fee as a deduction on the customer receipt EXISTS: `recordCollection` posts `Dr 6400 fee` inside the
    collection (`ar/index.ts:335-395`, `POSTING-PATTERNS.md` `ar_collection.with-platform-fee`).
  - ✎ Neither method is offered by any v2 form since Ian's ruling 4 of 2026-09-11 (`packages/domain/src/shared/
    money-lines.ts:58-64`). They survive in `expense_payments_method_check` (`schema/expenses.ts:259`), in
    `routing.ts:41-69,234-240` (blocked), in `apps/erp/src/app/expenses/actions.ts:67`, and in the ETL, which
    quarantines both (`packages/etl/src/convert.ts:435-445`).
  - v1's auto fee expense (`ERP-rebuild/src/lib/actions/ar-collection.actions.ts:609-680`) is recognisable exactly:
    `supplierId 'SYSTEM'`, `category 'Platform Fee'`, one payment `method 'ar_collection'`, `sourceId = collectionId`.
  - v1's `other` carries `otherType ∈ {rebate, voucher, loyalty_points, gift_certificate, store_credit, other}`
    (`ERP-rebuild/src/lib/financial/expense/payments.ts:301-302`) and posts to `others__{otherType}`, an account with no
    balance behind it (`expense.builder.ts:8,85`).
  - ✎ **No landed data exists locally.** On 2026-09-30 the planner counted `etl_source_documents` in all ten local
    databases on 5435: `shareat_dev` 0, `shareat_test` 3, every other 0. The only prior count is the 2026-08-24 audit
    (`docs/reviews/v1-audit-2026-08-24.md:254`): 1 `unimplemented_payment_method` group out of 6,226 expense documents.
    That is a floor (other quarantine reasons fire first), not the population. S0 gets the real number.
  - ⛔ The accounts the split needs do not exist. The COA has no voucher ASSET account (`2145 Unredeemed vouchers`,
    `4910`, `4920` are customer-side, `packages/db/seed/chart-of-accounts.ts:204,310-313`) and no active suspense
    account (`2900` is void-cash only and `reserved`, `:247-250`). `POSTING-PATTERNS.md` has no row for a rebate arising,
    a voucher held, or a suspense landing. Per the brief these are questions for Ian (Q1–Q3), not inventions.
- **Glossary:** no term covers write-off, open item, due date, voucher or suspense (`grep -i` 2026-09-30). New names in
  this spec: `alreadyRecorded`, `lockInvoiceForRecording`, `platform_fee_carried_by_collection`.
- **DEF-521 (logged, not verified):** AR `voidCharge` (`ar/index.ts:150-180`) shows no check for collections already
  allocated to the charge; DEF-519's shape on the AR side. Out of scope here.

## Rulings (planner)
- **R1. A write-off retry returns the first write-off; it never writes twice, and it is recognised BEFORE the
  outstanding cap.** After the lock, `writeOffCharge` builds the key (byte-equal to today's
  `ar_write_off:${charge.id}:${amount.toFixed(2)}:${actor.personId}`, with `amount` the parsed value rendered to 2 dp)
  and looks it up (`journalRepo.findEntryByIdempotencyKey`). If an entry exists, it reads the `ar_write_offs` row by
  that `journal_entry_id` and returns it with `alreadyRecorded: true`, BEFORE `openItems`: otherwise a double-clicked
  ₱700 of ₱1,000 meets *"only ₱300.00 is outstanding"* instead of a retry (bible §4.2 rule 10). `postEntry`'s own
  `created: false` branch stays as the second layer (same read). It does not refuse: a double-click must be harmless (bible §4.2 rule 10), and the action tells
  the admin *"This write-off was already recorded"*. A deliberate same-amount tranche by the same admin collapses into
  the first; Q5 asks whether that is acceptable.
- **R2. The DB is the backstop for DEF-201**: `CREATE UNIQUE INDEX ar_write_offs_journal_entry_unique ON ar_write_offs
  (journal_entry_id)`. One entry, one subledger row. Bible §15.11: the domain guard and the index each hold the risk.
- **R3. Lock the charge before reading what is owed**, with the existing `arRepo.lockChargesForAllocation(trx, orgId,
  [chargeId])`, immediately after `authorize` (T-364's rule: a non-holder takes no lock). Then RE-READ the charge's
  status. Write-offs and collections on one charge now serialise on the same row lock.
- **R4. One lock order for a supplier invoice: invoice row first, then its expenses.**
  - `voidInvoice` takes `select … from supplier_invoices where org_id=… and id=… for update` right after `authorize`,
    then reads `liveExpensesForInvoice`.
  - `createExpense` and `approveExpense` take the same row `for no key update` via a new
    `apRepo.lockInvoiceForRecording` right after `authorize`, BEFORE `assertOpenForRecording` and before reading the
    expense's status (approve re-reads the expense after the lock). `FOR NO KEY UPDATE` serialises recordings and voids
    on one invoice but does not conflict with the `FOR KEY SHARE` every FK insert takes, so unrelated inserts are not
    blocked.
  - The trigger takes the same `FOR NO KEY UPDATE` when it reads the invoice, so every writer (ETL, recurring job,
    future code) is covered, not only the three domain functions. Under READ COMMITTED a waiter re-reads the committed
    row, so it sees `voided`.
- **R5. `openItems` excludes an expense whose invoice is voided** (`join supplier_invoices si … and si.status <>
  'voided'`). This is the second layer, not the fix. It is still the ONE definition of "open": the hand screen,
  `recordPayment`'s re-check and T-330's suggestion all read it, so they change together (the register's own condition).
- **R6. Default for DEF-519 (Q4): a paid expense cannot be voided, and the check is locked.** `voidExpense` takes the
  expense row `FOR UPDATE` right after `authorize`, via the existing `apRepo.lockExpensesForAllocation(tx, orgId,
  [expenseId])` (`repo/ap.ts:799-815`, the same row lock `recordPayment` takes at `ap/index.ts:883`), BEFORE
  `postedAllocatedFor`. A payment and a void on one expense therefore serialise, and whichever waits reads the other's
  committed result. `voidInvoice`'s cascade locks ALL its live expenses in one call, in id order (the function's own
  `order by id`, `:812`), after the invoice lock and before the first `voidExpense`, so two cascades or a cascade and a
  multi-expense payment cannot deadlock. `voidExpense` then refuses when the expense has any allocation on a `posted`
  AP payment: *"₱X has already been paid against this bill. Void that payment first, then void
  the bill."* Because `voidInvoice` cascades through `voidExpense`, the invoice void refuses too, and nothing is written.
  Reversible and it moves no money.
- **R7. Store mismatch is "not found" (Ian, T-364 Q1 (a): one uniform refusal).** `createExpense` checks
  `invoice.storeId === input.storeId` IMMEDIATELY after the lookup, before `assertOpenForRecording` and every supplier
  check, and throws exactly `gone(…, 'supplier invoice')`, the not-found sentence. The action's pre-lookup applies the
  same rule, and its not-found text becomes that SAME id-free sentence (`goneSentence('supplier invoice')`). ⛔ Today's
  action text, `Supplier invoice ${supplierInvoiceId} does not exist.` (`expenses/actions.ts:157` at HEAD), embeds the
  typed id, so E15's `error(a) === error(b)` could never pass with two different ids. T-364 S1 is editing that file
  now: the builder rebases on T-364's committed version and changes whichever not-found text it left. The trigger raises on `NEW.store_id <> inv.store_id` for any non-voided row.
- **R8. Money input is parsed once, at the domain boundary**, with `parseMoneyInput` (`packages/domain/src/shared/
  money-input.ts:33`). The goods total is `subtract(subtract(total, deliveryFee), otherFees)` from `@shareat/core/money`.
  No new `Number(` in any function this task edits.
- **R9. Due date:**
  - an explicit `dueDate` is parsed with `parseBusinessDate` and refused if earlier than `invoiceDate` (*"A due date
    can't be before the invoice date."*);
  - a blank `dueDate` with `supplier.creditTermsDays = N` becomes `addDays(invoiceDate, N)` (`packages/core/src/
    datetime.ts:64`); `N = 0` gives the invoice date;
  - a blank `dueDate` for a cash-on-delivery supplier (`null` terms) stays `null`. T-330's ordering already falls back to
    `invoice_date` (`ApOrderingKeys`, `repo/ap.ts:665-674`: "the fallback `allocateOldestFirst` resolves"), so nothing
    is guessed;
  - terms are read from the supplier at recording time and COPIED, same reasoning as `isOfficialReceipt` (`:427-436`):
    changing terms later never rewrites an existing bill's due date.
- **R10. DEF-054, the part that needs no new account:**
  - `ar_collection` is retired as an expense method: the domain refuses it at create, the action stops accepting it,
    and the CHECK is recreated without it, `NOT VALID` so any history survives.
  - The ETL SKIPS a v1 auto fee expense (all four markers in the Census) with reason
    `platform_fee_carried_by_collection:<collectionId>`, because the collection's own conversion already books the 6400
    leg (`leg-mapping.ts:450-456`), and booking it twice is the ₱198,148.29 v1 defect (`POSTING-PATTERNS.md:432-436`).
    Any other `ar_collection` doc stays QUARANTINED; it is never skipped on a partial match.
  - `other` is untouched until Q1–Q3 are answered (S6).

## Invariants (every slice)
- Bible §16.1 inv. 1: every entry balances with at least two lines. Inv. 5: corrections are reversals. Inv. 6 (row 98):
  the subledger (`party_id` on the control lines, and `ar_write_offs`/`openItems`) equals the control balance.
  Inv. 7: `postEntry`'s period guard applies.
- Bible §4.2 rule 10: a retry with the same idempotency key writes nothing new, in the ledger AND in every subledger
  table beside it.
- Bible §7 rule 1 and T-364's rule: `authorize` first; a lock is taken only after it; a non-holder waits on nothing.
- Bible §15.11: no layer is the only one for a risk. Domain refusal plus DB backstop for DEF-201, DEF-396, DEF-508.
- Bible row 170: voiding a supplier invoice voids its expenses; the obligation dies with the document.
- `POSTING-PATTERNS.md` is looked up, never extended by a builder. **This task creates no new posting and changes no
  posted line.** ⚠️ Two postings it touches are NOT in `POSTING-PATTERNS.md` at all: the AR write-off (Dr 6860 bad debt
  / Cr 1210 {customer}, `ar/index.ts:537-554`) and the expense void (a full reversal of the expense entry via
  `reverseEntry`, `expenses/void.ts:59-63`). Both are pre-existing code whose lines stay byte-identical here (a test
  asserts the W1 entry's two lines). The missing pattern rows are Q7 for Ian, not something a builder writes.
- Bible §6 and RULES rule 6: money through `@shareat/core/money`; no new bare `Number()`.
- Bible §13 row 214: every docstring a slice falsifies is rewritten in that slice (`writeOffCharge`'s key comment,
  `openItems`' header, `voidInvoice`'s T-196 block, `routing.ts:30-38,66-69`, `convert.ts:437-441`,
  `money-lines.ts:58-62`).
- CAPABILITY-MATRIX: each ✅ used (`write_off_receivable`, `create_expense`, `approve_expense`, `void_expense`,
  `void_supplier_invoice`, `record_supplier_invoice`) has a test proving the ✗ fires and the refusal writes nothing.

---

## S0: count before building (DEF-054) — read-only, no code
**Who:** the orchestrator or the S5 tester. **Writes:** nothing in the repo; the numbers go in this spec as
Amendment A1.
1. **Production v2 first**, read-only (`begin transaction read only; … rollback;`), via the owner connection (the ETL
   tables are deny-all to `shareat_app`, DEF-289):
   `select count(*) from etl_source_documents where collection_path like '%expenses';`
2. If that is 0, land a fresh copy into a SCRATCH local database, never a shared one:
   - create `shareat_scratch_t367` on 5435 and migrate it FIRST with `DATABASE_URL` set in the environment to
     `…/shareat_scratch_t367` (dotenv does not override a variable already set; without it, `.env.local` points every
     command at the shared `shareat_dev`), per ADR-012 §5.8;
   - with the same `DATABASE_URL`, run capture once PER STORE (it takes `--store <id>`, HANDOFF.md:337):
     `npm run capture -- --store <id> --collection expenses --fetch`, and again with `--collection arCollections`,
     for each of the four operating stores (the ids are in `docs/reviews/v1-audit-2026-08-24.md` §1; skip the excluded
     test stores);
   - ⚠️ `capture --fetch` reads LIVE production Firestore with the read-only service account and writes nothing there.
     The orchestrator confirms Ian is content before running it, since it copies production PII onto this machine.
     Drop the scratch DB afterwards.
3. Run, against the current version of each document:
```sql
with cur as (select distinct on (doc_path) doc_path, collection_path, payload
             from etl_source_documents where collection_path like '%expenses'
             order by doc_path, captured_at desc),
p as (select c.doc_path, c.payload, jsonb_array_elements(c.payload->'payments') pay
      from cur c where jsonb_typeof(c.payload->'payments') = 'array')
select pay->>'method' method, coalesce(pay->>'otherType','-') other_type,
       (payload->>'supplierId' = 'SYSTEM' and payload->>'category' = 'Platform Fee') is_system_fee,
       payload->>'status' status, count(*) legs, count(distinct doc_path) docs,
       sum(case when pay->>'amount' ~ '^-?[0-9]+(\.[0-9]+)?$' then (pay->>'amount')::numeric end) amount,
       count(*) filter (where pay->>'amount' !~ '^-?[0-9]+(\.[0-9]+)?$' or pay->>'amount' is null) unparseable_amounts
from p where pay->>'method' in ('other','ar_collection') group by 1,2,3,4 order by 1,2,3,4;
```
   Docs whose `payments` is not an array are counted separately (`jsonb_typeof(...) <> 'array'`) and reported.
   and the fee cross-check: every SYSTEM Platform Fee doc's `sourceId` must be a landed `arCollections` doc whose
   `platformFee` equals the fee doc's `totalAmount`. Report matched / unmatched / collection-missing counts.
4. **Gate:** S5 proceeds if every `ar_collection` leg is a system fee doc with a matching collection. Unmatched docs are
   listed and stay quarantined. The `other` rows, grouped by `otherType`, go to Ian with Q1–Q3.
- ⚠️ Planner's assessment, said once (RULES §4): the 2026-08-24 floor was ONE quarantined group in 6,226 expenses, and
  no v2 form has offered `other` since 2026-09-11. If S0 confirms a handful of `other` rows, the recommendation is to land
  them in suspense as ruled and NOT build a new voucher-asset method until someone needs one. Ian ruled "yes";
  this is only the utilisation number he should see before S6 is built.

---

## S1: DEF-201 (+DEF-517, DEF-520) — one write-off, one row; never more than is owed
**BUILDER** (source):
- `packages/db/migrations/<N>_t367_def201_write_off_once.sql` (new) and `packages/db/migrations/meta/_journal.json`.
- `packages/db/schema/ar.ts`: `uniqueIndex('ar_write_offs_journal_entry_unique').on(t.journalEntryId)`.
- `packages/db/src/repo/ar.ts`: `getWriteOffByEntryId(tx, orgId, journalEntryId)`.
- `packages/domain/src/ar/index.ts`: `writeOffCharge` only: R1, R3, R8, and the rewritten key comment.
- `apps/erp/src/app/customers/actions.ts`: `writeOffChargeAction` shows *"This write-off was already recorded — nothing
  new was posted."* when `alreadyRecorded`.

**TESTER:**
- `packages/domain/tests/integration/t367-s1-write-off-once.test.ts` (new).
- `packages/db/tests/integration/t367-s1-migration.test.ts` (new).

**Migration** (header names T-367 / DEF-201 / this section): the unique index only. No new table: classification and
RLS registries unchanged. Prove it on a scratch DB (ADR-012 §5.8). ⛔ Precheck P1 must be 0 rows before it can apply.

**Contract.** `writeOffCharge(tx, actor, { chargeId, amount, reason })` → `{ writeOffId, entryId, alreadyRecorded }`:
read charge → `authorize(write_off_receivable, {storeId})` → `lockChargesForAllocation([chargeId])` → re-read charge →
author check → `status === 'posted'` → reason → `parseMoneyInput(amount)` → `compare(amount, ZERO) > 0` → **key lookup
(R1): existing → return `{…, alreadyRecorded: true}`** → `openItems` cap via `compare` → `postEntry` (lines and key
unchanged) → `created ? insertWriteOff : getWriteOffByEntryId`. The status re-read happens before the key lookup; a
retry on a charge that has since been voided is refused as not posted (nothing new to return is safer than a stale ok).

**Tests.** Two-connection harness exactly as T-366 S1 (`docs/tasks/366-remittance-floats.md` §S1 "Harness"): A runs the
call inside `asOrg(…, async tx => { await op(tx); await gate; })`; B starts; a third connection polls
`pg_stat_activity` until B's backend shows `wait_event_type = 'Lock'` and `wait_event in ('transactionid','tuple')`
(≤ 5 s) or B settles; then A is released. B settling before it was seen waiting fails the test: *"B never waited: no
lock"*. Fixture: a ₱1,000.00 posted charge dated 2027-02-03, recorded by admin X; write-offs by admins Y and Z.
- **W1: same write-off twice, concurrently (the double-click).** A and B both: Y writes off 400.00.
  - B resolves (does not throw) with `alreadyRecorded: true` and A's `writeOffId` and `entryId`.
  - `ar_write_offs` rows for the charge: **1**, total **400.00**. `ar_write_off` entries: **1**.
  - `1210 {customer}` balance **600.00** and `openItems` outstanding **600.00** (inv. 6).
  - Mutants: guard removed and index absent → rows 2, subledger 200.00 ≠ control 600.00, red (this is HEAD's measured
    shape from the register); guard removed and index present → B throws 23505, red on "B resolves".
- **W1b: the double-click that exceeds half (R1 order).** A and B both: Y writes off **700.00**, concurrently.
  - B waits, then resolves with `alreadyRecorded: true` (NOT *"only ₱300.00 is outstanding"*); rows 1, entries 1,
    1210 = 300.00 = outstanding.
  - Mutant: key lookup moved after the cap → B refused with the cap sentence; red. The sequential form (700 then 700)
    asserts the same.
- **W2: two different write-offs, concurrently (DEF-517).** A: Y writes off 700.00; B: Z writes off 600.00.
  - Exactly one fulfils; the other is refused with *"only ₱300.00 is outstanding"* (or ₱400.00) and writes nothing.
  - `1210 {customer}` is **300.00** or **400.00**, never −300.00; rows == entries.
  - Mutant: lock removed → both fulfil, 1210 = −300.00, red. At HEAD B never waits → red.
- **W3: sequential retry.** Y writes off 400.00, then repeats → second returns `alreadyRecorded`, rows 1.
- **Positive controls.**
  - Y writes off 300.00, then 200.00 (a real second tranche): 2 rows, 2 entries, 1210 = 500.00, outstanding 500.00.
  - Two DIFFERENT charges written off concurrently: both fulfil and B is **never** seen waiting (lock is per charge).
  - `recordCollection` on the charge while A holds a write-off: it waits, then allocates only what is left.
- **W4: refusals write nothing**, each paired with its success control: staff (✗ `write_off_receivable`) refused
  without waiting while A holds the lock (it settles while A is still gated); the charge's author X refused, Y succeeds;
  `'abc'` refused with `parseMoneyInput`'s sentence and no 23514 (mutant: `Number()` back → a DB error, red); `'0'` and
  `'-5'` refused; 1,000.01 refused, 1,000.00 succeeds.
- **Migration test:** a second `ar_write_offs` row with an existing `journal_entry_id` is refused with 23505; a row with
  a new entry id is accepted.

**Smoke** (`http://localhost:9008`, DB `shareat_test_setup`; its periods Jan 2026–Jan 2027 are CLOSED, so dates are
2027-02): on `/customers/<id>` a charge dated 2027-02-03, write off ₱400 as a second admin, then submit the same form
again (browser back + resubmit). Screenshot the "already recorded" notice and the write-off list showing ONE row.

---

## S2: DEF-396 + DEF-508 (+DEF-518, DEF-519) — the supplier-invoice gate
**BUILDER** (source):
- `packages/db/migrations/<N+1>_t367_def396_def508_invoice_gate.sql` (new) and `meta/_journal.json`.
- `packages/db/src/repo/ap.ts`: `lockInvoiceForUpdate`, `lockInvoiceForRecording`, `postedAllocatedFor(expenseId)`,
  and the `openItems` join (R5) with its header rewritten.
- `packages/domain/src/ap/index.ts`: `voidInvoice` lock-first (R4); its docblock.
- `packages/domain/src/expenses/create.ts`: R7 store check, then the R4 lock, then the existing checks.
- `packages/domain/src/expenses/approve.ts`: R4 lock after `authorize` (`:55`), re-read the expense, then `:77`.
- `packages/domain/src/expenses/void.ts`: R6 guard after `authorize`, before `reverseEntry`.
- `apps/erp/src/app/expenses/actions.ts` (rebased on T-364's committed version): the pre-lookup treats
  `invoice.storeId !== storeId` as not found, with the id-free sentence (R7).
- `packages/db/src/triggers/registry.ts`: the `expenses_require_verified_invoice` entry (`:361-366`) keeps `mode:
  'origin'`, `kind: 'validator'`; its `reason` adds *"also locks the invoice row FOR NO KEY UPDATE (serialises
  recording and voiding) and refuses an expense at a different store from its invoice (T-367, migration <N+1>)"*.
- ⚠️ T-365 edits `repo/ap.ts:95-152` and `ap/index.ts`; rebase on its committed version before editing either.
- `packages/db/schema/expenses.ts`: a `// NOTE: store match and row lock hand-added in migration <N+1>` beside the
  trigger comment.

**TESTER:**
- `packages/domain/tests/integration/t367-s2-invoice-gate.test.ts` (new).
- `packages/db/tests/integration/t367-s2-migration.test.ts` (new).
- `apps/erp/tests/integration/t364-expense-form-authorise-first.test.ts`: E15 only, `it.todo` → `it`, citing T-367.

**Migration** (`CREATE OR REPLACE FUNCTION expenses_check_invoice_open_for_recording()`, same signature, so the existing
trigger picks it up, as 0113 did): keep 0113's body; the invoice read becomes `SELECT status, total_amount, store_id …
FOR NO KEY UPDATE`; add `IF NEW.store_id <> inv_store THEN RAISE EXCEPTION 'expense % is at a different store from
supplier invoice %'` after the not-found check. The early `RETURN NEW` for `voided` stays first (a void never locks or is
blocked). ⛔ Prechecks P2–P4 first.

**Contract.**
- `voidInvoice`: read → authorize → `lockInvoiceForUpdate` → re-read status (refuse if already voided) → reason →
  `liveExpensesForInvoice` → `lockExpensesForAllocation(all live ids)` (id order) → cascade (R6 may refuse inside it)
  → `markInvoiceVoided`.
- `createExpense`: authorize → … → invoice lookup → `if (!invoice || invoice.storeId !== input.storeId) throw gone(…)`
  → `lockInvoiceForRecording` → `assertOpenForRecording` → supplier checks → insert.
- `approveExpense`: read expense → authorize → `lockInvoiceForRecording(expense.supplierInvoiceId)` → re-read expense →
  the existing status branches unchanged: `posted` returns `{ journalEntryId, created: false }` (`approve.ts:57-62`, a
  concurrent double-approve is a retry, not a refusal), `voided` refuses, `draft` proceeds.
- `voidExpense`: read → authorize → `lockExpensesForAllocation([id])` → re-read → R6 check → existing flow.
- `openItems`: unchanged signature and columns.

**Tests** (two-connection harness as S1; waiting = `Lock` / `transactionid|tuple`). Fixture: store A and B, supplier S
with terms 30, a verified ₱1,000.00 invoice I at A dated 2027-02-03, manager M_A at A.
- **V1: void first, record second (DEF-396 race).** A: `voidInvoice(I)` held. B: `recordExpenseForInvoice(I, ₱400 credit)`.
  - B waits, then is refused with *"…has been voided, so nothing more can be recorded against it."*
  - No expense on I is `posted`; `openItems(S, A)` is empty; `2110 {S}` is **0.00**.
  - Mutant: the trigger's `FOR NO KEY UPDATE` AND `voidInvoice`'s lock both removed (HEAD) → B never waits and posts;
    red. (With the trigger lock alone, B still waits on the void's own `UPDATE`; V2 is the leg that needs R4's
    lock-first.)
- **V2: record first, void second.** A: `recordExpenseForInvoice(I, ₱400)` held. B: `voidInvoice(I)`.
  - B waits, then voids the invoice AND the new expense (a reversal entry exists); `openItems` empty; `2110 {S}` 0.00.
  - Mutant: `voidInvoice`'s lock-first removed → B reads no live expense, its `markInvoiceVoided` waits for A, then
    voids I; A's posted expense stands on a voided invoice and `openItems` offers it. Red. (DEF-396's population,
    produced end to end.)
- **V3: openItems' second layer (R5).** As the owner connection, write a posted ₱400 credit expense on I, then set I
  `voided` by raw SQL (simulates legacy or ETL data; the trigger is on `expenses`, so an invoice update never fires it).
  - `openItems(S, A)` does not include it; `recordPayment` allocating ₱400 to it is refused as not open, nothing written.
  - Positive control: the same expense with I `verified` IS listed, and the same payment posts Dr 2110 400 / Cr cash 400.
  - Mutant: join removed → listed, payment posts; red.
- **V4: capacity race.** A records ₱700 and B records ₱600 against I concurrently → exactly one succeeds, the other gets
  the capacity sentence (*"…has only ₱300.00 left of ₱1,000.00; ₱600.00 doesn't fit."*); recorded ≤ 1,000.00.
  Mutant: no lock → recorded 1,300.00; red. Positive control: two different invoices → both succeed, B never waits.
- **V5: paid bill (DEF-519, R6).** Record ₱400 on credit against I, pay it in full (`recordPayment`).
  - `voidInvoice(I)` refused: *"₱400.00 has already been paid against this bill. Void that payment first, then void the
    bill."* I stays `verified`, the expense `posted`, `2110 {S}` **0.00**, no reversal entry.
  - `voidExpense` on the expense directly: same refusal.
  - Positive control: `voidPayment`, then `voidInvoice` succeeds; `2110 {S}` **0.00**, `1110` back to its opening.
  - Mutant: guard removed → `2110 {S}` = **−400.00** (a debit on a liability control); red.
- **V6: payment vs void, concurrently (DEF-519's race).** A posted ₱400 credit expense on I, unpaid. A: `recordPayment`
  allocating ₱400 to it, held after `lockExpensesForAllocation`. B: `voidExpense` on it (and, second case,
  `voidInvoice(I)`).
  - B is seen WAITING (`Lock` / `transactionid|tuple`), then after A commits is refused with R6's sentence; the expense
    stays `posted`, `2110 {S}` **0.00**, exactly one AP payment and no reversal entry.
  - Reverse order: B (void) held, A (payment) waits, then is refused as not an open item; nothing written.
  - Mutant: `voidExpense`'s lock removed → B never waits, voids, A's payment commits against a voided expense,
    `2110 {S}` = −400.00; red.
- **V7: double approve, concurrently.** A draft ₱400 expense on I. A and B both `approveExpense` it.
  - B waits on the invoice lock, re-reads, finds `posted`, and returns `created: false` with A's `journalEntryId`
    (today's idempotent branch, `approve.ts:57-62`), NOT a refusal. Exactly one `expense` journal entry.
  - Mutant: re-read removed → B posts a second entry or throws; red.
- **X1: cross-store (DEF-508).** M_A calls `createExpense(storeId A, supplierInvoiceId = B's invoice J)`:
  - refused with `gone('supplier invoice')`'s sentence (id-free), byte-equal to the refusal for a random uuid;
  - the message contains neither S's name, J's invoice number, nor any ₱ figure; nothing is written;
  - J at B is verified-and-full AND J voided: both still give the same not-found sentence (the store check runs first);
  - the same through `recordExpenseForInvoice`;
  - positive control: M_A with I (store A) succeeds.
  - Mutant: store check moved after `assertOpenForRecording` → J-full leaks *"only ₱…"*; red.
- **X2: trigger backstop.** As the owner, inserting a `draft` expense at A on J raises the store message; the same at B
  succeeds.
- **E15** (T-364's file, `:463` is a bare `it.todo`): the tester writes the body from T-364's E15 row
  (`docs/tasks/364-def-496-497-authorise-first.md:196`): otherManager, create at own store A, supplier blank, (a) store
  B's real invoice id vs (b) a random uuid. Assert `error(a) === error(b)` byte for byte (both the id-free not-found
  sentence), neither names B's supplier or invoice, and no expense row exists. Mutant: the action's old id-bearing
  sentence → texts differ; red.
- **Refusals** paired with controls: staff (✗ `void_supplier_invoice`) refused without waiting on a held lock;
  a second `voidInvoice` after the first refused as already voided.

**Smoke** (2027-02 dates): on `/ap`, record a bill against a terms supplier, record ₱400 credit on it, pay it, try to void
the invoice → screenshot the refusal; void the payment, void the invoice → screenshot success. On `/expenses/new` at
store A, confirm the invoice picker lists only A's invoices; the crafted cross-store id relies on X1 and E15 (say so).

---

## S3: DEF-420 + DEF-499 + DEF-500 — the invoice total, the due date, the terms CHECK
**BUILDER** (source):
- `packages/domain/src/ap/index.ts`: `recordInvoice` (R8, R9) and `setInvoiceLines`' goods total (R8).
- `packages/db/schema/suppliers.ts`: `check('suppliers_credit_terms_days_check', sql\`${t.creditTermsDays} is null or
  (${t.creditTermsDays} >= 0 and ${t.creditTermsDays} <= 365)\`)`, name byte-equal to migration 0141.
- `apps/erp/src/app/ap/page.tsx`: under the due-date box, *"Leave blank to use the supplier's terms."* No client
  computation (the domain is the authority).

**TESTER:** `packages/domain/tests/integration/t367-s3-invoice-total-due-date.test.ts` (new);
`packages/db/tests/unit/t367-s3-supplier-terms-check.test.ts` (new).

**Contract.** `recordInvoice` after the supplier checks: `total = parseMoneyInput(totalAmount, …, 'The invoice
total')`, refuse unless `> 0`; fees parsed the same way (blank = 0); `goods = total − delivery − other`, refused if
negative (*"The delivery and other fees can't be more than the invoice total."*); due date per R9; the insert writes the
PARSED values (`toFixed`-free strings from `Money`).

**Tests.**
- **T1 (DEF-420):** total `'abc'`, `'NaN'`, `''` → `RefusalError` with the parser's human sentence, no row, no 23514.
  Mutant: `Number()` back → 23514 from the DB, red. `'0'` and `'-1'` → *"An invoice total has to be greater than zero."*
  Control: `'1000.00'` saves 1,000.00.
- **T2:** total 1,000.00, delivery 100.00, lines summing 900.00 → accepted; lines summing 900.01 → refused. Delivery
  1,200.00 → the fees sentence. `setInvoiceLines` on the saved invoice with 900.00 accepted, 899.99 refused.
- **T3 (DEF-499):** terms 30, invoice 2027-02-03, blank due → `due_date` **2027-03-05**. Terms 0 → **2027-02-03**.
  COD supplier → **null**. Explicit 2027-02-10 → kept. Explicit 2027-02-01 → refused, no row. Mutant: `?? null` back →
  null for the terms-30 case, red.
- **T4 (copy, not read-through):** after T3, change S's terms to 60; the saved invoice still reads 2027-03-05.
- **T5 (DEF-500):** unit: `getTableConfig(suppliers).checks` contains `suppliers_credit_terms_days_check`. Integration
  (in T3's file): `pg_get_constraintdef` of the live constraint matches the Drizzle SQL's bounds; 366 is refused, 365
  accepted.
- **Refusal:** staff (✗ `record_supplier_invoice`) refused before any parse (T-364 rule); the manager control succeeds.

**Smoke:** record a bill on 2027-02-03 for a supplier with 30-day terms, due date blank → the list shows due 2027-03-05;
type `abc` as the total → the plain sentence. Screenshots.

---

## S4: DEF-395 — pin the fix already in place (no source change)
**BUILDER:** none. **TESTER:** `packages/domain/tests/integration/t367-s4-overdraft-limit.test.ts` (new) — unless
`grep -rn overdraftLimit packages/domain/tests apps/erp/tests` already finds the three legs below, in which case cite
the existing test in the report and add nothing.
- `renameMoneyAccount({ overdraftLimit: 'abc' })` → the parser's refusal; `overdraft_limit` unchanged; no 23514.
- `'-5'` → refused; `'0'` → stored **0.00**; `'2500'` → **2,500.00**; blank → unchanged.
- Staff (✗ `manage_chart_of_accounts`) refused before parsing.
- Mutant: replace `parseMoneyInput` with the raw string → 23514, red.
The register row is corrected at wrap-up: the `overdraftLimit` leg is fixed at `33dbd3f`; the other 21 sites move to
T-371.

---

## S5: DEF-054, part 1 — retire `ar_collection`; the ETL skips v1's duplicate fee (after S0)
**BUILDER** (source):
- `packages/db/migrations/<N+2>_t367_def054_retire_ar_collection_method.sql` (new) and `meta/_journal.json`:
  `ALTER TABLE expense_payments DROP CONSTRAINT expense_payments_method_check;` then `ADD CONSTRAINT … CHECK (method in
  ('cash','online','credit','other','reimbursable')) NOT VALID;`.
- `packages/db/schema/expenses.ts`: the enum and check without `ar_collection`, with `// NOTE: NOT VALID, hand-added in
  migration <N+2>` beside it.
- `packages/domain/src/expenses/routing.ts`: `ExpensePaymentMethod` loses `ar_collection`; `UNMAPPED_PAYMENT_METHODS`
  is `{'other'}`; the header comment says why.
- `packages/domain/src/expenses/create.ts`: refuse any line whose method is not in `EXPENSE_PAYMENT_METHODS` before any
  write (*"That payment method is no longer used. A platform fee is recorded on the customer's collection."* for
  `ar_collection`).
- `apps/erp/src/app/expenses/actions.ts:67`: `PAYMENT_METHODS` loses `ar_collection`.
- `packages/etl/src/convert.ts`: the R10 skip, keyed on all four markers; `packages/etl/src/convert.ts`'s own
  `ExpensePaymentMethod` KEEPS `ar_collection` (it reads v1).
- `packages/domain/src/shared/money-lines.ts:58-62`: comment only.
- `apps/erp/src/app/expenses/[id]/page.tsx:25-32`: the `ar_collection` label stays (history display). Checked: `METHOD_LABEL` is `Record<string, string>`, so it still typechecks once `ar_collection` leaves the union; the builder confirms with typecheck.

**TESTER:** `packages/etl/tests/unit/t367-s5-platform-fee-skip.test.ts` (new);
`packages/domain/tests/integration/t367-s5-ar-collection-retired.test.ts` (new);
`packages/db/tests/integration/t367-s5-migration.test.ts` (new).

**Tests.**
- **F1:** a v1 fee doc (₱250.00, `SYSTEM`, `Platform Fee`, one `ar_collection` payment, `sourceId` C1) → `skipped`,
  zero entries, reason `platform_fee_carried_by_collection:C1`. Converting C1 (₱5,000 gross, fee 250) gives Dr cash
  4,750 / Dr 6400 250 / Cr 1210 5,000. Across both conversions there is exactly **one** 6400 leg of **250.00**
  (`POSTING-PATTERNS.md:421-436`). HEAD: `quarantined` → red. Mutant: convert the fee doc to Dr 6400 → two legs, red.
- **F2 (controls: the skip is exact, never partial):** `ar_collection` with supplier ≠ `SYSTEM` → quarantined
  `unimplemented_payment_method`; `SYSTEM`/`Platform Fee` with no `sourceId` → quarantined; `SYSTEM`/`Platform Fee`
  paid `cash` → converted as an ordinary expense; a doc mixing `ar_collection` and `cash` → quarantined.
- **F3:** `createExpense` with an `ar_collection` line → refused with the sentence, nothing written; the same with `cash`
  succeeds. An `other` line keeps today's behaviour (blocked by routing at approval).
- **F4 (migration):** a new `ar_collection` payment row → 23514; a pre-existing one survives the migration (NOT VALID);
  `other` still accepted.

**Smoke:** none of its own (no v2 form offers either method). The report says so and relies on F1–F4.

---

## S6: DEF-054, part 2 — `other` split and v1 `other` to suspense. ⛔ BLOCKED on Q1–Q3
Nothing is built until Ian answers. Once he does, the planner amends this slice. The likely shape, stated so the
questions have something concrete to answer:
- **Supplier credit / rebate "reduces AP"** already exists as `supplier.credit-applied` (Dr 2110 / Cr 1240, spent
  inside `ap_payment`, `POSTING-PATTERNS.md:513-527`). The planner recommends NO new expense method: a rebate-funded bill
  is recorded on Credit (AP) and settled with the supplier's credit. A second path that spends 1240 would need its own
  lock and would drift from the first. What is missing is how a rebate ARISES (Q1).
- **Voucher / points / gift certificate** needs a new party-carrying asset account and an arising posting (Q2), then a
  `voucher` method that credits it, guarded by its balance under a lock, the same shape as `checkDraw`.
- **v1 `other` history** lands in a suspense account with a finding per row (Ian's ruling); Q3 asks only which account.

---

## Production prechecks (read-only; `begin transaction read only; … rollback;` against `erp2`, 159.223.46.224)
Run before the slice that needs them; paste the output in the report. Never a build or a write on either droplet.
- **P1 (S1, blocks its migration):** `select journal_entry_id, count(*) from ar_write_offs group by 1 having count(*) > 1;`
  → must be 0 rows. Any row is a live DEF-201 duplicate; stop and ask Ian (Q6).
- **P2 (S2):** `select e.id, e.status, e.store_id, si.store_id from expenses e join supplier_invoices si on
  si.id = e.supplier_invoice_id where e.store_id <> si.store_id and e.status <> 'voided';` → expected 0. A row would be
  refused by the new trigger at its next edit or approval (Q6).
- **P3 (S2):** `select e.id, e.status from expenses e join supplier_invoices si on si.id = e.supplier_invoice_id where
  si.status = 'voided' and e.status <> 'voided';` → live DEF-396 instances; R5 hides them from payment (Q6).
- **P4 (S2):** `select apa.expense_id, apa.amount_applied from ap_payment_allocations apa join ap_payments p on
  p.id = apa.ap_payment_id join expenses e on e.id = apa.expense_id where p.status = 'posted' and e.status = 'voided';`
  → live DEF-519 damage (a 2110 debit per supplier); report the supplier totals.
- **P5 (S5):** `select method, count(*) from expense_payments where method in ('other','ar_collection') group by 1;`
  (informational; the CHECK is NOT VALID either way).

## Out of scope
- DEF-395's other 21 sites and every other NaN site (T-371). DEF-494's date parser (T-370).
- AR `voidCharge` with collections allocated (reported above; its own DEF).
- Backfilling due dates on existing invoices (T-330 already falls back to `invoice_date`).
- A per-submission form token for write-offs (Q5 option (b)).
- Any new account or posting (S6, after Ian).
- Bible amendments. At approval the orchestrator adds a §13 row recording R1, R4, R6, R7 and R10.

## Done when
- S1–S5 are green; S6 is amended after Ian's answers or left blocked in the handoff.
- Each red leg was shown red against HEAD, or against its named mutant, before the build; mutant results recorded.
- P1–P5 were run and pasted; migrations `<N>`, `<N+1>`, `<N+2>` apply from zero and on a scratch DB.
- Typecheck clean; the unit suite passes (including `toc-freshness`); the FULL integration suite passes before push.
- The S1, S2 and S3 smoke ran on 9008 with 2027-02 dates, with screenshots.
- `npm run build` passes with the dev server stopped.
- Register at wrap-up: DEF-201, DEF-396, DEF-420, DEF-499, DEF-500, DEF-508 fixed with hashes; DEF-395's overdraft leg
  fixed at `33dbd3f`, rest → T-371; DEF-054 split (part 1 fixed, part 2 open on Q1–Q3); DEF-517, 518, 519 and 520
  fixed with hashes; DEF-396's stale "ask Ian" remedy corrected to row 170. T-364's E15 green.

## Questions only Ian can answer
- **Q1 (blocks S6): when a supplier gives us a rebate or promo credit (not a return, not an overpayment), what does it
  count as?** v2 can already hold a supplier's credit (account 1240) and spend it against their bills, which is how
  "reduces AP" works. What has no rule yet is the day the rebate is granted. Options: (a) it lowers the cost of what we
  bought from them; (b) it is other income. Planner's lean: (a) for a volume rebate on goods.
- **Q2 (blocks S6): vouchers, points and gift certificates the BUSINESS holds need a new asset account.** Approve an
  account such as "Vouchers and gift certificates held", tracked per issuer? And when we receive one free (a promo), is
  that other income, or a reduction of what we paid that issuer?
- **Q3 (blocks S6): which suspense account do v1's old `other` payments land in?** You ruled they land in suspense,
  flagged. There is no active suspense account today (2900 is reserved for void cash). Approve a new one, for example
  "Suspense — unclassified v1 payments", and say who clears it.
- **Q7 (no slice blocked): two everyday postings have no written pattern yet** — writing off a customer's bad debt
  (Dr 6860 / Cr 1210) and voiding an expense (a full reversal). The code already does both, and this task does not change
  either. Should the planner add them to the posting patterns for your sign-off?
- **Q4 (default ships in S2): can a supplier bill that has already been paid be voided?** Default: no — void the payment
  first, then the bill. The alternative is that voiding a paid bill turns the paid amount into a credit with that
  supplier, which needs a posting that is not in our patterns yet.
- **Q5 (default ships in S1): the same admin writing off the same amount on the same charge twice is treated as one
  write-off (a double-click).** Default: yes, and the screen says it was already recorded; a real second write-off of
  the same size is entered by another admin or as a different amount. Alternative (b): a hidden per-form token so every
  deliberate submission counts.
- **Q6 (only if P1–P4 find rows): what to do with live bad data** — duplicate write-off rows, expenses at a different
  store from their invoice, posted expenses on voided invoices, or voided bills that were paid. The planner will bring
  the actual rows; nothing is changed without your say.

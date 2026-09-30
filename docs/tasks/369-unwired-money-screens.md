# T-369: Unwired money screens — DEF-198, DEF-314, DEF-302, DEF-479, DEF-291

**Status:** **Not started — Q1–Q4 answered 2026-09-30 (row 260; Q1 re-entry manager-only)** — APPROVED 2026-09-30 (orchestrator, after independent Opus review; Q1–Q4 defaults ship). Review changes
1–7 and both minors applied (marked ✎R). Written 2026-09-30 by the Opus planner at HEAD `594f600`. Batch D of
the money-defect push (Ian, 2026-09-30: *"close all open money defects in v2"*), `docs/plans/money-defects-2026-09-30.md`.
DEF-302 is included under Ian's ruling **(a)** of 2026-09-30.
**Model:** Sonnet for each slice, tester first, then builder. Any spec amendment is written in plan mode (Opus).
**Migration:** none by default. S7 needs one only if Ian answers Q1 (a): **next free index at build** (0172–0174 are
taken by T-366/T-367/T-368).
**Line numbers** were checked at `594f600`. Dirty at that HEAD and NOT touched here: `ap/actions.ts`, `ap/index.ts`
(T-365), `expenses/actions.ts`, `attendance/adjustments.ts` (T-364).

## Goal
Every money capability that the domain already has, and that Ian ratified, can be used from a screen, and every
screen refuses in words a person can act on:
- a manager pays a staff member back for what they spent out of pocket;
- anyone who may see a record can open the photo attached to it;
- an unverified sales day that was entered wrong can be corrected or withdrawn;
- an admin can post one late entry into a closed month, recorded against their name;
- receiving, producing or returning stock in a closed month is refused with a plain sentence about the closed
  month, not a stock error;
- a money-account list offers what the person can actually use.

## v1 as requirements (§1.2d: the goal first, then v2 beats it)
| Screen | v1 at source | v1's GOAL | v2 bar |
|---|---|---|---|
| Reimbursement payout | `src/app/accounting/reimbursement/page.tsx` (lists staff by owed balance, pay dialog defaulting to the full balance); `src/lib/actions/reimbursement.actions.ts:51` (manager+, store access, day-lock, 2 legs) and `:152` (void) | Clear what the store owes a person, from the store's own money, by a manager | Same list and dialog. Balance derived from the ledger per store; overpayment and cross-store draws refused; concurrent payouts serialised |
| Receipt photo | v1 stores permanent `getDownloadURL()` links and renders them (`financial/receipts/[id]`, `inventory/deliveries/[id]`) | Whoever checks a record can look at its evidence | A short-lived signed URL minted per click, gated by the same capability that governs the record; nothing stored or logged |
| Sales-day draft | `src/lib/actions/sales-report-draft.actions.ts:94` (save = edit a draft); `sales-day.actions.ts:167` (void any status, manager+; only posted days reverse; the doc is archived, freeing the date) | A wrong report can be fixed before it counts, or withdrawn | Edit with create's validation; void of an unverified day posts nothing; segregation kept |
| Closed-period override | `src/lib/financial/lockedDay.guard.server.ts` — admin silently bypasses every day lock | An admin can still record a genuinely late document | Explicit, per entry, typed reason, audit row, admin-only; never for stock (Ian (a)) |
| Money-account picker | `cashier-guard.ts:84` `isPaymentAccountSelectableByRole` — staff see cashier accounts only; v1 posts on save (`expense.actions.ts:286`), so the list was v1's only control | A person is offered only money they may use | Store-scoped, capability-aware; the approval gate stays the control (v2 has a draft→approve step v1 lacked) |

## Census, verified at source (corrections marked ✎)
- **DEF-198.** `payReimbursement` (`packages/domain/src/expenses/reimbursement.ts:36`) and `readFileUrl`
  (`packages/domain/src/files/index.ts:195`) have zero callers under `apps/`. Confirmed. Both are rows in
  `tests/unit/domain-actions-have-callers.test.ts:123-128` and in `docs/production-caller-baseline.txt:62,75`.
  ✎ Three new defects in `payReimbursement` (the orchestrator files them):
  - **N1.** It credits any money account in the org without the cross-store gate. `:50-51` loads the account;
    `:94-99` credits it at `input.storeId`. The siblings gate this: `approve.ts:127-128` and `ap/index.ts:974-976`
    authorise `transfer_funds` on the account's store.
  - **N2.** The cap is org-wide (`repo/expenses.ts:33-47`, no store filter), but the debit lands on `input.storeId`.
    So Malvar can "pay" Lipa's liability, and both stores' 2130 read wrong.
  - **N3.** Two payouts in flight can both pass the cap. There is no lock, and the idempotency key is random
    (`:77,:83`).
  - ✎ v1 has a payout void (`reimbursement.actions.ts:152`); v2 has none. → Q4.
  - ✎ `readFileUrl` authorises by the capability that governs UPLOADING the purpose (`files/index.ts:70-80,207`).
    AR collection proofs and delivery proofs are uploaded as `receipt_photo` (`customers/actions.ts:201`,
    `inventory/deliveries/actions.ts:161`; DEF-320), so viewing them needs `record_supplier_invoice`. That is
    accepted here, not fixed (Out of scope).
  - ✎ The dev default driver returns `memory://` URLs (`files/driver.ts:49-53`), and a browser cannot open them.
- **DEF-314.** `periodOverride` has no caller outside `post-entry.ts` and its test. Confirmed (grep). The reasons are
  `late_supplier_invoice`, `regulatory_correction`, `data_entry_error` and `other` (`schema/period-overrides.ts:39-46`,
  with a DB CHECK at `:79`). The capability `override_period_lock` exists (CAPABILITY-MATRIX `:130`, org, admin+).
  ✎ `docs/GLOSSARY.md:152` still says *"no posting into a closed period by any path, including … admin tools"*,
  which contradicts bible row 193. The orchestrator corrects the glossary.
- **DEF-302.** ✎ The register row records ruling (b) and T-281 as shipped (`0145`, the honest trigger sentence).
  Ian's 2026-09-30 ruling (a) adds: closed months' stock stays fixed, and the flows refuse with a plain closed-month
  sentence BEFORE any write. ✎ The line numbers have drifted, and **the census names three flows but there are six
  of this shape** (a stock movement plus a ledger post in one transaction, dated by the document):
  - `confirmReceipt`: movement `transfer.ts:385`, post `:503`; dated `receivedOn` (`trade/index.ts:822`).
  - `dispatchOrder`: `consume` at `transfer.ts:188`, post `:217`. ✎ It is dated `order.orderDate`
    (`trade/index.ts:506`), not the day of dispatch.
  - `runProductionPosting`: `consume` at `production/index.ts:421`, movements `:460,:519`, post `:563`; dated
    `producedOn`. Reached from `postProduction:604` and `editPostedProduction:665`; `voidProduction:803` reverses
    at `producedOn` (`:854`).
  - `recordInternalReturn`: `consume` at `returns.ts:435`, movement `:447`, post `:485`. ✎ `recordExternalReturn`
    (`:231`, movement `:274`/`consume :294`, post `:358`) is the same shape. Both are reached only through
    `recordCustomerReturn:165`.
  - ✎R And four more that POST (DEF-528, logged by the orchestrator 2026-09-30): delivery receipt
    (`deliveries/receive.ts:182`, `postReceiptValue` in the movement's tx), usage/wastage (`stock/usage.ts:156`),
    and supplier returns (`stock/supplier-returns.ts:164` moves at `now`, `:228` posts at `returnedOn`). S4a takes
    them.
  - Today, a closed date surfaces the trigger's P0001 text *"cannot move stock into a closed period (moved_at =
    …)"* (`0145:52-55`) through `errorMessage` step 2 (`constraint-messages.ts:311`). `receiveTradeOrder` wraps it
    as a bare `Error` (`trade/index.ts:908`).
- **DEF-479.** Confirmed. `editSalesDay` is named at `sales-days/create.ts:15,239` and does not exist.
  `voidSalesDay` refuses anything not `verified` (`verify.ts:188-193`). The repo halves already exist:
  `updateDraft` (`repo/sales-days.ts:431`, open/submitted only), `replaceChannels :551`, `replaceTenders :596`;
  `markVoided :492` is verified-only.
  ✎ The unique index `sales_days_org_id_store_id_business_date_unique` (`0016:84`) includes voided rows. So a voided
  day's date can never be entered again, for a verified day as much as a draft; v1 freed it by archiving. → Q1.
- **DEF-291.** ✎ The census line is partly stale. T-266 fixed the expense screen: `<MoneyLines>` loads through
  `lib/money-lines/load.ts:99` with `{ storeId }`. `listMoneyAccountsForPicker` (`expenses/lib.ts:183-195`, the
  `{}` at `:187`) now has ONE consumer, `sales-days/new/page.tsx:35`, which filters to the store after fetching
  every account. The other unscoped reads:
  - `money-transfers/lib.ts:34`: both selects offer every store's accounts. `transfer_funds` is checked on both
    ends only at submit (`money-transfers/*.ts:135,151`).
  - `channel-settlements/lib.ts:82`: the page filters per channel store (`page.tsx:255`) and the domain refuses a
    cross-store destination (`channel-settlements/index.ts:696`). Acceptable, left alone.
  - `settings/sales-channels/lib.ts:36`: a name lookup, not a picker.
  - ✎ T-266 §6.4's "another store" group was never built; `load.ts` drops other stores. A cross-store-paid expense
    (which `approve.ts:127` supports) therefore cannot be entered from the screen. → Q2.
  - ✎ The register's *"the other ~20 pickers are T-267"* mis-cites: T-267 is the `systemTransaction` routing task.

## Collisions and order
| Slice | Collides with | Rule |
|---|---|---|
| S1, S2, S3, S4a, S6a | none among themselves (file-disjoint) | **May run in parallel**, one lane DB each (§3.4 row 94); ✎R S1 only once T-366 S1 has committed |
| S1 + S2 | ✎R both TESTERs delete ADJACENT rows of `tests/unit/domain-actions-have-callers.test.ts` (`payReimbursement` `:123-125`, `readFileUrl` `:126-128`) | Use Edit on the exact row, never a whole-file write; the second to commit rebases |
| S1 | ✎R `packages/db/src/repo/advisory-locks.ts` and `packages/db/src/index.ts` are T-366 S1's (uncommitted at HEAD) | **S1 waits for T-366 S1 to commit** |
| S2 | ✎R `ap/invoices/[id]/page.tsx` and `customers/[customerId]/page.tsx` are NOT T-367 BUILDER paths (T-367 S1 edits `customers/actions.ts`, S3 `ap/page.tsx`, S5 `expenses/[id]/page.tsx`) | None |
| S4a | ✎R `deliveries/receive.ts`, `stock/usage.ts`, `stock/supplier-returns.ts` — no other money-push task lists them | None |
| S4b | `packages/domain/src/trade/index.ts` is a T-372 S3 BUILDER path. The check lives in `trade/index.ts`, not `commissary/transfer.ts`, but it still collides | **After T-372 S3 commits** |
| S5a | S1's files | After S1, same lane |
| S5b | `expenses/approve.ts` (T-367 S2), `expenses/actions.ts` (T-364 dirty, T-367 S2/S5), `expenses/[id]/page.tsx` (T-367 S5) | **After T-367 S2 and S5 commit** |
| S6b | `lib/money-lines/load.ts` callers include `expenses/actions.ts:169` and `ap/invoices/[id]/page.tsx:46` | After T-367; only if Q2 = (a) |
| S3 | T-370 edits `sales-days/create.ts:44`. S3 imports from `create.ts` and never edits it | None |
| S7 | S3's files plus a migration | After S3; only if Q1 = (a) |
| All | T-368 edits `repo/fiscal-periods.ts` and `fiscal-periods/*`. Nothing here edits them (S5 reads `schema.fiscalPeriods` from the app) | None |
| All | T-371 (NaN sweep) runs last and will touch these files | T-369 first |

## Invariants (every slice)
- I1. Every write runs through a domain function that calls `authorize()` first (bible §7.1, RULES §1 row 7). A page or
  button hidden from someone is presentation only. The ✗ is proven in the domain AND in the action.
- I2. No new capability. Every control uses an existing CAPABILITY-MATRIX row (listed per slice). The orchestrator adds
  the "used by" notes to the matrix at wrap-up; the lanes never edit it.
- I3. The database enforces balance, period and immutability (RULES §6.3). S4's check does not replace the trigger:
  it only chooses the sentence and refuses before the first write. A mutant proves the trigger still refuses without
  it.
- I4. An override's actor is always the domain function's own `actor`. The form supplies only `reason` and `note`
  (bible row 193, landmine 17).
- I5. The override never reaches a stock flow (Ian (a), 2026-09-30). The override control is never rendered on a stock
  screen.
- I6. Screens reuse the pattern set (RULES §1.2c): `Page`, `PageDescription`, `FilterRow`, `components/ui`, `back()` +
  `?error=` / `?ok=` banners as on `/inventory/production/[id]`. `requirePageAccess` is used for gated routes.
  ✎R Inline forms and `back()` banners only — **no `alert()` / `confirm()`** anywhere. A disclosure is the native
  `<details>` pattern already used at `channel-settlements/page.tsx:271` (`components/ui` has only Button, Card,
  Input and no disclosure primitive); do not build a new one. Every new screen works at 375px and in dark mode.
- I7. User-facing refusals carry no ids and no raw column names (T-343, `errorMessage` step 0). Each refusal is a
  `refuse(raw, userSentence)` or an Outcome with `userReason`.
- I8. Money arithmetic uses `@shareat/core/money`, never `Number` (bible §2.5). New code adds no `Number()`
  comparisons; the existing ones are T-371's.

---

## S1: DEF-198 — staff reimbursement payout screen (+N1, N2, N3)
**Capability:** `record_ap_payment` (store, manager+, staff ✗), which `reimbursement.ts:43` already checks. For a
cross-store draw, `transfer_funds` on the account's store.
**BUILDER** (source):
- `packages/db/src/repo/expenses.ts`:
  - `reimbursablePayablesAtStore(tx, orgId, storeId)` returns `{ employeeId, displayName, outstanding }[]`,
    grouped by `party_id`, over lines on 2130 at that store (`jl.store_id`), `je.status <> 'draft'`, outstanding
    > 0, joined to `persons`, ordered by outstanding descending;
  - `reimbursablePayableOf` gains an optional `storeId` filter;
- ✎R `packages/db/src/repo/advisory-locks.ts` (T-366 S1's file; **S1 starts after T-366 S1 commits**):
  `lockReimbursementPayee(tx, employeeId)` using T-366's two-int4 form (`pg_advisory_xact_lock(<new namespace
  constant>, hashtext(employeeId))`), a new named namespace constant, and the key added to that file's key-list
  comment. `packages/db/src/index.ts` already exports the module once T-366 lands; touch it only if it does not.
- `packages/db/src/repo/journal.ts` is NOT edited: the replay lookup uses the existing
  `journalRepo.findEntryByIdempotencyKey` (`journal.ts:90`), the same read `postEntry` does first.
- `packages/domain/src/expenses/reimbursement.ts`, in this order after `authorize`:
  1. load the account. ✎R Refuse, in the domain (not only the picker), an inactive account (*"That money account is
     retired."*) or a staff-float account (`custodian = 'staff'`: *"Pay from a store account, not a staff float."*).
     If `account.storeId !== input.storeId`, `authorize(transfer_funds, { storeId: account.storeId })` (N1);
  2. `lockReimbursementPayee` (N3);
  3. ✎R compute the deterministic key `reimbursement:{employeeId}:payout:{input.payoutId}` (`payoutId` = a new
     required input minted server-side at page render, a hidden field) and look up an existing entry with that key.
     If one exists, return it (`{ entryId, outstanding, created: false }`) **before** the cap check — otherwise a
     replay after commit sees outstanding 0 and is refused;
  4. read outstanding **at `input.storeId`** (N2) and refuse an overpayment against it;
  5. post with that key. A double submit of one form posts once.
- `apps/erp/src/app/expenses/reimbursements/page.tsx` (new):
  - `requirePageAccess('/expenses/reimbursements')`, a store `FilterRow` (stores where the actor holds
    `record_ap_payment`), and the table *Person · Owed · Pay*;
  - Pay opens an inline form: amount (default = owed), date (default today), money account (the store's accounts,
    active, not staff floats), memo;
  - empty state: *"Nobody is owed a reimbursement at this store."*
- `apps/erp/src/app/expenses/reimbursements/actions.ts` (new): `payReimbursementAction`. It uses `requireActor`,
  calls the domain, and `back()` with ok *"Paid ₱{amount} to {name}. Still owed: ₱{outstanding}."* plus the
  `checkDraw` warning if any, or with the error.
- `apps/erp/src/app/expenses/reimbursements/lib.ts` (new): the loaders.
- `apps/erp/src/lib/route-capability.ts`: `'/expenses/reimbursements': 'record_ap_payment'` (it names colleagues'
  money, like `/payroll`).
- `apps/erp/src/components/nav.tsx`: *Reimbursements* under Expenses.

**TESTER:** `packages/domain/tests/integration/t369-s1-reimbursement-payout.test.ts` (new) ·
`apps/erp/tests/integration/t369-s1-reimbursement-web.test.ts` (new) · `tests/unit/domain-actions-have-callers.test.ts`
(delete the `payReimbursement` EXEMPT row).

**Contract:** `payReimbursement(tx, actor, { storeId, employeeId, amount, fromMoneyAccountId, on, payoutId, memo? })`
returns `{ entryId, outstanding, created, warning? }`, where `outstanding` is at that store. Posting pattern
`reimbursement.payout` (POSTING-PATTERNS `:190-201`): DR 2130 (employee) / CR the money account.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD):
- T1: owed ₱650 at Lipa; the manager pays 650 from Lipa cash. Exactly one entry, DR 2130 650 party=employee
  store=Lipa, CR 1110 650; outstanding 0.00. Positive control for every refusal below.
- T2 (N2): owed ₱650 at Lipa and ₱0 at Malvar. Paying 100 with `storeId = Malvar` is refused (*"This employee has no
  unpaid reimbursement at this store."*) and no entry is written. Mutant: drop the store filter → posts → red.
- T3 (N1): a Lipa manager without `transfer_funds` at Malvar pays from Malvar's safe → `AuthorizationError`, nothing
  posted. Positive control: an admin (who holds it at both) → posts. Mutant: remove the cross-store `authorize` →
  red.
- T4 (N3): two connections, gated harness as in T-366 S1. Owed 1,000; A pays 700 and B pays 600. Exactly one
  succeeds, the other gets the overpayment refusal, and 2130 at Lipa is 300 or 400, never −300. B is observed
  waiting on `advisory`. Mutant: remove the lock → red.
- T5: owed 650; pay 650 with `payoutId` P, commit; replay P → the SAME `entryId`, `created: false`, no refusal, one
  entry. Mutants: (i) a random key → two entries or a refusal → red; (ii) the replay lookup moved after the cap check
  → the replay is refused ("no unpaid reimbursement") → red.
- T5b ✎R: an inactive account and a staff-float account are each refused by the DOMAIN with its sentence; nothing
  posted. Positive control: T1.
- T6 (✗): a staff member at Lipa → `AuthorizationError`; the web action shows the refusal banner; no entry. Positive
  control: T1.
- T7 (web): a staff GET of `/expenses/reimbursements` gets the page-access refusal; a manager sees the owed row.
  `route-capability-coverage` stays green.

**Smoke (9008, `shareat_test_setup`; 2027-02 is open there, per T-366):**
1. As a manager, create an expense at a store dated 2027-02-05, paid ₱650 *reimbursable* by a named staff member;
   approve it.
2. Open *Expenses → Reimbursements*: the person is listed as owed ₱650.
3. Pay ₱650 dated 2027-02-06 from the store's cash: the banner shows ₱0 still owed and the row disappears.
4. Sign in as staff: the nav has no Reimbursements link, and the URL is refused.
5. ✎R Repeat step 2–3's page at 375px wide and in dark mode.

Screenshots at each step.

---

## S2: DEF-198 — view an attached photo
**Capability:** `PURPOSE_CAPABILITY[file.purpose]` (`files/index.ts:70`, checked inside `readFileUrl`). No new row.
**BUILDER:**
- `apps/erp/src/app/files/[fileId]/route.ts` (new): `GET`, `dynamic = 'force-dynamic'`. It calls
  `requireActor`, then `readFileUrl(null, actor, { fileId })`, then responds 302 to the URL with
  `Cache-Control: private, no-store`.
  - Not found, another org, and `AuthorizationError` all get one uniform 404 page reading *"This photo isn't
    available to you."* The uniform sentence reflects T-364 Q1 (a): no existence leak.
  - ✎R ONLY not-found (another org included) and `AuthorizationError` map to that 404. Anything else (an internal
    fault, the storage driver failing) → 500 with the generic fallback sentence, logged without the URL.
  - A non-uuid `fileId` gets the same 404, without touching the DB.
  - The URL and fileId are never logged.
- `apps/erp/src/app/ap/invoices/[id]/page.tsx:125-128`: the *"photo attached"* line gains *View photo* (`<a
  href="/files/{id}" target="_blank" rel="noopener">`).
- `apps/erp/src/app/inventory/deliveries/[id]/page.tsx`: *View photo* when the delivery has `proofFileId`
  (`repo/deliveries.ts:237,261` already selects it).
- `apps/erp/src/app/customers/[customerId]/page.tsx`: *View photo* on a collection row with `receiptFileId`
  (`repo/ar.ts:550,602`).

**TESTER:** `apps/erp/tests/integration/t369-s2-file-view-web.test.ts` (new; it installs the in-memory driver, as
`files.test.ts` does) · `tests/unit/domain-actions-have-callers.test.ts` (delete the `readFileUrl` row).

**Tests:**
- T1: a manager at the invoice's store → 302, `Location` starts `memory://orgs/{org}/stores/{store}/receipt_photo/`,
  `Cache-Control` contains `no-store`.
- T2 (✗): a staff member without `record_supplier_invoice` at that store → 404 with the uniform sentence and no
  `Location`. Positive control: T1. Mutant: return `readFileUrl`'s error text → the body contains the fileId → red.
- T3: another org's file id, and a random uuid → the same 404 body byte-for-byte as T2.
- T4: a manager at ANOTHER store → 404.
- T5 ✎R: a driver whose `signedUrl` throws → 500, not 404, and the body carries no path. Mutant: a catch-all to 404
  → red.

**Smoke:**
1. Upload a supplier invoice with a photo on `/ap`, then open it. *View photo* opens the image if
   `FIREBASE_STORAGE_BUCKET` is set.
2. With the in-memory driver, the Network tab shows the 302 and its `Location`.
3. As staff without the grant: the 404 sentence.

---

## S3: DEF-479 — edit or withdraw an unverified sales day (+ DEF-291's sales-day leg)
**Capabilities:** edit an `open` day needs `submit_sales_day`; edit a `submitted` day needs `verify_sales_day` (once
submitted it is the verifier's); void an unverified day needs `void_sales_day` (manager+, staff ✗). All exist
(CAPABILITY-MATRIX `:32-34`).
**Rulings (planner):**
- R1. Edit changes figures, channels and tenders, never the store or the date: the date is what the create-block and
  the unique index key on.
- R2. Edit never consults the create-block (`create.ts:9-20`).
- R3. Voiding an unverified day writes NO journal entry and requires a reason. `findOldestUnverifiedBefore` already
  excludes `voided`, so the block lifts. ✎R **Withdraw is refused while something else hangs off the day**, with a
  plain sentence naming it and nothing reversed automatically (the dependent is undone first, on its own screen):
  - a live POS usage pull (`pos_usage_pulls` for the day, `status <> 'void'`; `pos/usage-pull.ts:138`,
    `repo/pos-mapping.ts:284`): *"This day has a POS usage pull. Void the pull first."*;
  - `order_wastages` rows with this `sales_day_id` (`schema/order-wastage.ts:92`): *"Wastage is recorded against this
    day. Void it first."*;
  - `remittance_allocations` for this store and `business_date` (or this `sales_day_id`) on a `posted` remittance
    (`schema/remittance.ts:157-167`): *"Cash handed over has been counted against this day. Reverse that handover
    first."*
- R4. Edit does not change status: a submitted day stays submitted, and the verifier sees the edited figures.
- R5 ✎R. **Edit and verify serialise on the day row.** `editSalesDay` and `runVerify` (`verify.ts:69`) both read the
  day with `SELECT … FOR UPDATE` (a new `salesDaysRepo.getByIdForUpdate`) before any other read, and the void of an
  unverified day does the same. Verify can therefore never post figures an edit is half-way through changing.

**BUILDER:**
- `packages/domain/src/sales-days/edit.ts` (new): `editSalesDay(tx, actor, { salesDayId, …the create figures,
  channels, tenders })`. It uses the same `money()` parsing as create, `updateDraft`, and `writeChannels` /
  `writeTenders` imported from `create.ts` (replace semantics via `replaceChannels` / `replaceTenders`).
  - A `verified` or `voided` day is refused: *"Only an unverified sales day can be edited — this one is {status}."*
  - ⛔ `create.ts` is NOT edited (T-370 owns `:44`).
- `packages/domain/src/sales-days/verify.ts`: `voidSalesDay` accepts `open`/`submitted` and marks them voided with no
  reversal. Its `:188-193` refusal becomes *"This sales day is already voided."* for `voided`. The verified branch is
  unchanged.
- `packages/domain/src/sales-days/index.ts`: export `editSalesDay`.
- `packages/db/src/repo/sales-days.ts`: `markUnverifiedVoided(tx, orgId, id, { voidedBy, voidReason })` with the
  predicate `status in ('open','submitted')` and a zero-rows `recordGone`; ✎R `getByIdForUpdate(tx, orgId, id)`;
  `withdrawBlockers(tx, orgId, day)` returning which of R3's three dependents exist (one query each, read-only).
- ✎R `verify.ts`'s `runVerify` switches its first read to `getByIdForUpdate` (R5); nothing else in verify changes.
- `apps/erp/src/app/sales-days/SalesDayForm.tsx` (new): the form body extracted from `new/page.tsx`, taking
  `defaults` and `action`.
- `apps/erp/src/app/sales-days/new/page.tsx`: uses `SalesDayForm`. Wallets come from the new store-scoped
  `listStoreMoneyAccounts(orgId, storeId)` (DEF-291; replaces `:35`).
- `apps/erp/src/app/sales-days/[id]/edit/page.tsx` (new): `SalesDayForm` prefilled from the day, its channels and
  its tenders.
- `apps/erp/src/app/sales-days/actions.ts`:
  - `editSalesDayAction`, whose FormData parsing is shared with create (one helper, not two copies);
  - `voidSalesDayAction` unchanged in signature.
- `apps/erp/src/app/sales-days/[id]/page.tsx`:
  - *Edit* link for `open`/`submitted`;
  - the void form (`:254`) is shown for `open`/`submitted`/`verified`, worded *"Withdraw this unverified day"* vs
    *"Void (reverses the posting)"*;
  - if Q1 is unanswered or (b), the draft wording adds *"The date stays used — a new day cannot be entered for {date}."*
- `apps/erp/src/app/sales-days/lib.ts`: `listStoreMoneyAccounts`; drop the `listMoneyAccountsForPicker` re-export.
- `apps/erp/src/app/expenses/lib.ts`: delete `listMoneyAccountsForPicker` (`:175-195`), which has no remaining
  consumer.

**TESTER:** `packages/domain/tests/integration/t369-s3-sales-day-edit-void.test.ts` (new) ·
`apps/erp/tests/integration/t369-s3-sales-day-web.test.ts` (new).

**Tests:**
- T1 (the Lipa shape): a day with total 1,000 and channels allocating 500. Verify is refused (today's routing
  refusal). Edit the channels to 1,000, then verify → posts one entry. Red on HEAD: `editSalesDay` is not exported.
- T2: edit keeps the status (`open` stays open, `submitted` stays submitted); `updatedAt` moves.
- T3 (✗): staff edits a `submitted` day → `AuthorizationError`, figures unchanged. Positive control: a manager edits
  it. Mutant: check `submit_sales_day` for both statuses → staff succeeds → red.
- T4: edit a `verified` day → refused with the sentence; the journal is untouched.
- T5: void an `open` day as a manager → status `voided`, reason stored, **zero** journal entries for the day. A newer
  day at that store can now be created by staff (the block has lifted). Positive control: before the void, staff
  creating the newer day gets `SalesDayBlockedError`.
- T6 (✗): staff voids an open day → `AuthorizationError`; the day stays open.
- T7: void a `verified` day → unchanged behaviour (one reversal); the existing void tests stay green.
- T8: edit with a channel from another store → the existing `writeChannels` refusal; nothing is changed (all-or-
  nothing in one tx). Mutant: write the header before validating channels → the header changed → red.
- T10 ✎R (R5 race, two connections, gated harness as T-366 S1): A holds `editSalesDay` open mid-transaction
  (channels replaced, not committed); B runs `verifySalesDay`. B is observed waiting (`wait_event_type = 'Lock'`,
  `transactionid`/`tuple`), then posts from A's committed figures. Reverse order: A verifies, B edits → B waits, then
  is refused (*verified*). Mutant: plain `getById` in either → B never waits / posts stale figures → red.
- T11 ✎R (R3, one leg per dependent): an open day with (i) a live usage pull, (ii) an `order_wastages` row, (iii) a
  posted remittance allocation on its date → withdraw refused with that dependent's sentence; the day stays open.
  Positive controls: a `void` pull and a `reversed` remittance do not block. Mutant: drop each check → red.
- T9 (web, DEF-291): `/sales-days/new?store=Lipa` renders only Lipa's wallets. The server loader's returned set
  contains no other store's account (asserted on the loader, not only the markup).

**Smoke:**
1. At a store, create a day for 2027-02-10 with total ₱1,000 and a channel of ₱500. Verify is refused.
2. *Edit*: set the channel to ₱1,000, save, verify → verified.
3. Create 2027-02-11 as staff, then sign in as a manager and *Withdraw* it with a reason → voided. Staff can now
   create 2027-02-12.
4. As staff, the Withdraw form is absent and a forged POST is refused.
5. ✎R The edit page at 375px and in dark mode.

After merge, the orchestrator uses the new Edit on the kept dev draft (Lipa 2026-09-28, Ian's reproduction) and tells
Ian. The lane does not touch the dev DB.

---

## S4: DEF-302 (Ian (a)) — refuse stock in a closed month, in plain words, before any write
**Ruling:** no override for stock, ever (I5). The trigger `0145` is unchanged and stays the enforcement (I3).
**BUILDER:**
- `packages/domain/src/stock/period-guard.ts` (new): `closedStockPeriodSentence(tx, orgId, date, doing)` returns
  `string | null`. It reads `journalRepo.findPeriodForDate`.
  - For a period with status `closed` or `locked`, it returns *"{Month YYYY} is closed. Stock can't be {doing} on
    {d MMM YYYY} — a closed month's stock stays as it was, and the closed-month override doesn't change that. Use a
    date in an open month."*
  - For `locked`, the word is "locked".
  - Month and date via `humanDate`.
  - No period, or `open` → `null` (unchanged behaviour).
- **S4a** (parallel-safe):
  - `packages/domain/src/production/index.ts`: at the top of `postProduction`, `editPostedProduction` and
    `voidProduction`, after `authorize`, check `record.producedOn` with doing = "produced" / "changed" / "voided".
    Return `{ ok: false, reason: sentence }` before any read-for-write.
  - `packages/domain/src/trade/returns.ts`: `recordCustomerReturn` checks `returnedOn` (doing = "returned") before
    dispatching to either branch.
  - ✎R (DEF-528; Ian's (a) covers every stock-plus-ledger flow, not only the three named):
    - `packages/domain/src/deliveries/receive.ts`: `receiveDelivery` (`:83`) checks `deliveredOn` (doing =
      "received") before its first movement; `postReceiptValue` (`:182`) posts in the same tx;
    - `packages/domain/src/stock/usage.ts`: `postUsageRecord` (`:68`) checks `usedOn` (doing = "used" / "wasted"
      by kind) before its first movement (`:117`; `postWastage`/`postConsumption` at `:156`); `voidUsageRecord`
      (`:203`) checks `voidedOn` (doing = "voided");
    - `packages/domain/src/stock/supplier-returns.ts`: `recordReturn` (`:77`) moves stock at `now` (`:164`) but posts
      at `returnedOn` (`:228`) — it checks BOTH today's date and `returnedOn` (doing = "returned"); `voidReturn`
      (`:268`, movement at `now` `:313`) checks today's date.
- **S4b** (after T-372 S3): `packages/domain/src/trade/index.ts`:
  - `receiveTradeOrder` checks `receivedOn` BEFORE the line loop, because `setLineReceivedQuantity` (`:893`) writes
    inside it; doing = "received"; throw `refuse(raw, sentence)`;
  - `dispatchTradeOrder` checks `order.orderDate` before its first write; doing = "dispatched".

**TESTER:** `packages/domain/tests/integration/t369-s4a-stock-closed-month.test.ts` ·
`packages/domain/tests/integration/t369-s4b-trade-closed-month.test.ts` (new).

**Tests** (a period closed via the repo, as in `stock-movements-period-override.test.ts`):
- T1 production post dated in a closed month:
  - `{ok:false}` with the reason matching `/^September 2026 is closed\. Stock can't be produced on/`, and no
    `/cannot move stock/`;
  - zero `stock_movements`, zero entries, and the record stays `draft`.
  - Red on HEAD: the reason is the trigger text or a thrown P0001.
  - Positive control: the same record in an open month posts.
  - Mutant: remove the guard call → the trigger still refuses (P0001 *cannot move stock*), which proves I3 → the
    leg asserting the sentence goes red.
- T2 production void and edit of a record whose `producedOn` is now closed (post while open, then close) → the
  sentence; the record stays `posted`; no reversal.
- T3 `recordCustomerReturn`, internal and external, `returnedOn` closed → the sentence; no movement, no entry, no
  `customer_returns` row.
- T4 (S4b) `receiveTradeOrder` with `receivedOn` closed → the `refuse` user sentence via `errorMessage`; no
  `trade_order_lines.received_quantity` changed, no delivery row, no movement. Positive control: an open date.
- T5 (S4b) dispatch of an order whose `orderDate` is closed → the sentence; the order stays not dispatched.
- T6 (I5): an admin holding `override_period_lock` gets the SAME sentence on T1/T4 (there is no override input on
  these functions; asserted by the sentence and by zero `period_overrides` rows).
- T7: `locked` → the same sentence with "locked".
- T8 ✎R (DEF-528, one leg each, same shape as T1 — sentence, zero movements, zero entries, positive control on an
  open date, mutant = remove that call): `receiveDelivery` (`deliveredOn` closed); `postUsageRecord` wastage AND
  consumption (`usedOn` closed); `voidUsageRecord`; `recordReturn` with `returnedOn` closed while today is open,
  and with today closed while `returnedOn` is open (both refused); `voidReturn` with today closed.
- The existing `stock-movements-period-override.test.ts` stays green, unchanged.

**Smoke:**
1. `/inventory/production`: a draft dated 2026-09-15 → Post → the banner reads "September 2026 is closed…".
2. The same for a customer return dated 2026-09-15.
3. (S4b) Receive a commissary order with the date 2026-09-15.
4. ✎R A supplier delivery received on 2026-09-15, and a wastage record dated 2026-09-15.

Screenshots.

---

## S5: DEF-314 — post one late entry into a closed month
**Capability:** `override_period_lock` (org, admin+; the adminless-manager fallback per row 196), authorised inside
`postEntry:189`. The screen never decides it. The control shows only to holders (`heldCapabilities`).
**Scope:** per Q3. Default (a): the reimbursement payout (S5a) and expense approval (S5b).
**BUILDER S5a** (after S1):
- `apps/erp/src/lib/period-override.ts` (new):
  - `closedMonths(orgId)`: `schema.fiscalPeriods` rows with status `closed`, as `{ startsOn, endsOn, label }`.
    `locked` is excluded: it cannot be overridden;
  - `readPeriodOverride(fd)`: returns `{ reason, note } | undefined`, only when the confirm box is on and `reason`
    is in `PERIOD_OVERRIDE_REASONS`; `note` is required when `reason = 'other'`.
- `apps/erp/src/components/ClosedMonthOverride.tsx` (new, client): given `closedMonths` and the date field's name,
  it appears only when the chosen date falls in a closed month. ✎R It is a native `<details>` panel in the
  `channel-settlements/page.tsx:271` style, built from `components/ui` `Input`/`Button` — no new disclosure primitive,
  no `confirm()`; the confirm is an inline checkbox the server re-reads.
  - It reads *"{Month} is closed. You can post this one entry into it. It will be recorded against your name with
    the reason below."*
  - It has a reason select with plain labels (Late supplier bill · Correction required by BIR/regulator · Fixing a
    mistake · Other), a note, and a confirm checkbox.
  - Non-holders are never passed the component.
- `packages/domain/src/expenses/reimbursement.ts`: optional `periodOverride?: { reason, note? }` input, forwarded
  as `{ actor, reason, note }` to `postEntry` (I4).
- The reimbursement page and action from S1: mount the control; pass `readPeriodOverride(fd)`.

**BUILDER S5b** (after T-367 S2/S5): `packages/domain/src/expenses/approve.ts` (the same optional input, forwarded at
`:201`) · `apps/erp/src/app/expenses/actions.ts` (the approve action) · `apps/erp/src/app/expenses/[id]/page.tsx`
(mount the control on the approve form).
**TESTER:** `packages/domain/tests/integration/t369-s5-closed-month-override.test.ts` ·
`apps/erp/tests/integration/t369-s5-override-web.test.ts` · `tests/unit/t369-override-not-on-stock-screens.test.ts`
(new).

**Tests:**
- T1: an admin pays a reimbursement dated in a closed month with `{ reason: 'data_entry_error', note }` → posted;
  one `period_overrides` row with actor = the admin, the reason, the note, and `period_status_at_post = 'closed'`.
  Red on HEAD: the input is ignored → closed-period error.
- T2 (✗): a manager in an org WITH an admin sends the same fields → `AuthorizationError`; no entry, no override row.
  Positive control: T1. Mutant: authorize `record_ap_payment` instead of forwarding → red.
- T3: no override fields and a closed month → refused; no override row. The web banner says the month is closed
  (no id).
- T4: a `locked` period with the override → refused with the locked sentence; no row.
- T5: an open month WITH override fields → the web action does not forward them: `readPeriodOverride` plus a
  server-side date check (the date's period is `closed`, else drop the override), so no audit noise. Mutant:
  forward unconditionally → a row with `open` → red.
- T6 (web): an invalid reason string → the override is dropped → closed-month refusal. Holders see the control in the
  rendered HTML; a manager does not.
- T7 (S5b): the same T1/T2 on `approveExpense`.
- T8 (unit, I5): `ClosedMonthOverride` is imported only by an allowlist (`expenses/reimbursements/page.tsx`,
  `expenses/[id]/page.tsx`). Any import under `inventory/`, `commissary/` or `trade` fails.

**Smoke:**
1. As admin, pay a reimbursement dated 2026-09-15 (closed): the panel appears. Choose *Fixing a mistake*, add a note,
   confirm → posted.
2. `select * from period_overrides` shows the row.
3. As a manager: no panel; the same date gives *"September 2026 is closed…"*.
4. ✎R The open panel at 375px and in dark mode.

---

## S6: DEF-291 — money-account lists offer what the person can use
**Capability:** `transfer_funds` (store, manager+).
**BUILDER S6a:**
- `apps/erp/src/app/money-transfers/lib.ts`: `listTransferableAccounts(actor)` returns accounts only at stores where
  the actor holds `transfer_funds`. Use the per-store authorize loop of `channel-settlements/page.tsx:73-86`, once
  per distinct store.
- `apps/erp/src/app/money-transfers/page.tsx`: the From/To selects use it. The balances list keeps its current
  read gate (`view_financial_reports`).
- If no store qualifies: *"You can't move money at any store."*

**BUILDER S6b** (only if Q2 = (a), after T-367):
- `lib/money-lines/load.ts`: add `otherStoreSources` for stores where the actor holds `transfer_funds`; the signature
  gains `actor`.
- `components/money/MoneyLines.tsx`: a collapsed *"Another branch — needs permission to move that branch's money"*
  group (T-266 §6.4).
- The callers: `expenses/new/page.tsx`, `expenses/actions.ts`, `ap/invoices/[id]/page.tsx`.

**TESTER:** `apps/erp/tests/integration/t369-s6-account-lists-web.test.ts` (new).

**Tests:**
- T1: a Lipa-only manager → Malvar's accounts are absent from the loader's result. Red on HEAD: present.
- T2: an admin → both stores.
- T3 (✗ unchanged): a forged POST naming Malvar by the Lipa manager is still refused by the domain (`:135`).
- Mutant: skip the loop → T1 red.
- (S6b) T4: the other-store group holds only stores with the grant; an approval from it posts with `transfer_funds`
  checked (`approve.ts:127`).

**Smoke:** as a one-store manager, open `/money-transfers`: the selects list that store only. As admin: all stores.

---

## S7 (only if Q1 = (a)): a voided day frees its date
**BUILDER:**
- A migration at the next free index: drop `sales_days_org_id_store_id_business_date_unique` and recreate it
  `WHERE status <> 'voided'`. Update `meta/_journal.json`, `schema/sales-days.ts` (the index `.where(...)`), and the
  trigger/RLS registries if the guard requires them. Hand-authored per ADR-012 §5.
- `repo/sales-days.ts`: `findByBusinessDate` filters `status <> 'voided'`.

**TESTER:** `packages/db/tests/integration/t369-s7-migration.test.ts` and a domain leg:
- void → create the same date → succeeds;
- two live days for one date → unique violation;
- mutant: the index without the predicate → red.

## Out of scope
- A void for a reimbursement payout (Q4; if (a), a follow-up slice after S5a).
- Viewing capability per record rather than per upload purpose, and DEF-320's purposes.
- ✎R Stock flows that post NO ledger entry: counts (`stock/count-workflow.ts`) and in-store room transfers
  (`stock/transfers.ts`, which already refuses early via its own `assertPeriodOpen` `:45-58`, showing *"fiscal period
  … is closed — cannot move stock dated …"* with the id redacted). Counts show the `0145` trigger sentence today
  (*"cannot move stock into a closed period (moved_at = …)"*). Deferred under DEF-528; wastage, usage, delivery
  receipt and supplier returns are IN S4a (they do post).
- Changing `dispatchOrder` to date by the dispatch day (new DEF, orchestrator).
- The override on screens other than Q3's answer.
- Reopening a period (bible row 193 forbids it).
- NaN in the existing `Number()` comparisons (T-371).
- CAPABILITY-MATRIX notes, the GLOSSARY `:152` correction, register rows, and the bible — all the orchestrator's, at
  wrap-up.

## Done when
- S1, S2, S3, S4a, S5a and S6a are green. S4b is green after T-372 S3; S5b after T-367; S6b and S7 per Q2 / Q1.
- Each red leg was shown red on HEAD or against its named mutant before the build.
- Typecheck is clean. The unit suite passes, including `domain-actions-have-callers`,
  `route-capability-coverage`, `nav-route-reachability`, `production-caller-ratchet`, and the T8 allowlist. The
  FULL integration suite passes before push.
- Each slice's smoke was run on 9008 against `shareat_test_setup`, with screenshots. ✎R Every new screen
  (reimbursements, sales-day edit, the override panel) also has a 375px screenshot and a dark-mode screenshot; a grep
  of the touched app files finds no `alert(` / `confirm(`.
- `npm run build` passes with the dev server stopped. `file` on each touched file shows LF.
- The builder touched only BUILDER paths.
- The orchestrator, at wrap-up:
  - marks DEF-198 (the two rows), 314, 302, 479, 291 and (for the S4a flows) DEF-528 fixed with hashes;
  - files N1–N3, the Q4 gap and the dispatch-date finding as new DEFs;
  - corrects DEF-302's and DEF-291's census lines;
  - regenerates the production-caller baseline by script (never by hand, DEF-240).

## Questions only Ian can answer
- **Q1: When a sales day is withdrawn or voided, can a new one be entered for the same date?**
  Example: Lipa's 28 September report was typed wrong and a manager withdraws it. Today the system then refuses any
  new report for 28 September, forever, so Lipa's real sales for that day can never be recorded. The same is true
  after voiding a verified day.
  - (a) **Yes — voiding frees the date** (recommended; v1 did this by archiving the old report). It needs a small
    database change (S7).
  - (b) No — the date stays used; a mistake must be fixed by editing before it is verified.
  - Default until you answer: (b), and the Withdraw button warns that the date stays used.
- **Q2: Should the expense screen offer another branch's money?**
  Example: a Lipa expense was actually paid from Malvar's safe. Today the Lipa expense screen lists only Lipa's
  accounts, so this cannot be entered at all, even though the system allows it for someone permitted to move
  Malvar's money.
  - (a) **Show other branches' accounts in a folded "Another branch" group, only to people allowed to move that
    branch's money** (recommended; this is the design you approved for T-266).
  - (b) Keep it to this branch only.
  - Default: (b).
- **Q3: Which screens get the "post into a closed month" control (admins only, with a reason, recorded)?**
  Example: an August supplier bill turns up in October after August is closed, and it must be booked as an August
  expense.
  - (a) **Expense approval and staff reimbursement payouts** (recommended; that is where late paperwork lands).
  - (b) (a) plus supplier payments and customer collections.
  - (c) Every screen that posts money.
  - Default: (a). Stock screens never get it — your ruling.
- **Q4: Should a staff reimbursement payout be undoable?**
  Example: a manager pays Ana back ₱650 but picks the wrong cash drawer. v1 had a Void button for this; v2 has none,
  so the mistake cannot be corrected on screen.
  - (a) **Add Void: it reverses the payout, and Ana is shown as owed again** (recommended; same permission as
    paying).
  - (b) No.
  - Default: not built in this task; logged as a new defect.

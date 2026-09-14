# T-196 — A draft expense may sit against a PENDING supplier invoice; verification posts it

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-196`) for the commit, date and outcome —
> the roadmap is the maintained record. **Depends on:** T-122 (expenses — `status`,
> `approveExpense`, `deleteExpenseDraft` all already exist), T-130 (AP — `supplier_invoices`, the
> verify gate, the capacity trigger), T-141 (the file broker behind `receipt_file_id`).
> **Blocks:** nothing. **Written by:** Opus, in planner role, 2026-08-31, from Ian's direction in
> session. **Bible §3.3 format.** Amends the bible — see §13 row 170.

## Why this task, and what it actually is

T-130 made the receipt gate real and enforced it in the database: an expense row cannot exist
unless its `supplier_invoice_id` names an invoice already at `status = 'verified'`
(`packages/db/migrations/0043_t130_accounts_payable.sql:328-362`). That is v1's rule — *no expense
without a verified receipt* — carried over and enforced **harder** than v1 ever managed, because
v1 checked role and never identity and so self-verified 577 of 1,324 receipts.

The rule is right. **Its timing is what costs.** Today the sequence is: person A records the
invoice and photographs the paper; person B verifies it; then someone holding *both*
`create_expense` and `approve_expense` records the expense — `recordExpenseForInvoice`
(`packages/domain/src/ap/index.ts:564`) requires the pair, which means a cashier holding only
`create_expense` **cannot record an expense at all**. Three people, strictly ordered, before a ₱300
purchase reaches the books. The cashier who knows what the money was for is the one person in that
chain who cannot write it down.

Ian, 2026-08-31:

> *"we will improve that unverified receipt can then be posted against draft expense so cashier
> does not need verification to start recording. when receipt is verified the expense are posted.
> when receipt is rejected voided the draft expense is deleted or the posted expense is also
> voided."*

**The change in one sentence:** the gate moves from *"an expense may not **exist** until its
invoice is verified"* to *"an expense may not **post** until its invoice is verified."*

It is small because T-130 already built every part except the reachable draft state.
`expenses.status` has carried `'draft'` since migration 0015, `approveExpense` has always been a
separate verb from `createExpense`, and `deleteExpenseDraft` and `editExpense` are both draft-only
and shipped — yet nothing has ever been able to reach that state, because the trigger refuses the
row and the only UI path (`createExpenseAction`) calls create-and-approve in one transaction.

## Grounding — read as requirements, not design (bible §1.2b)

**From this project's own decisions:**

- **Row 126** — *"An UNVERIFIED sales day records no revenue... Verification is what posts."* This
  task applies the identical rule to the identical shape. `sales_days` (`open → submitted →
  verified → voided`) is the precedent to copy, not to reinvent.
- **Row 122** — *"Capture is always allowed; VERIFICATION is what is withheld... Record the draft
  with its photo while memory is fresh; withhold posting. A growing pile of unpostable drafts is a
  more legible signal than a greyed-out button."* This task is the general case of what row 122
  already decided for the closed-period case.
- **Row 125** — a draft is **deleted**, not voided, and deleting it reuses `edit_own_expense` /
  `edit_any_expense`. *"A draft is not a financial record — no entry, no balance touched, nobody
  asserted it."*
- **DEF-057** — one paper receipt, many expenses, evidence attached once. Already fixed by T-130;
  this task must not regress it.

**From v1 (`ERP-rebuild`), as requirements:**

- The coupling is `canTagExpenseToReceipt` — `status === 'verified' && recordingStatus === 'open'`
  (`src/lib/financial/receipt/eligibility.ts:4-8`). v1 has **no draft expense at all**: an expense
  is written `status: 'posted'` immediately (`src/lib/actions/expense.actions.ts:627-648`), so v1
  cannot record anything before verification either. **This task is an `add`, not a `duplicate`.**
- **v1 has no `rejected` state.** `ReceiptPlain.status` is `'pending' | 'verified' | 'voided'`
  (`src/types/index.ts:449`); `receiptPolicy` has no `case 'reject'`
  (`src/lib/policies/policy.ts:120-136`); the `rejectionReason` field is written **only** by the
  void path, as the void reason (`src/lib/actions/receipt.actions.ts:627`). Void cascades through
  every linked expense and is permanent — `reviveReceiptAction` was deliberately removed:
  *"Voiding is now permanent — re-enter a new receipt instead"* (`receipt.actions.ts:651-653`).
- ⛔ **Two v1 bypasses that must NOT be reproduced,** both logged here because they are the exact
  shape this task could accidentally recreate:
  1. **Recurring expenses skip the gate entirely** — `recurring-expense.actions.ts:345-368` and
     `:750-769` write to the expenses collection directly, never call `upsertExpense`, never set a
     `receiptId`, and never reference `needReceipts`. A detective scan exists solely to find what
     leaks through (`src/lib/ai/integrity/detect.ts:137-167`).
  2. **Delivery/commissary flows self-verify** — `delivery-expense.actions.ts:180-221` writes
     `status: 'verified'` straight onto the receipt so a cashier-run flow satisfies the eligibility
     predicate *"without its manager-only gate"*, in that file's own words.

  In v2 both are structurally impossible and must stay so: the DB trigger has no code path around
  it, and `verified_by <> created_by` is a CHECK constraint.

## Goal

A cashier records what they spent, against the paper they are holding, in one screen, with no
manager present and no verification wait. Nothing reaches the ledger until a second person
verifies the invoice — and that act posts every draft standing against it.

## Scope — the exact files this task may touch

**Migrations** (`packages/db/migrations/`)

- ONE new migration replacing the trigger function `expenses_check_invoice_open_for_recording()`.
  ⚠️ **Take the next free index at implementation time; this spec deliberately does not pin a
  number.** As of 2026-08-31 the highest is `0111_t197_short_shift_default_on` (T-197, another
  lane, already applied to `shareat_dev`), so this task takes **0112 or later** — and its `when`
  must be **strictly greater** than 0111's, not merely different. ⛔ **DEF-039 / DEF-091:** a
  reserved number block that reserves numbers but not timestamps makes Drizzle **silently skip**
  the migration — no error, no row. `packages/db/tests/migration-journal.test.ts` is the guard;
  run it. Never edit `0043`.

**`packages/db/src/repo/`**

- `ap.ts` — `assertOpenForRecording` (`:373`) gains the target status; `liveExpensesForInvoice`
  (`:323`) must return each expense's `status`, not only its `id`.

**`packages/domain/src/`**

- `expenses/create.ts` — the `assertOpenForRecording` call at `:111`.
- `ap/index.ts` — `verifyInvoice` (`:437`), `voidInvoice` (`:512`), `recordExpenseForInvoice`
  (`:564`).

**`apps/erp/src/app/`**

- `expenses/new/page.tsx` — the invoice picker and its now-stale "posts immediately" copy (`:36-39`).
- `expenses/actions.ts` — `createExpenseAction`.
- `ap/invoices/[id]/page.tsx` — the verify screen must show what it is about to post.

**Tests** — `packages/domain/tests/integration/expenses.test.ts`, the AP integration suite, and the
app-boundary suite if a new import crosses a package.

⛔ **Out of bounds:** `PROJECT_BIBLE.md` (§14 — the row-170 amendment is the planner's, made with
this spec, not the implementer's), `postEntry`, `reverseEntry`, the journal triggers, the
capability set, and the four attestations.

## Contract

### 1. The trigger — the gate moves from existence to posting

Replace the function body. The new rule, in order:

```
IF NEW.status = 'voided'  -> RETURN NEW          -- a void is never blocked by its parent
IF inv_status IS NULL     -> raise 'does not exist'
IF inv_status = 'voided'  -> raise 'is voided — nothing further may be recorded against it'
IF NEW.status = 'posted' AND inv_status <> 'verified'
                          -> raise 'is pending — a draft may stand against it, but it cannot
                                    post until it is verified'
-- capacity check: UNCHANGED
```

⭐ **The capacity arithmetic needs no change, and that is the point.** It already sums
`status <> 'voided'`, which includes drafts, so a pending invoice cannot be over-committed by
drafts any more than a verified one can be over-recorded by postings. This is v1's ₱1
`RECEIPT_FULLY_RECORDED_TOLERANCE` (`src/lib/financial/receipt/recording.ts:13`) already present in
v2 at a tighter ₱0.005, and it is why "one receipt, many expenses" survives the change for free.

⚠️ The early `RETURN NEW` on `'voided'` is load-bearing: `voidInvoice` voids linked expenses
**before** flipping the invoice, so today the invoice is still `verified` when the cascade runs. Do
not rely on that ordering continuing to hold.

### 2. `assertOpenForRecording` — the named error, mirroring the trigger

Signature gains the target: `assertOpenForRecording(tx, orgId, invoiceId, amount, target: 'draft' |
'posted')`. Its doc comment already says it *"mirrors the exact arithmetic of the hand-written
trigger"* — keep that true, message for message. `createExpense` passes `'draft'`; the approval
path passes `'posted'`.

### 3. Creating no longer posts

`createExpenseAction` calls `createExpense`, not `recordExpenseForInvoice`. The result is a draft.
`create_expense` alone is sufficient — which is the whole point of the task: **a cashier can now
record.**

`recordExpenseForInvoice` **stays**, unchanged, for the already-verified case (the embedded form on
`/ap/invoices/[id]`): a manager holding both capabilities against a verified invoice should not be
made to click twice. Two entry points, one posting path — `approveExpense` — and no second gate.

### 4. Verification posts every draft standing against the invoice

In `verifyInvoice`, immediately after `markInvoiceVerified` and **inside the same transaction**:
load the invoice's `draft` expenses oldest-first and call the existing `approveExpense` on each.

- **All or nothing.** If any draft fails to post — unmapped category, closed period, an office
  account that would go overdrawn — the whole verification rolls back with a message naming the
  offending expense. ⚠️ **Do not verify-and-skip.** A verified invoice carrying stuck drafts is a
  new orphan class, and the verifier is exactly the person who can fix the coding.
- **No new capability.** `approveExpense` authorizes `approve_expense`; `verify_supplier_invoice`
  and `approve_expense` are both manager-and-above, so the verifier already holds it. If a future
  role holds one without the other, the authorize call refuses — and that refusal is correct.
- **Segregation of duties is unchanged.** `verified_by <> created_by` is still a database CHECK,
  and the person who causes money to move is still the second person.

### 5. Voiding an invoice must handle drafts — a defect this change creates

`voidInvoice` cascades `liveExpensesForInvoice` (`status <> 'voided'`, so **drafts are already in
that list**) through `voidExpense`, which **throws on a draft**: *"nothing has been posted yet to
void; edit or discard it instead."* Once drafts can exist on a pending invoice, voiding one fails
outright.

Branch on the status the repo now returns:

| Child state | Action | Why |
|---|---|---|
| `draft` | `deleteExpenseDraft` | Row 125 — a draft is not a financial record; nothing to reverse |
| `posted` | `voidExpense` | Reversal entry; both entries stand |

Reuse both primitives rather than deleting rows inline — `ap/index.ts:21-26` records what happened
last time a cascade was hand-rolled (it silently skipped budget release, cash-request liquidation,
the expense-summary projection and a CAPEX depreciation guard). `edit_any_expense` and
`void_supplier_invoice` are both manager-and-above, so the cascade's actor is already authorized
for the delete.

### 6. The verify screen shows what it is about to post

`/ap/invoices/[id]` lists the draft expenses that verifying will post: category, account code,
particulars, amount, and the running total against the invoice total.

⭐ **Why this is in scope and not polish.** The four attestations — supplier, invoice, items, price
— assert that *the document is genuine*. Posting asserts that *the coding is right*: 5100 COGS vs
6500 Supplies vs 3200 owner's drawings, which drives the drawing limit and the tax treatment
(row 160). Those are different assertions, and one click is about to make both. **A fifth checkbox
is the wrong fix** — you cannot attest to what you cannot see, and the list is what makes the
existing four honest.

## Decisions taken — do not re-litigate

1. **No `rejected` status.** `voided` with a required reason is the single negative terminal, as in
   v1. A rejected and a voided invoice would need identical cascades and identical reporting; the
   difference would live in a word.
2. **Evidence stays unconditional.** v1's per-category `needReceipts` (`src/types/index.ts:217`) is
   **not** ported. It is exactly why v1 needs a detective scan for orphan expenses, and T-122 §5
   already reasoned this out: every expense in this module is external, so no photo, no posting.
   Genuinely paperless spend gets a signed petty-cash voucher, photographed — a document, which is
   what an imprest fund expects anyway.
3. **No clearing entry when the draft is created.** Cash leaves the drawer before the books move;
   the instrument for that is the till count (counted cash + held receipts = expected, row 128's
   imprest self-check), not a second journal entry per expense. ⭐ The gap is not created by this
   task — it is **narrowed** by it, because today the spend cannot even be drafted.
4. **Verification is all-or-nothing** (§4 above).

## Invariants

**Draft**

1. A draft expense may be created against a `pending` invoice by an actor holding only
   `create_expense`. No manager, no verification.
2. A draft expense may **not** be created against a `voided` invoice.
3. Drafts count against the invoice's capacity: drafts totalling more than the invoice total are
   refused by the trigger, not merely by the service.
4. A draft writes **nothing** to `journal_entries` or `journal_lines`. Proven by row count, not by
   reading the service.

**Posting**

5. `approveExpense` on a draft whose invoice is still `pending` is refused — by the service *and*,
   proven separately, by the trigger when the service is bypassed.
6. `verifyInvoice` posts every draft on the invoice, in one transaction, through `approveExpense`.
7. If one draft cannot post, the invoice stays `pending` and no draft posts.
8. A verified invoice never carries a draft expense. This is the invariant that makes §4's
   all-or-nothing rule checkable.

**Void**

9. Voiding a `pending` invoice with drafts attached **deletes** them and succeeds. *(This is the
   case that fails today.)*
10. Voiding a `verified` invoice with posted expenses reverses each; both entries stand.
11. Voiding an invoice carrying **both** a draft and a posted expense does both, in one
    transaction.
12. `verified_by <> created_by` still holds; posting through verification creates no path around it.

## Tests

Integration, against real Postgres (§9.3) — ⚠️ **check `ListAgents` before running
`test:integration`; concurrent agents truncate each other's fixtures (§3.4, row 94).**

1. Cashier with `create_expense` only → draft on a pending invoice → succeeds; zero journal rows.
2. Same actor calls `approveExpense` → refused, named message.
3. Raw `UPDATE expenses SET status = 'posted'` on a pending invoice's draft → **trigger** raises.
   *(The service check is a convenience; this is the control.)*
4. Drafts summing over the invoice total → refused at the trigger.
5. Manager verifies → every draft posts, `journal_entry_id` set on each, entries balance.
6. Verify with one unmapped-category draft → whole verification rolls back; invoice still
   `pending`; the other draft still `draft`.
7. Void a pending invoice carrying two drafts → both rows gone, invoice `voided`.
8. Void a verified invoice carrying one draft and one posted expense → draft deleted, posted
   reversed, both entries readable.
9. Creator attempts to verify their own invoice → still refused, by the CHECK.
10. `recordExpenseForInvoice` against a verified invoice → still posts in one call, unchanged.

Each of 2, 3, 4, 6 and 9 must be seen to **fail for the right reason** before the fix (§3.2).

## Out of scope

- **A `rejected` status** — decision 1 above.
- **Porting `needReceipts`** — decision 2. If Ian later wants per-category exemption it is its own
  task, and it needs the orphan detector v1 has.
- **OCR / the learning layer** — T-146, already parked by Ian: *"plan on adding this soon but for
  now stick with the roadmap."*
- **A forcing function bounding the unverified pile.** Row 126 bounds sales days by blocking the
  next report; the equivalent here would stop the store from buying. An aging view is the right
  instrument and v1 already proves the shape (`OpenItemsCard`, the receipts "Backlog" query) —
  worth doing, not here.
- **The close-readiness checker counting drafts — checked, and it does not: `DEF-117`.**
  `listFindings` (`packages/domain/src/findings/index.ts:56-78`) runs twelve detectors and not one
  counts a `pending` invoice or an unposted expense, so `closeReadiness` can report a period ready
  while unverified documents hold spend out of it. ⚠️ A draft whose invoice is verified after its
  period closes **cannot ever post** — `business_date` is forced from `invoice_date` and
  `postEntry` requires an open period — so this task raises the stakes on a hole that already
  exists. It is a cross-module call about close policy and belongs in its own task; ⛔ **do not
  fix it here, and do not let it block this task.**
- **Changing the two-person rule, the attestations, or any capability.**

## Done when

Bible §9, all of it: typecheck clean · unit tests pass · integration tests pass against real
Postgres · smoketested on 9008 with the dev server stopped before `npm run build` · self-reviewed
line by line · committed with a message saying *why* · and the twelve invariants above each proven
by a named test.

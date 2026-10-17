# T-266 — `MoneyLines`: one component for every peso that moves

> **Status: BUILT.** Used by `packages/domain/src/expenses/create.ts` and `edit.ts`, and by the `MoneyLines` component. Written 2026-09-11 in plan mode (CLAUDE.md's opusplan rule —
> a spec written as ordinary work gets Sonnet). Ian approved the design in chat the same day,
> including the four rulings in §11 — ⭐ note ruling 1, which **corrected this spec's own first
> draft** rather than merely approving it.
>
> ⭐ **Read §4 before writing a line.** This task is blocked on a posting defect that makes the
> headline feature impossible: an expense paid from a staff float **cannot post today**. The fix
> is small and the shape already exists one file over — but building the picker first would
> produce a component whose main new capability fails at approve with raw trigger text.

## Why this exists

v1 has a genuinely good money-out component — `ERP-rebuild/src/components/payments/PaymentSplitEditor.tsx`
(361 lines), mounted on **six** surfaces (expense editor, recurring-expense confirm, pay-slicer,
pay-staff payroll, salary advance, delivery-expense split). It simplifies the hardest question on
any money form — *where is this coming from* — by asking one question at a time and letting the
first answer decide the second.

v2 has no equivalent. `apps/erp/src/app/expenses/new/page.tsx:170-245` is a static 8-row table
(`PAYMENT_ROW_COUNT = 8`, `apps/erp/src/app/expenses/lib.ts:40`) with a free-text
`placeholder="cash_request id"` box, and ~20 other money screens each carry their own bare
`<select name="…MoneyAccountId">` under **four different field names** (`moneyAccountId`,
`fromMoneyAccountId`, `toMoneyAccountId`, `intoMoneyAccountId`).

`lib.ts:40`'s own comment already concedes the point: *"A proper add-a-row control is the real
answer; this raises the ceiling above the real-world shape in the meantime."* This is that task.

### Read v1 as requirements, not as design — §1.2d's four steps

1. **Study v1 at source.** Done — file map in §1.
2. **Write down the GOAL.** *A person recording spend should never have to know the chart of
   accounts, and should never be able to name a source of money that cannot actually fund it.*
3. **Count the live data.** `expense.split.cash-online` is the single most common shape in v1's
   whole dataset (`lib.ts:29-32`, Ian 2026-08-26: *"it is common in our set up to use more than 1
   account, for example an expense paid by partly cash cashier, cash online and office online in
   one single transaction"*). The need is proven; splits are the normal case, not the exception.
4. **Design v2 against that goal.** v1 achieves *half* of it — see §1's two flaws. v2 achieves
   both halves, because ADR-010 gave it a fact v1 never had: the account knows its own custodian.

---

## 1. What v1 gets right, and the two flaws to not carry over

⭐ **The thing worth copying is not the UI, it is that `getExpensePaymentRowState()` is pure**
(`ERP-rebuild/src/lib/financial/expense/payment-ui.ts:92-129`). Which fields a row shows is a
function of the row's own data, tested in `payment-ui.test.ts` without React. Keep that exactly.

⛔ **Flaw 1 — two copies of "what is allowed", and they have already drifted.** v1 decides the
method list in the editor (`expense-editor.tsx:603`, `enabledPaymentMethods`) *and* again in
`validateExpensePayments()` (`lib/financial/expense/payments.ts:189-208`). **`enabledPaymentMethods`
has exactly one occurrence in the file** — it is computed from `paymentSettings` and never passed
to `PaymentSplitEditor`, which receives only `canUseOnline`. So a store that set
`methods.creditEnabled = false` still shows *Credit (Supplier)* in the dropdown, and the user
learns it was disabled at save. *Verified by grep, 2026-09-11: `grep -n enabledPaymentMethods`
returns line 603 and nothing else.*

⛔ **Flaw 2 — the balance is never consulted.** `PaymentAccountPlain.currentBalance` exists
(`ERP-rebuild/src/types/index.ts:331`) and `buildPaymentAccountOptions()`
(`lib/financial/expense/payment-account-options.ts:17-60`) sorts by default-then-alphabetical and
never reads it. So v1 will happily let you pay ₱40,000 from an account holding ₱300. *Verified:
`grep currentBalance` over that file returns nothing.*

⚠️ **What v1 DOES get right on balances is the cash-request list** — `buildCashRequestPickerOptions()`
(`lib/financial/cash-request/picker-options.ts:18-31`) filters to `remainingAmount > 0` and labels
each option with the balance. That behaviour is **kept**, re-derived from the ledger (§7).

⭐ **So the architecture is one pure rule module called by both the component and the server
action** — never a validator that mirrors a view. That is the whole lesson of flaw 1.

---

## 2. Contract — the files this task may touch

| File | What |
|---|---|
| `packages/domain/src/shared/money-lines.ts` | 🆕 **The pure rules.** No DB, no React. Which methods are offered, what each line requires, whether a set of lines is complete. |
| `packages/domain/src/shared/money-lines.test.ts` | 🆕 Unit tests for the above. |
| `packages/domain/src/expenses/routing.ts` | ⛔ **§4 — the 1120 party fix.** |
| `packages/domain/src/index.ts` | Export the new module. |
| `packages/db/src/repo/money-accounts.ts` | 🆕 `balancesFor()` — one `GROUP BY`, replacing the N+1 (§9.3). |
| `packages/db/src/repo/cash-requests.ts` | Nothing new — `openFloats` + `floatsByRequest` already exist. |
| `packages/db/schema/suppliers.ts` | 🆕 `credit_terms_days` (§5). |
| `packages/db/schema/expenses.ts` | `cash_request_id` text → uuid FK (§4.4). |
| `packages/db/migrations/0141_t266_money_lines.sql` | 🆕 **Hand-authored** — ADR-012 §5. |
| `apps/erp/src/lib/money-lines/load.ts` | 🆕 Server loader: options + balances + eligibility. |
| `apps/erp/src/components/money/MoneyLines.tsx` | 🆕 The client island. Renders only. |
| `apps/erp/src/app/expenses/new/page.tsx` | Mount it. |
| `apps/erp/src/app/expenses/[id]/page.tsx` | Mount it. |
| `apps/erp/src/app/expenses/actions.ts` | Parse the new field shape; re-validate with the same pure module. |
| `apps/erp/src/app/expenses/lib.ts` | ⛔ Delete `PAYMENT_ROW_COUNT` / `PAYMENT_ROWS`. Scope the picker (§9.2). |
| `tests/unit/money-lines-*.test.ts` | 🆕 |
| `tests/integration/expenses-staff-float.test.ts` | 🆕 **§4's closing test.** |

⛔ **Not in scope, and named so nobody widens it:** the other 20 mount points (§10 → T-267), any
money-in mount, `apps/pos`, and `PROJECT_BIBLE.md` (RULES rule 14 — report, do not amend).

---

## 3. The component

```
packages/domain/src/shared/money-lines.ts    pure rules — imported by BOTH sides
apps/erp/src/lib/money-lines/load.ts         server — needs a tx for balances
apps/erp/src/components/money/MoneyLines.tsx client — 'use client', no fetching
```

⚠️ **The loader is server-side because balances are derived, never stored.** There is no
`balance` column and there must never be one — `packages/db/src/repo/money-accounts.ts:10-14`
carries the reason in full (v1's AP control says ₱669,829.84 while its own subledger sums to
₱1,567,980.87). So the component takes a **prepared payload as props**, exactly as
`money-transfers/RecordTransferForm.tsx:6-9` already documents for the same reason: *"a plain
function cannot cross the server/client boundary as a prop"*.

### 3.1 The line model

```ts
export type MoneyDirection = 'out' | 'in';

export interface MoneyLine {
  method: MoneyLineMethod;
  amount: string;              // ⚠️ string, always — parseMoneyInput owns it (T-260/DEF-272)
  moneyAccountId?: string | null;
  cashRequestId?: string | null;   // required when the account's custodian is 'staff'
  staffId?: string | null;         // required for 'reimbursable'
  referenceNo?: string | null;     // DEF-067 — per LINE, not per document
  notes?: string | null;
}
```

⭐ **`referenceNo` closes DEF-067** while we are here, and it is one nullable column on a table
this task is already migrating. DEF-067's own note: *"a reference is only capturable at entry
time — nobody reconstructs it a month later"*, and on a three-way split there are three different
references. `notes` comes with it for the same reason (v1's `PaymentSplit` carries both).

### 3.2 What each method asks for

| Method | Direction | Needs | Posts to |
|---|---|---|---|
| `cash` | out / in | money account (custodian `cashier`/`office`/`staff`) | `1110`/`1130`/`1120` by custodian |
| `online` | out / in | money account (instrument `ewallet`/`bank`) + reference | `1140`, party = the account |
| `credit` | out | supplier with `credit_terms_days` set | `2110`, party = supplier |
| `reimbursable` | out | staff person | `2130`, party = the person |
| `store_credit` | in | customer | existing AR credit path |
| `offset` | in | the charge being offset | existing AR path |

⛔ **`other` and `ar_collection` are NOT offered** (Ian's ruling 2, §11). They are in the enum
(`schema/expenses.ts:208-210`) and stay there for ETL'd history, but `routeExpense` blocks them by
design (DEF-054, `routing.ts:193-199`). v2's form currently offers them labelled
*"(DEF-054 — blocks posting)"* (`expenses/new/page.tsx:193-194`) — **offering a choice guaranteed
to fail is a trap.** Remove from the UI; the enum and the block are untouched.

---

## 4. ⛔ The blocker: a staff-float expense cannot post

**This is a v2 defect, found while specifying this task. File it in `DEFECTS-REGISTER.md`
section E before starting.** Verified at source 2026-09-11; not executed.

### 4.1 The failure

1. Account `1120` *Cash on hand — staff custodian* is seeded **`requiresParty: true`**
   (`packages/db/seed/chart-of-accounts.ts:133`).
2. The trigger `journal_lines_party_requirement` (migration
   `0007_subledger_party_on_line.sql:94-97`, function at `:67-91`) raises
   `account % (%) requires a party on every line, but none was given` when a requires-party
   account gets no party.
3. `routeExpense`'s `fundingLine` attaches a party **only** when the code is `1140`
   (`packages/domain/src/expenses/routing.ts:151`).
4. So a cash payment from the *Staff float* account credits `1120` with no party → **the trigger
   raises and the expense does not post.**

⛔ **The comment directly above that branch is what made this invisible.** `routing.ts:149-150`:
*"Only 1140 is ambiguous — one control account for every wallet — so only it needs the party.
1110/1120/1130 ARE the location, and the trigger refuses a party on them."* That is true for
`1110` and `1130` and **false for `1120`**, which is seeded the other way precisely because one
staff-float account per store serves many people at once.

⚠️ **A reader who trusts that sentence will not check the seed.** This is DEF-172's lesson in
another file: *a function name — or here, an asserted rule — in a comment is trusted and rarely
re-derived.*

### 4.2 The second-order consequence, which is worse

Even if the line posted, `floatPositionOf`'s `spent` bucket selects on
`jl.party_type = 'cash_request'` (`packages/db/src/repo/cash-requests.ts:18, 137-167`). A
party-less line is in neither `spent` nor any other bucket, so:

- `outstanding` never falls → the float never reaches zero
- `cash_requests.status` never reaches `liquidated` — which `schema/cash-requests.ts:38-40` says
  is *"reached by ARITHMETIC"*
- DEF-159's liquidate-before-new-float gate (`cash-requests/index.ts:199-209`) then refuses that
  person **every future float, permanently**

⭐ So the fix is not cosmetic: without it, the headline feature of this component silently
bricks a person's ability to hold a float ever again.

### 4.3 The fix — a shape that already exists one file over

`releaseCashRequest` does it correctly at `packages/domain/src/cash-requests/index.ts:241-249`:

```ts
// ⭐ The party is the REQUEST. One staff-float account per store and two people able to
// hold floats at once means the ACCOUNT cannot decompose itself
{ accountCode: STAFF_FLOAT_CODE, storeId: req.storeId, debit: amount,
  partyType: 'cash_request' as const, partyId: req.id },
```

In `fundingLine`'s `cash`/`online` branch, replace the 1140-only party with:

- `1140` → `partyType: 'money_account'`, `partyId: moneyAccountId` *(unchanged)*
- `1120` → `partyType: 'cash_request'`, `partyId: cashRequestId`
- `1110` / `1130` → no party *(unchanged)*

And **block with a named reason** when the resolved GL code is `1120` and no `cashRequestId` was
given — the same discipline as the `credit`-without-supplier block at `routing.ts:161-165`:

> `payment #N: this is paid from a staff float, which belongs to a specific person — name the
> cash request it draws down, or the float can never be liquidated`

⚠️ **Correct the comment at `routing.ts:149-150` in the same edit.** Leaving it would re-plant the
exact assumption that hid the defect.

### 4.4 `expense_payments.cash_request_id` becomes a real FK

`schema/expenses.ts:232-236` says: *"Opaque text, not a FK — cash requests are not yet a table in
this schema (their own future task…)"*. ⚠️ **That comment is stale.** `cash_requests` has existed
since migration `0034_t144_cash_requests.sql` (T-144). A text column pointing at a uuid PK means a
typo is storable, and this task is about to make that column load-bearing for posting.

Migrate to `uuid … references(cash_requests.id, { onDelete: 'restrict' })`. ⚠️ Check for existing
rows first — a non-uuid value in there fails the cast and the migration must say so rather than
silently dropping it.

---

## 5. Credit — `suppliers.credit_terms_days`

Neither v1 nor v2 models *"does this supplier accept credit?"*. v1 has
`SupplierPlain.paymentOptions` (`ERP-rebuild/src/types/index.ts:431`), a **comma-separated free-text
list** written by `supplier-editor.tsx:64` and read by exactly one thing — a details page that
prints it (`supplier-details-client.tsx:370`). No logic anywhere consults it. v1's only real check
is *a supplier is selected* (`payments.ts:268-274`).

**One nullable integer on `suppliers`:**

```ts
creditTermsDays: integer('credit_terms_days'),   // NULL = cash/online only
```

- `NULL` → *Credit (AP)* is **offered but disabled**, with the reason naming the supplier:
  *"San Miguel is cash-on-delivery. Set payment terms on the supplier to pay on credit."*
- a number → enabled, and `invoiceDate + N days` pre-fills the due date

⭐ One field answers both *may we?* and *due when?*. It also retires v1's dead `paymentOptions` and
its unused `lastCreditDueDays` in one move.

⚠️ **Max one credit line per document** — v1's rule (`payment-config.ts:66`
`allowMultipleRows: false`, enforced at `payments.ts:169-174`), kept. Two AP lines on one expense
are two payables the subledger cannot tell apart.

---

## 6. The account picker — the part that earns the task

### 6.1 Grouped and badged, never filtered

Ian's ruling, 2026-09-11. **No account is ever hidden.** Three groups, re-computed live as the
amount changes:

```
Paid from  ▾
── Covers ₱3,500 ──────────────────────
  Office cash        office      ₱42,180
  Cashier GCash      cashier     ₱ 9,050
── Has funds, short ───────────────────
  Cashier cash       cashier     ₱ 1,200   ⚠ short ₱2,300
  Ana Cruz           float       ₱ 1,240
  Ben Reyes          float       ₱   380
── Empty ──────────────────────────────
  Office BPI         office      ₱     0
```

⭐ **Open floats are FLAT in this list, not behind a second step** (§7). Ana sits next to Office
cash because she is the same kind of thing: a holder under a control account.

⛔ **Why not a hard filter**, though it would give a shorter list: a cashier drawer's ledger
balance is *provisional*. `overdraft.ts:10-14` states it plainly — a sales day posts only at
verify, so *"a drawer that reads ₱0 at 2pm may hold ₱40,000"*. A filter on coverage would hide the
correct answer most afternoons and teach people to work around the form.

### 6.2 ⭐ The inline verdict is `judgeDraw()` itself

`judgeDraw()` (`packages/domain/src/money-accounts/overdraft.ts:46-127`) is pure, takes
`(account, available, drawn)`, and returns `{ blocked, message }`. **The component calls the same
function `approveExpense` calls** (`approve.ts:150`), and renders its `message` verbatim.

So the user reads, at entry time, the exact sentence approval will give them:

> *"Cashier cash" is short ₱2,300 against the books (holds ₱1,200, this takes ₱3,500). That is
> expected while today's sales are unverified — the cash is in the till before it is in the
> ledger. If the day IS verified, the drawer is genuinely over-spent and needs counting. Allowed
> down to −₱5,000.*

⭐ This is the single biggest win in the task and it costs one import. `overdraft.ts:21-27` already
argues for exactly this: *"Two callers take money out of an account … and the rule has to be
identical in both, or the same act becomes legal on one screen and refused on the next."* The
**form** is now a third caller of the same rule, rather than a fourth opinion.

⚠️ **A warning is not a block.** `judgeDraw` returns `blocked: false` with a message for an
unverified till. The component must render that as amber-informational and **must not** disable
submit — the whole point of `overdraft.ts:88-89` is that it is *"a 'look at this', not a 'you are
wrong'"*.

### 6.3 ⭐ Summed per ACCOUNT across lines, not per line

`approve.ts:137-146` already does this and names the reason: *"Two ₱600 cash lines against one
₱1,000 drawer are individually affordable and together are not — checking them one at a time would
let exactly that through (the DEF-065 family of error: a split's rows are only ever right when
considered together)."*

⛔ The component must aggregate identically. A preview that checks each line alone would show green
and then be refused at approve, which is worse than no preview.

### 6.4 Store scoping

Default to the document's store. Other stores' accounts appear in a separate, collapsed group
labelled **"Another store — needs `transfer_funds`"**, because that is the real rule:
`approve.ts:111-121` authorizes `transfer_funds` on the *account's* store when it differs, with
the reasoning *"An expense at Lipa paid from Malvar's safe moves Malvar's money just as surely as
a transfer does."*

See §9.2 — today the picker is unscoped and shows every store's accounts to everyone with no hint.

---

## 7. A float is a holder under a control account, exactly like a wallet

**Ian's ruling 1, restated 2026-09-11 after he supplied the better framing.** He described the
model unprompted and it is the one the ledger already implements:

> *"online gcash bpi bdo are separate accounts but they are all online, so ana, ben and joy are
> staff accounts and they are all staff float"* — Ian, 2026-09-11

### 7.1 ⭐ The parallel is exact, and it is the whole design

| | GL line | Holders | Party names |
|---|---|---|---|
| Online | `1140` | GCash · BPI · BDO | which **wallet** (`party_type='money_account'`) |
| Staff float | `1120` | Ana · Ben · Joy | which **float** (`party_type='cash_request'`) |

⭐ **`1140` and `1120` are the only two cash-side accounts in the chart seeded
`requiresParty: true`** (`packages/db/seed/chart-of-accounts.ts:133, 139`), and they carry the flag
for the identical reason: one line on the balance sheet, many real holders underneath.

⚠️ So the **office safe and cashier drawer are the odd ones out**, not the float. Those two are
single physical places — the line IS the location, and a party on them is refused by the trigger.
`schema/money-accounts.ts:53-58` already says this in as many words: *"`staff` is PLURAL where the
other two are singular — one drawer, one safe, but many people each holding their own float."*

⛔ **§4's defect is precisely that the code learned half of this rule.** It handles the wallet half
and assumed the other direction for all cash. Two of three, right.

### 7.2 The one difference: a wallet is permanent, a float is an episode

GCash exists whether it holds ₱9,050 or ₱0 — nobody ever *finishes* a wallet. A float starts at
release and **stops existing** at liquidation; `schema/cash-requests.ts:5-9` puts it exactly:
*"This holds **zero** between requests."*

⭐ **That is why a wallet's identity lives in `money_accounts` and a float's lives in
`cash_requests`** — and why the request stays the party. **Ian's ruling, 2026-09-11: keep the
request as identity.** Three costs avoided:

1. **Liquidation is per-REQUEST, not per-person.** `floatPositionOf` closes one request by
   arithmetic (`repo/cash-requests.ts:137-167`). Attached to a person instead, *"was March's float
   ever settled?"* becomes a date-range slice of that person's account, hoping nothing overlapped.
2. **Every picker on every screen grows forever.** ~20 money screens list accounts; a row per staff
   member plus every retired float clutters payroll, transfer and remittance pickers with floats
   nobody can pay from.
3. **Creating an account needs `manage_chart_of_accounts`** (`money-accounts/index.ts:81`). Floating
   a new kitchen hand would need an admin to set their account up first; today the request just
   names them.

### 7.3 ⭐ So the picker is FLAT — no second step

Nobody picks *"Online"* and then picks GCash. They pick GCash. Open floats are therefore top-level
options in the one account list (§6.1), labelled by **person**, valued by **outstanding**, and
storing the **request id** underneath. The user never sees or types an id.

⚠️ **The label-vs-storage split is safe because the two are 1:1 at any instant.**
`releaseCashRequest` refuses a second float while one is open for the same person
(`cash-requests/index.ts:199-209`, DEF-159's gate), so *"Ana Cruz"* resolves to exactly one open
request. ⛔ **If that gate is ever relaxed, this label becomes ambiguous** — leave a comment at the
loader saying so, because the picker would silently start showing two identical rows.

- Source: `cashRequestsRepo.openFloats()` + `floatsByRequest()`
  (`packages/db/src/repo/cash-requests.ts:207-216`, `:170-204`) — **already built, already
  batched**, no N+1.
- Filter to `outstanding > 0` — v1's rule (`picker-options.ts:22`), kept, but read from the ledger
  rather than from a stored `remainingAmount` column v2 deliberately does not have
  (`schema/cash-requests.ts:16-17`).
- `amount > outstanding` → inline error. v1 does this too (`payments.ts:218-224`).
- ⚠️ **Do not offer the aggregate `Staff float` foundation row.** Its `balanceOf` sums *every*
  float at the store (a non-1140 account matches on store + code, `repo/money-accounts.ts:279-304`)
  — ₱1,620 belonging to nobody. It resolves the GL code for the payment row; it is not a choice.

### 7.4 What this replaces in v1

v1 asks three questions — method **Cash** → sub-account `cashier`/`staff`/`office` → which request.
Step 2 reads `CASH_SUB_ACCOUNTS` (`payment-config.ts:125-129`), a **hardcoded three-row constant**
role-filtered in the component (`PaymentSplitEditor.tsx:90-92`). v2 asks **one**, and the list is
per-store data rather than a constant — DEF-058's *"the owner belongs to the ACCOUNT"* carried to
its conclusion.

---

## 8. Money-in — `direction="in"`

Same component, same split UI, same add-a-line. What flips:

| | `out` | `in` |
|---|---|---|
| Overdraft | `judgeDraw()` preview | ⛔ **none** — money arriving cannot overdraw |
| Gate | may this actor *draw from* this account | may this actor *collect into* it |
| Online | reference optional | ⭐ **proof of payment required** |
| Methods | cash · online · credit · reimbursable | cash · online · store credit · offset |

⭐ The proof-of-payment rule is not invented here — `recordCollection` already enforces it
server-side (`packages/domain/src/ar/index.ts:251-254`). The component surfaces a rule that
exists.

⚠️ **v1's money-in is a much poorer component than its money-out**: `ArPaymentFields.tsx`
(181 lines) is two methods, **one line, no split at all**, plus a proof upload and a manager
verification gate. Three surfaces share it (manager AR page, cashier single-receipt, cashier
date-range). That asymmetry — a rich split editor for spending, a flat form for collecting — is
the gap `direction="in"` closes.

⛔ **Sales money-in is explicitly NOT a mount point.** It is derived from the verified sales day
(`sales-days/verify.ts`), never picked by a person. Mounting a picker there would invent a choice
that must not exist.

---

## 9. Findings to file before starting

### 9.1 ⛔ DEF-new — staff-float expense cannot post
§4. Section E (Shareat System's own defect). Severity ⛔: the feature is unreachable and the
second-order effect permanently locks a person out of future floats.

### 9.2 🔸 DEF-new — the money-account picker is unscoped
`listMoneyAccountsForPicker` passes `{}` to `listMoneyAccounts`
(`apps/erp/src/app/expenses/lib.ts:191-202`, the call at `:195`), and `listMoneyAccounts`
(`packages/db/src/repo/money-accounts.ts:111-128`) takes no actor and applies no role filter. So
**every account in the org, at every store, is offered to everyone**.

⚠️ **Severity is 🔸 and the reason matters — state it this way.** This is **not** a control hole.
`approve_expense` is manager-and-above (`CAPABILITY-MATRIX.md:50`, staff ✗) while `create_expense`
is staff-inclusive (`:46`), so a staff member can only produce a *draft* naming the office safe;
and a cross-store draw is additionally gated at `approve.ts:120`. The cost is that a staff member
at Lipa is offered Malvar's safe with no hint, and finds out only when a manager's approval is
refused.

⚠️ It does mean DEF-058's *"a cashier cannot route cash to the office drawer because the office
safe is an account they are not offered"* is not literally true at the picker today — the gate is
real but it lives at approve, not in the list. Worth recording so the next reader does not trust
the stronger phrasing.

### 9.3 🔸 DEF-new — `moneyAccountsFor()` is an N+1
`apps/erp/src/app/ap/lib.ts:132-140` maps `balanceOf()` over every account — one query per
account. ⭐ It is also the **only** existing screen that shows a balance in an account picker
(`ap/suppliers/[id]/page.tsx:258-264` renders `{peso(w.balance)}`), so it is the precedent this
task generalises. Replace with a single `balancesFor(orgId, storeId)` `GROUP BY` in
`repo/money-accounts.ts`, modelled on `custodianPositions` (`:230-268`), and point both at it.

### 9.4 ⚠️ CAPABILITY GAP — nothing settles a reimbursable
`payReimbursement` shipped with T-208 (`packages/domain/src/expenses/reimbursement.ts`) and
`reimbursablePayableAgeing` watches `2130` — but **no screen in `apps/erp` calls it**
(`grep -rln payReimbursement apps/erp/src` → no hits, 2026-09-11). Staff-paid reimbursables
accumulate, age, and there is no way to pay anyone back. → `docs/CAPABILITY-GAPS.md`, and it is a
natural T-267 mount (§10).

---

## 10. Mount census — 21 surfaces

Counted by `grep -rn 'name="[a-zA-Z]*[Mm]oneyAccountId"' apps/erp/src/app --include=*.tsx` plus
the domain function each screen's `actions.ts` calls. **This task mounts only the first row.**

### Money OUT — 13
| Surface | Domain fn | Note |
|---|---|---|
| **`expenses/new` + `expenses/[id]`** | `createExpense` / `approveExpense` | ⭐ **built here** — the only true multi-split surface |
| `ap/suppliers/[id]` | `recordPayment` | already shows balances — §9.3's precedent |
| `cash-requests/[id]` | `releaseCashRequest` | `fromMoneyAccountId` |
| `loans/[id]` | `recordLoanPayment` | `fromMoneyAccountId` |
| `liabilities/[id]` | `payLiability` | `fromMoneyAccountId` |
| `owners/[id]` | `recordDrawing` | `fromMoneyAccountId` |
| `payroll` | payroll payout | `moneyAccountId` |
| `payroll/separations` | final pay | |
| `payroll/thirteenth-month` | 13th month | |
| `trade/returns` | customer refund | |
| `money-transfers` | `createMoneyTransfer` | ⚠️ from-side only; `TwoWayPicker` owns exclusivity |
| `expenses/recurring` | template default | ⚠️ a *default*, not a payment — single line, no amount |
| **reimbursement settlement** | `payReimbursement` | ⚠️ **§9.4 — screen does not exist** |

### Money IN — 8
`customers/[customerId]` (`recordCollection` — the reference case) · `channel-settlements` ·
`loans/[id]` disbursement (`intoMoneyAccountId`) · `owners/[id]` contribution · `cash-requests/[id]`
settle (`toMoneyAccountId`) · `remittance` · `inventory/returns` supplier refund ·
`money-transfers` to-side.

### ⛔ Not mountable
`money-accounts` (account admin, not a payment) · `settings/sales-channels` (config) ·
sales-day money-in (§8).

---

## 11. Ian's rulings, 2026-09-11

1. **A float is a holder under a control account, exactly like a wallet** (§7) — Ian's own framing,
   adopted. ⭐ **It replaced a weaker version of this spec**: the first draft had a two-step picker
   (*"pick Staff float, then pick whose"*). His parallel — *"ana, ben and joy are staff accounts
   and they are all staff float"* — collapses it to one, because nobody picks *Online* and then
   picks GCash.
2. ⭐ **Keep the cash REQUEST as the float's identity** (§7.2), while the picker labels it by
   person. Per-person rows in `money_accounts` were considered and declined for three named costs.
3. **Drop `other` and `ar_collection` from the picker** (§3.2) — enum and block untouched.
4. **File §9.2 and §9.3.**

Plus, from the design questions: grouped-and-badged over a hard filter (§6.1); `credit_terms_days`
as one nullable integer (§5); component + expenses first, the other 20 in T-267 (§10); one
component with a `direction` prop (§8).

---

## 12. Watch out

- ⚠️ **`amount` is a string end to end.** T-260/DEF-272: `Number('0.004') > 0` passes a guard and
  stores `0.00`. Every amount goes through `parseMoneyInput()`
  (`packages/domain/src/shared/money-input.ts`). ⛔ Do not add a client `min="0.01"` and call it
  validated — DEF-278 is exactly that mistake.
- ⚠️ **The client cannot be the gate.** RULES rule 7. Everything the component decides, the action
  re-decides by calling the same pure module.
- ⚠️ **`judgeDraw` is pure but `checkDraw` is not** — import the former into the client, never the
  latter (it takes a `Tx`).
- ⚠️ **The migration is hand-authored.** `db:generate` is retired and fails closed (DEF-242,
  ADR-012 §5). New table? No — but `suppliers` and `expense_payments` both change, and
  `classification.ts` / `rls/registry.ts` may need review.
- ⚠️ **Constraint messages** — any new CHECK needs a `CONSTRAINT_MESSAGES` entry or it reaches the
  user as raw driver text (DEF-246).
- ⚠️ **Stop the dev server before `npm run build`** (RULES rule 10). Port 9008 only.

---

## 13. Done when

- [ ] §4's defect filed in `DEFECTS-REGISTER.md` section E, and §9.2 / §9.3 / §9.4 filed
- [ ] `tests/integration/expenses-staff-float.test.ts` **watched failing first** with the trigger's
      own message, then passing — an expense funded from a staff float posts, credits `1120` with
      `party_type='cash_request'`, and `floatPositionOf().spent` moves by that amount
- [ ] A staff account chosen with no cash request **blocks with the named reason**, not a trigger
- [ ] `money-lines.test.ts`: method eligibility, per-account aggregation (§6.3), credit-terms gate,
      float-outstanding ceiling
- [ ] The action re-validates with the same pure module — proven by a test that posts a payload the
      component would never produce
- [ ] `PAYMENT_ROW_COUNT` / `PAYMENT_ROWS` deleted; add-a-line works with no ceiling
- [ ] Typecheck clean · unit green · **integration green against real Postgres** ·
      **smoketested on 9008** at 390px · `npm run build` exit 0 with the dev server stopped
- [ ] `FOR IAN` block: what changed, what needs a decision

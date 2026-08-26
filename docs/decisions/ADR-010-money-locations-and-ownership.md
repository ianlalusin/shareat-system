# ADR-010 — Money locations and ownership: one ledger, two views

| | |
|---|---|
| **Status** | 🔷 **PROPOSED 2026-08-26** — needs Ian. Nothing is built against it yet |
| **Answers** | Bible row 127's *"needs the research pass before Phase 3"*, and DEF-058's recorded resolution |
| **Blocks** | T-136 (cash custody), T-130/T-131 (AP/AR), and any module that names where money is |
| **Does not block** | T-125. Prepaid touches 1400, not a money location |

---

## The question, in Ian's words

> *"We do 2 levels of accounting here. The general one, the business-wide, where all cash whoever
> the owner is is business cash — the general accounting principle, the industry standard all
> business is using. And the other level curated to our needs, the one with these owners and
> divisions etc, for internal only. How can we model it cleanly?"*

**This is the right framing, and it has a standard answer.** Both levels are real, both are needed,
and they are **not two sets of books**.

---

## 1. The decision

> ⭐ **ONE ledger, TWO VIEWS. Never two ledgers.**
>
> A journal line records **where the money is**. Everything else about it — who holds it, which
> division, which store — is an **attribute of that location**, not a second transaction and not a
> second ledger.
>
> - **The general view** groups lines by GL account. All cash is business cash. This is the trial
>   balance any accountant recognises.
> - **The internal view** groups the *same lines* by the location's attributes. This is *"how much
>   is in the cashier's hands right now."*

Two views over one set of lines cannot disagree. **Two ledgers always eventually do** — and v1 is
already proving it: its AP control says ₱669,829.84 while its own subledger sums to ₱1,567,980.87,
and 34 of 115 account/store combinations disagree with a reconstruction from raw legs
(`docs/reviews/v1-audit-2026-08-24.md` §3, §5). That is what maintaining the same fact twice costs.

---

## 2. The rule that decides account vs attribute

The question *"should this be its own GL account, or a field?"* has a test, and it is not taste:

> ### Does it get reconciled against something outside the books?
>
> - **Yes → it is an ACCOUNT.** A cash drawer is counted. An office safe is counted. A GCash wallet
>   and a BDO account each have a statement. Each is a real place money sits, and each is
>   independently verifiable, so each earns a line on the balance sheet.
> - **No → it is an ATTRIBUTE.** Nobody reconciles "the cashier" or "the kitchen division" against
>   an external document. They are ways of *slicing* money that is already accounted for.

⚠️ **Ownership fails that test, and that is the whole insight.** *"Cashier's money"* is not a place
— it is a **property of the places**. The cashier holds a drawer and possibly a wallet; the office
holds a safe and possibly other wallets. So ownership is an attribute **of the account**, never a
tick on a transaction.

⭐ **This is already the recorded position.** DEF-058: *"The owner belongs to the ACCOUNT (bible row
127) — it should be derived, never ticked."* This ADR is that sentence worked out in full.

---

## 3. What is wrong today

v2 currently uses **two different mechanisms for one concept**, which row 127 already named:

| Money | How its location is recorded | How its owner is recorded |
|---|---|---|
| Cash | Three GL codes — `1110` cashier, `1120` staff float, `1130` office | ⚠️ **Baked into the account code** |
| Online | One GL code — `1140`, for every wallet that exists | ⛔ **Not recorded at all** |

Three consequences, all live today:

1. ⛔ *"How much online money is in the cashier's hands versus the office's"* **is unanswerable.**
2. ⛔ *"Which wallet did this ₱2,000 leave"* is unanswerable — every online payment posts to `1140`.
3. ⛔ Routing an expense's cash to the office drawer is a **free-text `accountCode: 'office'` flag**
   on the payment row with no gate, so a cashier can route cash away from their own till. v1
   refuses exactly this, by reading who owns the account (DEF-058).

---

## 4. The proposal — one table

A `money_accounts` table. **Every place money sits is a row**, cash and online alike.

| Column | Why |
|---|---|
| `id`, `org_id`, `store_id` | Standard spine |
| `name` | *"Cashier drawer"*, *"GCash — Lipa cashier"*, *"BDO — office"* — what staff call it |
| `instrument` | `cash` · `ewallet` · `bank` — what KIND of place it is |
| `gl_account_code` | Which GL account it rolls up into. **This is the general view** |
| ⭐ `custodian` | `cashier` · `office` — **the internal view.** Not nullable |
| `is_active` | Retire a wallet without deleting its history |

And the journal line names the location, using machinery **v2 already has and already proves**:
`1140` becomes a `requires_party` control account with the money account as its party — exactly how
`2110` already carries a supplier and `1230` an employee. No new mechanism, no new column.

### What each view then is

```
GENERAL  (the accountant's)   group journal_lines by account code
                              -> "Cash on hand 1110 … E-wallets 1140 …"

INTERNAL (Ian's)              join to money_accounts, group by custodian
                              -> "Cashier holds ₱18,400 cash + ₱6,200 online"
                              -> "Office holds ₱140,000 cash + ₱82,000 online"
```

Same lines. Nothing maintained twice.

---

## 5. What this changes, and what it deliberately does not

**Unchanged.** The chart of accounts keeps its shape — `1110`/`1120`/`1130`/`1140` all stay, and a
trial balance looks exactly as it does now. No account is renamed or retired. **A new wallet is a
new ROW, never a chart change** — which matters, because the chart is governed reference data
(bible §4.4) and should not move every time the business opens a GCash account.

**Changed.** `1140` starts requiring a party. Ownership becomes derivable, so the office-drawer
checkbox (DEF-058) is **deleted rather than gated** — the account already knows who owns it, and a
fact the system can derive should never be a thing a user can tick wrongly.

**Explicitly NOT doing three things:**

| Not doing | Why |
|---|---|
| A second ledger, or "internal" journal entries | The failure this ADR exists to prevent. Two ledgers drift, and v1 shows what that costs |
| One GL account per wallet (`1141`, `1142`, …) | Makes the chart grow with the business. v1's `online__{id}` did this and it is why every online account rolled up into one line in the audit anyway |
| Ownership on the transaction | It is a property of the place, not of the payment. Putting it on the transaction is what lets a cashier tick "office" |

---

## 6. What this does not yet answer

⚠️ **UNDEPOSITED FUNDS.** Money that has left the till but not reached the office is a real state
with a standard name, and **v1 has no account for it** (bible rows 127, 131 — and note row 131's
correction: *undeposited funds*, not *cash in transit*, which is a bank-reconciliation item). This
ADR makes the state expressible — it is a money location whose custodian is neither — but does
**not** decide whether to model it. That belongs with T-136 and its peso ceiling (row 129).

⚠️ **DIVISIONS.** Ian named divisions alongside owners. Divisions almost certainly fail §2's test —
nobody reconciles a division against an external document — so they are a **line dimension**, not a
location. But no division list exists yet, and inventing one here would be fabricating reference
data. Left open deliberately.

---

## 7. For Ian — what I need

1. **Is `cashier | office` the complete list of custodians?** The staff float (`1120`) is a third
   thing in practice: held by a named person, on their way to being spent or returned. v1's owner
   enum has no value for it, so it sits outside v1's ownership model entirely.
2. **Do you want one wallet per real account, or per provider?** *"GCash"* as one location, or
   *"GCash — Lipa cashier"* and *"GCash — office"* as two? §2's test says: however many things you
   reconcile separately.
3. **Divisions — what are they?** A list, and whether money is ever held *by* a division rather
   than merely spent *for* one. The answer decides dimension versus location.

⛔ **Nothing is built against this until it is accepted.** It touches the chart's contract and every
module that names where money is, so a guess here is expensive to unwind.

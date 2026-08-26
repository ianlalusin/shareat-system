# ADR-010 — Money locations and ownership: one ledger, two views

| | |
|---|---|
| **Status** | ✅ **ACCEPTED 2026-08-26.** Ian answered all three questions; §7 records them and what evaluating them turned up |
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
| ⭐ `custodian` | `cashier` · `office` · `staff` — **the internal view.** Not nullable. See §7.1: `staff` is plural, so its location is made specific by the line's party |
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

✅ **DIVISIONS — withdrawn, not deferred.** This draft reserved a decision on divisions as a
possible cost-centre dimension. §7.3 records Ian's clarification that "divisions" was the wrong
word for what he meant, so there is nothing left to decide.

---

## 7. Ian's answers, and what evaluating them found

### 7.1 Custodians are `cashier` · `office` · `staff` — and asking for `staff` exposed a real gap

> **Ian:** *"lets make it cashier office and staff so when money is in staff it can clearly be
> stated like petty cash given to a staff to buy something unliquidated yet. evaluate this"*

**Evaluated, and it holds — for a better reason than symmetry.** `staff` passes §2's test on its own
merits: an unliquidated float is a real place money sits, it is counted (the staff member has it or
they do not), and the chart already has the location — `1120 Cash on hand — staff custodian`. This
is not a third label added for neatness; it is a custody state the business already runs.

⭐ **It also fills a hole v1 left open.** v1's owner enum is `'cashier' | 'office'` only, so
`cash__staff` — the float account — **sits outside v1's ownership model entirely**: every other
`cash__*` account is treated as "not cashier-owned" without anything saying whose it is. Ian's
third value is the one v1 never had.

#### ⚠️ But `staff` is PLURAL, and that changes the design

`cashier` and `office` are singular per store — one drawer, one safe. **`staff` is many people, each
holding their own float.** So a flat `custodian = 'staff'` answers *"how much is out with staff"*
and **cannot** answer *"how much is Maria holding, unliquidated"* — which is the question Ian's own
sentence is asking, and the only one that makes a float accountable.

**Checked rather than assumed, and v2 currently cannot answer it:**

| Account | `requiresParty` | Consequence |
|---|---|---|
| `1230` Advances to employees | ✅ **true**, `party_type = employee` | Money a staff member OWES is attributable per person |
| `1120` Cash on hand — staff custodian | ⛔ **false** | Money a staff member HOLDS is **pooled anonymously** |

So the debt is per-person and the custody is not — which is backwards, because custody is the
state that comes first and the one somebody must be asked about.

> ### The resolution: `1120` becomes party-required, `party_type = 'employee'`
>
> The custodian says *what kind of place*; the party says *which one*. Where a custodian is
> singular the account alone is specific enough; where it is plural the party makes it specific.
> **This is not a new mechanism** — `1230`, `2110` and `2130` already work exactly this way.

⭐ **And it keeps the two staff states properly apart**, which v1 also gets right: `1120` is cash the
business still owns, sitting in someone's pocket; `1230` is money that person now owes. An
unreturned float moving `1120 → 1230` is custody becoming debt, and both being per-person is what
makes that transition legible.

### 7.2 A money account is per ACCOUNT, not per provider

> **Ian:** *"per account not per provider."*

*"GCash — Lipa cashier"* and *"GCash — office"* are **two rows**, not one row called *"GCash"*.
Exactly what §2's test predicts: two things reconciled separately are two locations. It also means
`custodian` can sit on the row honestly — one row per provider would have forced a single provider
to carry two owners, which is the shape that cannot be modelled.

### 7.3 "Divisions" was the wrong word — the question dissolves

> **Ian:** *"no division wrong choice of word i mean separation or segregation of accounts."*

✅ **Then there is nothing further to model.** Segregation of accounts by who holds them is precisely
what this ADR does — §4's `custodian` **is** the segregation. The earlier draft treated "divisions"
as a possible cost-centre dimension and reserved a decision for it; that decision is withdrawn, not
deferred. No department dimension is being added.

---

## 8. The model, settled

| GL | Location | `custodian` | What the line's party names |
|---|---|---|---|
| `1110` | Cashier drawer | `cashier` | — (one per store) |
| `1120` | A staff member's float | **`staff`** | ⭐ **`employee`** — which staff member |
| `1130` | Office safe | `office` | — (one per store) |
| `1140` | Each wallet or bank account | `cashier` or `office`, per row | ⭐ **the money account** — which wallet |

**The party slot always names whatever makes the location specific**, and each control account uses
it for its own natural entity — the pattern `2110`→supplier and `1230`→employee already established.

### Still open, and deliberately not decided here

⚠️ **UNDEPOSITED FUNDS.** Money that has left the till but not reached the office is a real state
with a standard name, and v1 has no account for it (rows 127, 131 — note row 131's correction:
*undeposited funds*, not *cash in transit*, which is a bank-reconciliation item). This ADR makes the
state expressible — it is a location whose custodian is none of the three — but whether to model it
belongs with **T-136** and row 129's peso ceiling.

### What builds against this

⛔ **The chart change (`1120` requiring a party) is a migration and a seed change**, so it lands with
**T-136**, not retrofitted now — nothing releases a float yet, so no anonymous `1120` data exists to
repair. Recording it here means T-136 starts from the right model instead of rediscovering it.

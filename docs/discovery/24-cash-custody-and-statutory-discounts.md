# 24 — Cash custody, till reconciliation, and statutory discounts

**Date:** 2026-08-25
**Unblocks:** T-123 §7 · T-136 §5 · bible rows 127, 128, 129
**Method:** vendor and standards documentation, plus ERPNext's own POS shift model. Sources linked
inline. **This pass exists because I recorded two conclusions without checking them** — one term
was wrong (§1) and one guess was right for the wrong reason (§4).

---

## 1. ⚠️ I conflated two different accounts. They are not the same thing

I wrote *"cash in transit / undeposited funds"* in rows 127 and 128 and in T-136 §1 as if the two
were interchangeable. **They are not:**

| | What it means | Whose records disagree |
|---|---|---|
| **Undeposited funds** | Money **collected and recorded**, not yet taken to the bank | *Our* books vs *physical location* |
| **Deposit in transit** | A deposit **we have recorded** that the **bank has not yet processed** | *Our* books vs *the bank's* books |

**Undeposited funds is the correct concept for Ian's cashier→office remittance.** Deposit-in-transit
is a **bank-reconciliation** timing item and has nothing to do with a till.
([AccountingCoach](https://www.accountingcoach.com/blog/deposit-in-transit) ·
[Sage](https://www.sage.com/en-us/blog/deposits-in-transit-bank-reconciliation/))

### ⭐ And it is precisely the pattern for pooled remittance

> *"Funds are 'in transit' for less than a day, as when a customer pays you with cash… Other times,
> funds might be in transit for several days. **This is most common when you batch your deposits —
> only going to the bank once or twice a week.**"*
> ([NerdWallet](https://www.nerdwallet.com/business/software/learn/undeposited-funds-in-quickbooks-online))

**That is Ian's request, described by a vendor as the ordinary case.** Row 128 is confirmed by the
field, not just reasoned.

### ⛔ But the warning attached to it is the important half

> *"The Undeposited Funds account in QuickBooks Online is one of the most misunderstood accounts —
> **and one of the accounts most likely to cause a business's financial statements to be
> incorrect.**"* ([NerdWallet](https://www.nerdwallet.com/business/software/learn/undeposited-funds-in-quickbooks-online))

**The failure mode is money piling up in it forever** because the deposit step is never performed —
an asset balance that looks like cash and is really a backlog of unfinished work.

> ⭐ **This retro-justifies Ian's own instinct in row 129.** The un-remitted ceiling is not belt-and-
> braces; it is the specific control against the specific way this account goes wrong in practice.
> **A pooled-remittance design without a ceiling is the QuickBooks failure with extra steps.**

**VERDICT: ADOPT undeposited-funds as the account, with the ceiling as its guard. Drop the phrase
"cash in transit" from our docs** — it names a different thing and would invite someone to
reconcile it against a bank statement.

---

## 2. ERPNext's POS shift model — finer-grained than v1, and worth copying

ERPNext splits the till into **POS Opening Entry** and **POS Closing Entry**
([Zikpro](https://zikpro.com/erpnextdocs/pos-opening-entry/) ·
[docs.frappe.io](https://docs.frappe.io/books/transactional-entries)):

| | ERPNext | v1 (`SalesDayPlain`) |
|---|---|---|
| **Granularity** | **Per cashier, per SHIFT** — *"separate entries for multiple shifts on the same day"* | Per **store**, per **day** |
| **Opening float** | Recorded per payment method at shift start | `openingBudget`, one figure |
| **Counting** | ⭐ **Denomination-level** — quantity of each note and coin | `countedCash`, a single number |
| **Reconciliation** | A table per payment method: **Opening · Expected · Closing · Difference** | Cash and online, less granular |

**Three things to take:**

1. ⭐ **Per cashier, per shift.** This is the custody control T-136 §1 depends on — *"a variance is
   attributable to one shift and one person."* **A per-store-per-day figure cannot do that when two
   cashiers worked.**
2. ⭐ **Denomination counting.** Entering *"3 × ₱1,000, 7 × ₱500…"* rather than a total makes a
   miscount visible and makes the count auditable. Cheap, standard, and v1 does not do it.
3. **Expected vs Closing vs Difference per payment method**, not just cash — which is exactly bible
   row 127's owner/instrument split doing reconciliation work.

**VERDICT: ADOPT all three.**

---

## 3. ⛔ But ERPNext does NOT solve the problem Ian named — it assumes it away

Ian's decisive argument for folding the handover to the ERP was that expected cash depends on
deductions POS cannot know: a cashier-paid expense, a released cash request, an AP payment from the
till.

**ERPNext's POS Closing Entry has no equivalent.** Its expected amount is
*opening + POS takings*, because ERPNext does not contemplate the till **paying** things — an
expense is paid from a cash account, not from the cashier's drawer mid-shift.

> ⭐ **So v1 is AHEAD of the reference system here.** The `less`/`plus` block models a real practice
> ERPNext handles by not permitting it. **Do not "simplify" it away by copying ERPNext** — that
> would delete the arithmetic that makes expected cash correct in this business.

**VERDICT: KEEP v1's `less`/`plus`, and treat ERPNext's shift model as the CONTAINER for it** —
per cashier, per shift, with the deductions v1 already tracks.

**And the same finding answers T-123 §7 question 4:** `coverageEvents` — *cash spent in place
rather than remitted* — has **no standard name**, because systems that forbid till-paid expenses
never need the concept. **v1 invented it because the business needs it. Port it as-is.**

---

## 4. ⭐ Senior/PWD: my guess was right, the reason was bigger than I thought

T-123 §2.3 said breaking out `seniorDiscount` and `pwdDiscount` *"is not decoration — they are
statutory categories."* **Correct, and understated.**

| Requirement | Source |
|---|---|
| ⛔ **A separate PWD discount LOGBOOK is mandatory** under RR 5-2017 — ID number, name, date, original amount, discounted amount, establishment signatory | [Lexology](https://www.lexology.com/library/detail.aspx?g=9b3a781c-049c-44be-9b95-720497af1f1d) · [Respicio](https://www.respicio.ph/commentaries/pwd-discount-requirement-for-small-non-vat-business-philippines) |
| **Sales to SC/PWD are VAT-EXEMPT**, and exempt vs taxable activity should be segregated in the books | [Respicio & Co.](https://www.lawyer-philippines.com/articles/vat-exemption-in-the-philippines-requirements-and-guidelines) |
| **One discount only** — a PWD who is also a senior claims one 20%, not both | [Taxify.ph](https://taxify.ph/blog/pwd-senior-citizen-discount-vat-exemption-philippines/) |
| **The burden of proof is on the seller** in a BIR audit | [Lexology](https://www.lexology.com/library/detail.aspx?g=9b3a781c-049c-44be-9b95-720497af1f1d) |

### ⛔ Two consequences that change what we have already decided

**(a) The logbook is PER TRANSACTION. A daily total cannot satisfy it.**
The ERP's sales day carries `seniorDiscount` and `pwdDiscount` as **daily figures**; the statutory
record needs the ID number and name **per sale**. **Only POS holds that.** So this is not an ERP
reporting feature — it is a POS capture requirement with an ERP reporting surface, and neither side
has it today.

**(b) The account treatment is contested, and we should not settle it alone.**
BIR guidance points establishments at an **"Expenses – PWD Discounts"** account under Selling &
Distribution Expenses — because the discount is a **deduction from gross income** for the
establishment. **We currently post discounts to 4900 Sales discounts (contra-revenue).**

> **This is a genuine tax-versus-financial-reporting tension, not an error in either place.** A
> discount granted reduces revenue for financial reporting; the same amount is a deductible expense
> for tax. ⚠️ **`docs/POSTING-PATTERNS.md`'s `sale.discount.senior-pwd` already says so honestly** —
> *"this discount reduces revenue for internal management reporting; it is not a BIR VAT-exemption
> computation and must never be presented as one."* **That disclaimer is doing real work and must
> not be quietly dropped when someone later wires VAT.**

**VERDICT: keep the daily split (it is required); flag the logbook as a NEW capability; take the
account treatment to Ian and an accountant — do not change 4900 on the strength of a blog post.**

---

## 5. Imprest — confirmed, and unchanged

The mechanism recorded in T-136 §2 is the textbook one and needs no revision: the fund holds a
constant book balance; the custodian requests replenishment for the amount disbursed; **the
replenishment entry debits the expense accounts named by the receipts and credits cash** — never
petty cash itself.
([AccountingCoach](https://www.accountingcoach.com/blog/imprest-petty-cash) ·
[principlesofaccounting.com](https://www.principlesofaccounting.com/chapter-6/petty-cash/))

**No ERPNext-specific imprest module surfaced** — it is bookkeeping practice over ordinary accounts
rather than a feature. **VERDICT: build it as practice, not as a module.**

---

## What NOT to adopt

1. **Deposit-in-transit as our account name** (§1) — a different concept; using it invites a bank
   reconciliation that does not apply.
2. **ERPNext's till model wholesale** (§3) — its expected-cash arithmetic is wrong for a business
   whose till pays out.
3. **Rewriting 4900 from a tax blog** (§4b) — the tension is real and the decision is Ian's with an
   accountant's input.

## What this changes

| Doc | Change |
|---|---|
| **Rows 127, 128 · T-136 §1** | ⚠️ *"cash in transit"* → **undeposited funds**. Different concept |
| **Row 129** | ✅ Confirmed by the field — the ceiling guards the exact documented failure mode |
| **T-136 §5** | Questions 1–3 answered. Imprest unchanged |
| **T-123 §7** | Q4 answered (`coverageEvents` has no standard name — port it). **Q3 escalates:** the PWD logbook is a mandatory per-transaction record nothing currently captures |
| **T-123 §2.3** | Confirmed statutory, and the split must stay |

## Open — for Ian

1. ⛔ **The PWD/senior logbook.** Mandatory, per transaction, with ID and name. **Does v1 or POS
   capture this anywhere today, or is it kept on paper at the store?** That answer decides whether
   this is a gap to build or a process to digitise.
2. **Senior/PWD discount account treatment** — contra-revenue (4900, current) or an expense account
   per BIR guidance. Worth one question to your accountant; it changes how the P&L reads.
3. **Per-shift or per-day till reconciliation?** ERPNext is per cashier per shift; v1 is per store
   per day. **Per shift is the stronger control** — but it is more work for the cashier, and you
   know whether two cashiers routinely share a day.

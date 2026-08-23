# Chart of Accounts — Alignment Map (v1 → Shareat System)

**Status:** Draft for Ian's review. Blocks task T-102.
**Date:** 2026-08-22
**Source:** `docs/discovery/07-chart-of-accounts-inventory.md` — 41 accounts and families
(28 fixed, 13 dynamic), extracted from `account-defs.ts:77-224` and the journal builders.

---

## How to read this

Every account you use today appears below with its v2 destination. **Nothing is deleted.**
Where a v1 account was non-standard, it maps to the standard account and keeps its old id
in `legacy_code`, so every historical reference still resolves.

| Marker | Meaning |
|---|---|
| ✅ | Already standard — maps essentially unchanged |
| 🔀 | Restructured — same economics, standard shape (usually control account + subledger) |
| ⚠️ | Misclassified or misplaced today — this is an alignment fix |
| 🆕 | No v1 equivalent — a genuine gap being filled |
| 🗑️ | Retire — the concept goes away because v2 handles it properly |

---

## 1. The five structural shifts

Before the table, the five changes that account for most of it:

1. **Per-counterparty accounts become control accounts + subledgers.** Today
   `ap__{supplierId}` *is* a GL account, so you have one GL account per supplier and
   "total AP" is just their sum with nothing to check it against. Standard practice: **one**
   AP control account in the GL, with per-supplier detail in a subledger that must
   reconcile to it. Same for AR, loans, assets, prepaids, advances. This is what would
   have caught the AP tile drifting for months.

2. **`others__*` are payment-method labels, not accounts.** Six of them are tags that got
   modelled as ledger accounts. Each becomes a real account of the correct *type* — some
   are contra-revenue, one is a liability, two are cash over/short.

3. **Operating expenses become real accounts.** Rent, utilities, supplies and the rest are
   currently *categories on expense documents*, invisible to the journal. They become
   nominal accounts (§4 below).

4. **Revenue and COGS get created.** They do not exist in any form today (§16.0).

5. **`expense__order_wastage` moves from operating expense to cost of sales.** That is the
   standard treatment and it will **change your reported gross margin** — the number gets
   more correct, not more flattering.

---

## 2. The mapping table

### Cash and equivalents

| v1 account | → v2 | Type | |
|---|---|---|---|
| `cash__cashier` | **1110** Cash on hand — cashier | Asset | ✅ |
| `cash__staff` | **1120** Cash on hand — staff custodian | Asset | ✅ |
| `cash__office` | **1130** Cash on hand — office | Asset | ✅ |
| `online__{paymentAccountId}` | **1140** E-wallet / online channels *(control)* + payment-account subledger | Asset | 🔀 |
| `clearing__grab` | **1221** Channel clearing — Grab | Asset | ✅ |
| `clearing__foodpanda` | **1222** Channel clearing — Foodpanda | Asset | ✅ |

*Clearing accounts are proper accounting terminology and yours are used correctly — money
in transit from a platform. Keep them, but they must be **monitored to zero**: an aging
balance in a clearing account means a settlement was never matched.*

### Receivables

| v1 account | → v2 | Type | |
|---|---|---|---|
| `ar__{customerId}` | **1210** Accounts receivable — **CONTROL** + customer subledger | Asset | 🔀 |
| `ar__channel_{id}` *(pseudo-customers)* | **1220** Channel receivable — **CONTROL** + channel subledger | Asset | 🔀 |
| `ar__{branchAsCustomer}` | **1250** Due from related store | Asset | ⚠️ |
| `supplier_advance__{supplierId}` | **1240** Advances to suppliers *(control)* + subledger | Asset | 🔀 |
| `staff_advance__{staffId}` | **1230** Advances to employees *(control)* + staff subledger | Asset | 🔀 |

⚠️ **A branch is not a customer.** Selling to your own branch is an inter-store transfer,
not revenue from a third party. Treating it as AR inflates both receivables and (once
revenue accounts exist) sales. It belongs in the due-from/due-to pair below.

### Inter-store — reciprocal accounts

| v1 account | → v2 | Type | |
|---|---|---|---|
| `asset__due_from_{storeKey}` | **1250** Due from related store *(by store)* | Asset | ⚠️ |
| `liability__due_to_{storeKey}` | **2150** Due to related store *(by store)* | Liability | ⚠️ |

⚠️ These two have **no seed factory at all** — they exist only because a partial merge-write
creates them, with no label, domain, or `tracksBalance` ever set. In v2 they are proper
accounts with a proper invariant: **total Due-from across all stores must equal total
Due-to.** They eliminate against each other. If they don't net to zero, an inter-store
transfer went missing — which is exactly the failure the current "fake distributed
transaction" is exposed to.

### Inventory 🆕 — the entire group is new

| → v2 | Type | |
|---|---|---|
| **1310** Inventory — raw materials / meat | Asset | 🆕 |
| **1320** Inventory — supplies and packaging | Asset | 🆕 |
| **1330** Inventory — prepped / commissary goods | Asset | 🆕 |
| **1340** Inventory in transit (branch orders) | Asset | 🆕 |

*Today stock is not an asset on your balance sheet and purchases are expensed on receipt.*

### Other assets

| v1 account | → v2 | Type | |
|---|---|---|---|
| `prepaid__{prepaidItemId}` | **1400** Prepaid expenses *(control)* + subledger | Asset | 🔀 |
| `asset__{assetId}` | **1510** Property and equipment *(control)* + fixed-asset register | Asset | 🔀 |
| — | ~~1520 / 1530~~ | — | **Intentional number gap. Ian, 2026-08-23: "1520 and 1530 don't need names, keep the gap."** Do NOT invent account names to fill it. Reserved room for future asset classes; a gap in a chart of accounts is normal and deliberate (§16.9 account lifecycle). Seeding fabricated names here would be worse than an empty range |
| `contra_asset__{assetId}` | **1590** Accumulated depreciation | Contra-asset | ✅ |

### Liabilities

| v1 account | → v2 | Type | |
|---|---|---|---|
| `ap__{supplierId}` | **2110** Accounts payable — **CONTROL** + supplier subledger | Liability | 🔀 |
| `ap__{commissaryMirror}` | **2150** Due to related store | Liability | ⚠️ |
| `staff_reimbursable__{staffId}` | **2130** Reimbursements payable to employees | Liability | ⚠️ **see §3** |
| `others__store_credits` | **2140** Customer store credits payable | Liability | ⚠️ |
| `liability__salaries_payable` | **2300** Salaries and wages payable | Liability | ✅ |
| `liability__loan_{loanId}` | **2400** Loans payable *(control)* + loan subledger | Liability | 🔀 |
| `liability__void_cash_suspense` | **2900** Suspense — void cash | Liability | ✅ |
| `liability__{key}` *(general)* | mapped case by case | Liability | ⚠️ |
| — | **2210–2250** SSS / PhilHealth / Pag-IBIG / withholding / VAT payable | Liability | 🆕 |

*A suspense account is legitimate, but a **permanent** balance in one is a red flag. v2
reports its age.*

### Equity

| v1 account | → v2 | Type | |
|---|---|---|---|
| `equity__capital` | **3100** Owner's capital | Equity | ✅ |
| `equity__opening_balance` | **3900** Opening balance equity | Equity | ✅ |
| — | **3200** Owner's drawings · **3300** Retained earnings | Equity | 🆕 |

*3900 is a migration account. It should net to **zero** once the opening balances are
loaded and reconciled — a leftover balance means the migration didn't balance.*

### Revenue 🆕 — none of this exists today
*Structure set by Ian 2026-08-22 from how the business actually sells.*

**The business:** unlimited samgyupsal. **Dine-in** = customers eating by group, either the
unli or à la carte. **Take-out** = always items / à la carte (samgyup sets, bento meals),
**never** unli. **Delivery is a mode of take-out, not a third channel.** Juice is free;
the beverages sold are canned soft drinks, milk drinks, and beer.

| → v2 | Type | | Note |
|---|---|---|---|
| **4100** Food sales — dine-in, **unlimited** | Income | 🆕 | The core product; deserves its own line |
| **4150** Food sales — à la carte | Income | 🆕 | **Includes dine-in à la carte, take-out AND delivery.** Ian 2026-08-23 |
| ~~4200 Food sales — take-out~~ | — | ❌ | **Withdrawn 2026-08-23 — folded into 4150.** POS cannot distinguish a seated à la carte diner from a counter take-out customer (à la carte sessions are table-less; there is no take-out flag at all), so the split would create an account the source data can never populate correctly. Recoverable via the `channel_id` dimension if ever wanted |
| **4400** Beverage sales | Income | 🆕 | **One lump account** — Ian, 2026-08-23. Soft drinks, milk drinks, beer |
| ~~4410 / 4420 non-alcoholic / alcoholic split~~ | — | ❌ | **Withdrawn 2026-08-23.** The licensing argument did not outweigh carrying a split the business does not want to maintain (bible §1.1). POS already aggregates `addonSalesAmountByCategory`, so splitting later is a reporting change, not a re-migration |
| **4900** Sales discounts *(contra-revenue)* | Contra-income | 🆕 | Senior / PWD — currently hardcoded to zero |
| **4950** Sales returns and voids *(contra-revenue)* | Contra-income | 🆕 | |

| v1 account | → v2 | State | |
|---|---|---|---|
| `others__points` | **4910** Loyalty points redeemed *(contra-revenue)* | **active** | ⚠️ |
| `others__voucher` | **4920** Vouchers redeemed *(contra-revenue)* | **reserved** | ⚠️ |
| — | **2145** Unredeemed vouchers *(liability)* | **reserved** | 🆕 |

**Why unli gets its own account.** It is a fundamentally different economic product from
à la carte: fixed price, variable consumption, and its margin moves with *how much people
eat* rather than with menu pricing. Blending it into one "food sales" line would hide the
single most important margin signal in the business.

**Points and vouchers — confirmed earned-and-redeemed, not sold.** So both are
**contra-revenue**: they reduce sales rather than acting as tender. Vouchers sit
**reserved** since they are not in use yet. If you ever *sell* vouchers, they become a
liability until redeemed — **2145** is pre-built and reserved for exactly that, so the
change is a flag flip plus one posting pattern, not a redesign.

**Free juice** needs no revenue account. Its cost is part of delivering the unli product
and flows naturally into COGS — which is correct, and is part of why unli margin needs
its own line to be readable.

#### Channel (Grab / Foodpanda / walk-in) is a dimension, not an account

Delivery folds into take-out for *revenue*, but you still need per-channel visibility —
platform fees differ, and you already run channel settlement.

**Do not split revenue accounts by channel.** That multiplies the chart and still cannot
answer questions that cross accounts. Instead, journal lines carry a nullable
**`channel_id`** dimension, populated on revenue and channel-fee lines. Channel P&L then
becomes a `GROUP BY`, exactly like store.

*This extends bible §16.4, which said store is the only dimension. One nullable column,
a real business need, no chart bloat — recorded as an amendment.*

### Cost of sales 🆕

| v1 account | → v2 | Type | |
|---|---|---|---|
| — | **5100** COGS — food · **5200** COGS — beverage | Expense | 🆕 |
| `expense__order_wastage` | **5300** Wastage and spoilage | Expense | 🔀 *moves from OPEX* |
| — | **5400** Inventory adjustment (count variance) | Expense | 🆕 |

### Operating expenses

| v1 account | → v2 | Type | |
|---|---|---|---|
| `expense__salary` | **6100** Salaries and wages | Expense | ✅ |
| `expense__salary_additions` | **6150** Salary additions and allowances | Expense | ✅ |
| — | **6110/6120/6130** Employer SSS / PhilHealth / Pag-IBIG | Expense | 🆕 |
| — | **6140** 13th month pay | Expense | 🆕 |
| `expense__platform_fee` | **6400** Platform and channel fees | Expense | ✅ |
| `expense__online_order_expenses` | **6410** Online order expenses | Expense | ✅ |
| `expense__depreciation` | **6700** Depreciation | Expense | ✅ |
| `expense__amortization` | **6750** Amortisation | Expense | ✅ |
| `expense__tax` | **6800** Taxes and licences | Expense | ⚠️ *confirm — see §3* |
| — | **6200** Rent · **6300** Utilities · **6500** Supplies · **6600** Repairs · **6900** Other | Expense | 🆕 *see §4* |

### Other income and expense

| v1 account | → v2 | Type | |
|---|---|---|---|
| `expense__interest` | **7200** Interest expense | Expense | ✅ |
| `expense__loss_on_disposal` | **7400** Loss on disposal of assets | Expense | ⚠️ **see §3** |
| `income__platform_settlement_gain` | **7100** Platform settlement gain | Income | ✅ |
| `income__charge_recovery` | **7310** Staff charge recovery | Income | ✅ |
| `income__wastage_recovery` | **7320** Wastage recovery | Income | ✅ |
| `others__remittance_overage` | **7350** Cash over and short | Income/Expense | 🔀 |
| `others__remittance_variance` | **7350** Cash over and short | Income/Expense | 🔀 |

*Standard practice is **one** "Cash over and short" account that swings either way, not a
separate account per direction. Netting them is how you see true till accuracy.*

### Retire

| v1 account | Why | |
|---|---|---|
| `income__wastage_writeoff_contra` | Half of a net-zero memo pair. In v2, wastage debits 5300 and credits 1310 — a real economic entry, no memo needed | 🗑️ |
| `others__others` | An unlabelled catch-all. Every posting to it must be reclassified during ETL | 🗑️ |
| `commissary_receive` source type | Dead at the financial layer, and **name-collides** with a live, unrelated inventory-ledger source type of the same string | 🗑️ |

---

## 3. Answered by Ian, 2026-08-22 — now decided

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | `staff_reimbursable__` — asset or liability? | **"We owe to staff — staff own money they spend for business needs."** | **LIABILITY.** → **2130** Reimbursements payable to employees. **This confirms a live misclassification:** it currently sits on the asset side because `inferAccountNature` defaults any unlisted prefix to debit. Your balance sheet understates liabilities by this balance today |
| 2 | `expense__tax` — which tax? | **Mostly permits.** | → **6800** Taxes and licences. And yes — government permits and licences are **not VAT-able**; there is no input VAT to claim on a mayor's permit, barangay clearance, or BIR registration fee. They are an expense in full. If any VAT-able item is sitting in this account it should move to its own expense account with input VAT split out |
| 3 | `loss_on_disposal` on the P&L? | **Yes.** | → **7400** Loss on disposal of assets, in Other income and expense. Write-offs will now reduce reported net income — they never have before |
| 4 | Points / vouchers — granted or sold? | **Earned and redeemed as discount. Selling is a maybe, later.** | Both are **contra-revenue**. Vouchers **reserved**; **2145** Unredeemed vouchers pre-built and reserved for a future sold-voucher model |
| 5 | Revenue split | **Dine-in (unli or à la carte) and take-out (always à la carte). Delivery is a mode of take-out. Beverages sold: soft drinks, milk drinks, beer; juice free.** | The revenue structure above. Channel becomes a dimension, not accounts |
| 6 | Payroll timing | **"Payroll is not always final — sometimes 3 days to settle one payroll because of adjustments and confirmations. We will strive to improve this by this system."** | See below — this one deserves a proper answer |

### On payroll: the workaround becomes a feature

The park-against-liability pattern exists for a real reason — payroll is not final when it
is paid. That is a genuine business constraint, not sloppiness.

But the standard accounting toolkit already solves it, and better:

| | Today | Shareat System |
|---|---|---|
| While adjusting | Cash goes out, gross parked against `liability__salaries_payable`, which carries a **debit balance** (wrong side for a liability) until a separate expense entry lands | Pay run is a **draft document**. No GL posting yet. Adjustments are edits to a draft, which is what drafts are for |
| On approval | Expense recognised separately, once per period | **Dr** 6100 Salaries + 6110–6130 employer contributions · **Cr** 2300 Salaries payable + 2210–2240 statutory payables |
| On payout | — | **Dr** 2300 Salaries payable · **Cr** 1110 Cash |
| Late adjustment | Ad hoc | An adjusting entry while the period is open; after close, a reversal in the next period |

**Recommended: standard accrual with a draft pay run.** Same 3-day reality, but the
liability never sits on the wrong side, labour cost lands in the period it was earned, and
employer contributions get booked at the same moment (fixing defect #1).

If cash ever leaves *before* approval, that payment is an **advance**, not a settled
payroll — **1235** Payroll advances / clearing, cleared on approval. Correct, and it makes
"how much have we paid against an unapproved run" answerable.

**This also serves your stated goal.** You said you want the system to shorten that 3-day
cycle. A draft pay run with explicit approval gives you the thing to measure — time from
period end to approval — which is the number that has to move.

## 4. Expense categories → accounts

**Source:** `docs/discovery/08-expense-categories.md` — 132 live entries read from the
global `expenseEntries` collection. Structure is a flat `group` (OPEX / COGS / CAPEX /
PERSONAL / OTHERS) → free-text `category` → free-text `subCategory`.

**The good news first:** your taxonomy is better than the accounting under it. You are
already classifying spend as COGS vs OPEX vs CAPEX, with 46 COGS categories that map
cleanly onto food-cost lines. What is missing is not the classification — it is that COGS
spend is **expensed on purchase** instead of moving through inventory. The category list
mostly survives; it just gets a GL account attached and a different posting moment.

Today **zero** entries carry any account field. Only 8 fixed `expense__*` journal accounts
exist app-wide, so 84 owner-added categories have no ledger account at all.

### 4.1 COGS categories — the two-stage change

With real inventory (Phase 3), a COGS category no longer maps to one account. It maps to a
**pair**, because purchase and consumption are different events:

| Event | Posting |
|---|---|
| **Purchase / receipt** | **Dr** inventory asset (1310/1320/1330) · **Cr** AP or cash |
| **Consumption / sale** | **Dr** COGS (5xxx) · **Cr** inventory asset |
| **Wastage** | **Dr** 5300 Wastage · **Cr** inventory asset |
| **Count variance** | **Dr/Cr** 5400 Inventory adjustment · **Cr/Dr** inventory asset |

*Today only the first line's economic effect is recorded, and it lands in an expense
rather than an asset. That is why stock is not on your balance sheet and gross margin is
wrong.*

| v1 category | Inventory acct (on purchase) | COGS acct (on consumption) |
|---|---|---|
| **Meat** — Beef, Chicken Breast/Leg/Wings, Pork Belly/Jowls/Kasim, Seafoods | 1310 Raw materials | **5110** COGS — meat |
| **Sides** — Kimchi, Lettuce, Rice, Egg, Enoki, Tteokbokki, Radish, Corn, Cucumber, Carrots, Fishcake, Green Peas, Bean Sprout, Potato, Singkamas, Sweet Potato | 1310 Raw materials | **5120** COGS — sides |
| **Condiments, Ingredients and Seasoning** — oils, soy/vinegar/fish sauce, spices, salt/pepper, sugar/honey, butter & cheese | 1310 Raw materials | **5130** COGS — condiments and seasoning |
| **Meat Sauce Dips and Flavors** — Bulgogi, Spicy Bulgogi, Galbi, Gochujang, Ssamjang, Mayonnaise, Melted Cheese | 1310 Raw materials | **5140** COGS — sauces and dips |
| **Beverages** | 1310 Raw materials | **5200** COGS — beverage |
| **Product Packaging** — SharEat, Xlice | 1320 Supplies and packaging | **5150** COGS — packaging |
| **Retail Inventory** — Butane, Retail Items | 1310 Raw materials | **5160** COGS — retail and consumables |
| **Commissary Purchases** | 1330 Prepped / commissary goods | **5170** COGS — commissary transfers ⚠️ *see note* |
| **Cost of Goods Sold — General** | — | **5100** COGS — food *(catch-all; drive to zero)* |

⚠️ **Commissary Purchases is inter-store, not a third-party cost.** At store level it is a
real cost; **consolidated it must eliminate** against the commissary's transfer-out, or
you double-count the same peso — once when the commissary buys the raw material and again
when the branch "buys" from the commissary. This is the same reciprocal problem as
due-from/due-to, and it is why 5170 is kept separate rather than folded into 5110.

**Butane note:** consumed by customers at the grill during unli service, so it is a direct
cost of delivering that product — COGS, not supplies. Worth watching as a per-cover metric.

### 4.2 OPEX categories → accounts

| v1 category | → v2 account | |
|---|---|---|
| Salary | **6100** Salaries and wages | ✅ |
| Employee Expenses | **6160** Employee benefits and welfare | 🆕 |
| Rent | **6200** Rent | ✅ |
| Utilities | **6300** Utilities | ✅ |
| Platform Fee | **6400** Platform and channel fees | ✅ |
| Online Order Expenses | **6410** Online order expenses | ✅ |
| Supplies and Stocks | **6500** Supplies | ✅ |
| Smallwares | **6510** Smallwares | ⚠️ *also exists as CAPEX — see §4.5* |
| Repairs and Maintenance · **Maintenance** | **6600** Repairs and maintenance | ⚠️ *merge — two categories, one concept* |
| Pest Control and Waste Management · **Pest Control and Sanitation** | **6620** Pest control and waste management | 🆕 ⚠️ *merge — two categories, one concept (§4.5)* |
| Vehicle Expense | **6630** Vehicle and transportation | 🆕 |
| Marketing and Advertising | **6650** Marketing and advertising | 🆕 |
| Depreciation | **6700** Depreciation | ✅ |
| Amortization | **6750** Amortisation | ✅ |
| Permits & Licenses | **6800** Taxes and licences | ✅ |
| Administrative Expenses | **6850** Administrative expenses | 🆕 |
| Bad Debt | **6860** Bad debt expense | 🆕 |
| Bank Fees | **6870** Bank charges | 🆕 |
| Insurance | **6880** Insurance | 🆕 |
| Subscriptions · **Subscriptions (OTHER)** | **6890** Subscriptions and software | ⚠️ *merge — near-duplicate* |
| Uncategorized Expenses | **6900** Other operating expenses | ⚠️ *catch-all; see §4.6* |
| **Interest Expense** | **7200** Interest expense | ⚠️ *reclass out of OPEX* |
| **Loss on Disposal** | **7400** Loss on disposal of assets | ⚠️ *reclass out of OPEX* |
| **Other Prepaid** | **1400** Prepaid expenses | ⚠️ *balance sheet, not an expense — routing entry* |

⚠️ **Interest and Loss on Disposal are not operating expenses.** Standard practice puts
them **below** operating profit, in Other income and expense, because they are not part of
running the restaurant. Reclassifying them **improves your reported operating margin** and
makes it comparable to industry benchmarks. Net income is unchanged.

### 4.3 CAPEX (5 entries) — not expenses at all

CAPEX entries route to **1510–1530 Property and equipment** and depreciate; they never
touch the P&L directly. Two already carry `capitalizesToAsset: true`, which is the right
mechanism.

Your **"Capitalization (More than 5k)"** entry encodes a capitalisation threshold, and
having one is genuinely standard practice. In v2 it becomes a **named policy constant**
(`CAPITALISATION_THRESHOLD = ₱5,000`) rather than a category name, so it can be changed in
one place and shows up in the audit trail when it is.

### 4.4 PERSONAL (1 entry) — owner drawings, not expense ⚠️

`PER1 — OWNER / specify` is correctly excluded from the P&L today. But excluded is not the
same as **posted**: in proper accounting an owner withdrawal is **3200 Owner's drawings**
and it **reduces equity**.

**Worth checking in v1:** if these are merely filtered out of the income statement and
never posted to equity, then owner withdrawals are not reducing your capital account
anywhere, and your equity is overstated by the cumulative total.

### 4.5 Overlaps to resolve

| Overlap | Recommendation |
|---|---|
| **Rent** — `Exp1000` and `sys_rent`, both "Rent/Store Rent", **both active** | A true live duplicate. Keep one, archive the other, remap history |
| **Smallwares** — OPEX `SE_EX85` and CAPEX `sys_capex_smallwares`, both `capitalizesToAsset` | Same real spend routed two ways depending on who records it. Resolve with the ₱5,000 threshold: below → 6510, above → CAPEX |
| **Maintenance** vs **Repairs and Maintenance** | Merge into 6600 |
| **Subscriptions** vs **Subscriptions (OTHER)** | Merge into 6890 |
| **Pest Control and Waste Management** vs **Pest Control and Sanitation** | Merge into **6620** — *second category named by Ian, 2026-08-23* |

### 4.6 Catch-alls — the real accuracy risk

At least **8 scattered "Specify / OTHER" buckets** plus "Uncategorized Expenses",
"Cost of Goods Sold — General", and "Capitalization (More than 5k)".

Catch-alls are where accounting accuracy quietly dies: everything ambiguous lands there,
and the bucket grows until it is too big to unpick. Industry practice is to keep them
under **1–2% of spend** and review them monthly.

**Recommended:** keep the catch-alls (they prevent worse behaviour — staff forcing spend
into a wrong-but-specific category), but **report their share of total spend on the
dashboard**. If "Uncategorized" is 8% of OPEX, that is a finding. The ETL should also
report historical spend per catch-all so you can see the size of the problem.

### 4.7 Answered by Ian, 2026-08-22 — decided

| # | Question | Answer |
|---|---|---|
| 1 | Interest / Loss on Disposal filed as OPEX | **"Correct it on v2."** → 7200 and 7400, below operating profit |
| 2 | Owner drawings (`PER1`) | **"Never used — we'll design it right."** → **3200 Owner's drawings**, reducing equity, designed properly from the start rather than ported |
| 3 | Rent duplicate / hardcoding system entries | **"We fix on v2."** The duplicate arose from two writers — a manual add plus a later hardcoded seed. Fix is a UNIQUE constraint on normalised identity plus migration-owned idempotent seeds (bible §4.4), not hardcoding alone |
| 4 | Catch-alls: keep but report their share of spend | **"Agree."** |
| 5 | COGS sub-accounts 5110–5170 | Recommended split stands — meat is the dominant cost and needs isolating |
| 6 | Smallwares ₱5,000 threshold | Recommended: below → 6510 expense, above → CAPEX. Becomes a named policy constant |

**Note on #2:** because owner drawings were never really used, this is an **ADD**, not a
CORRECT — v2 designs it right rather than migrating a broken pattern. No historical
drawings data needs untangling.

**Note on #3:** the deeper fix is that reference data gets **one writer** and a database
constraint. See bible §4.4 — the same "by construction, not by remembering" principle
behind the whole project.

## 5. What happens to accounts you don't use

Per bible §16.9: anything real but currently dormant is created as **`reserved`** —
numbered, named, in the right place, invisible in pickers and reports until you flip one
flag. Nothing is lost, and nothing clutters a dropdown where it could be miscoded.

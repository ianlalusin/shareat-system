# T-113 — Nominal-leg mapping table

> **Status:** ✅ **IMPLEMENTED 2026-08-23.** Ian's review complete. **§1/§2's `sourceType` names
> are WRONG — see the correction at the end.** `packages/etl/src/leg-mapping.ts` is authoritative.
> **Was:** awaiting Ian's review. Blocks T-114 (ETL Stage 1) and therefore T-115.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.
> **Skill invoked:** `accounting-systems` (bible §13 row 59 — required before any posting pattern).

## Goal

Define, for every v1 journal `sourceType`, **what the missing nominal (P&L) leg is, where its
amount comes from, and where its account comes from** — so ETL Stage 1 can attempt to balance
every historical entry mechanically and classify what it cannot.

This table is the rulebook Stage 1 executes. It is not code and it loads nothing.

## Why this exists

v1's journal is one leg per document with `direction: in|out`, and `balancer.ts:64-67` treats a
single-leg entry as "trivially balanced" (bible §16.0). So ordinary expenses post only the
cash/AP side and sales post only the cash/online side — **there is no revenue or expense leg
at all.** Reconstructing that leg is what makes v1's history loadable into a schema that
enforces double entry, and the attempt itself is the audit (bible §1.4).

---

## How to read this

Every v1 `sourceType` falls into exactly one class:

| Class | Meaning | Stage 1 action |
|---|---|---|
| **A — complete** | Both legs already exist, or the entry is legitimately balance-sheet-to-balance-sheet | Verify it balances. No synthesis. |
| **B — synthesise** | A nominal leg is genuinely missing and is derivable from the source document | Synthesise per the table below. |
| **C — undecidable** | The nominal leg is missing and the source document **does not contain** what is needed to derive it | Quarantine. Needs Ian (§6). |

Evidence for every row is `ERP-rebuild/src/lib/financial/journal/builders/*.builder.ts`, read
read-only on 2026-08-23. Target account codes are from `docs/decisions/COA-ALIGNMENT.md`.

---

## Scope — implementation, added 2026-08-23

Everything above this line is the **design**, and Ian's review of it is complete (§6). What
follows is the §3.3 task spec for building it.

**T-117 already built a partial version.** `packages/etl/src/convert.ts` has an
`OPEX_CATEGORY_ACCOUNTS` map covering only the categories its eight specimens exercise, and it
correctly **quarantines an unmapped category rather than falling back to 6900**. That behaviour
is right and must be preserved — this task widens the map, it does not loosen the rule.

### Files

Create or modify **only**:

```
packages/etl/src/leg-mapping.ts        the full sourceType + category mapping — NEW
packages/etl/src/convert.ts            consume the mapping; keep the quarantine behaviour
packages/etl/tests/leg-mapping.test.ts NEW — unit, no database
packages/etl/tests/convert.test.ts     extend
```

Do **not** modify `packages/domain/**`, `packages/db/**`, the corpus fixtures, or anything under
`apps/`. **Do not touch `PROJECT_BIBLE.md`** (§14).

### What to build

**1. The `sourceType` classification (§1–§2 above).** Every v1 `sourceType` resolves to exactly
one class:

- **Class A — complete.** 11 that already carry a nominal leg, plus the 11 that are
  balance-sheet-to-balance-sheet and must synthesise **nothing**. A synthesised leg on that
  second list is a **bug, not a finding** — assert zero synthesis for it.
- **Class B — synthesise.** `expense`, `ar-charge`, `sale`.
- **Class C — quarantine** with a named reason.

**2. The complete expense-category mapping**, from `COA-ALIGNMENT.md` **§4** — *not* §2. All
COGS categories (5110–5170, 5200), all OPEX categories (6100–6900), and the two that leave the
P&L entirely: **`CAPEX` → fixed asset**, **`PERSONAL` → 3200 owner's drawings**.

> Those two exits are the likeliest thing to get wrong. A naive `expenseEntryGroup → 6xxx`
> routing puts a capital purchase and an owner's personal spend into operating expenses, which
> overstates costs and understates both assets and drawings.

**3. Preserve the no-fallback rule.** An unmapped category **quarantines with its name in the
reason**. It never falls back to 6900 Other. A catch-all that silently absorbs the unknown is
how the legacy books reached their current state (§3 rule 1).

### Implementation invariants — in addition to Tests 1–9 above

10. Every `sourceType` named in §1 and §2 resolves to a class; **none is unclassified**.
11. **Every COGS and OPEX category named in `COA-ALIGNMENT.md` §4 resolves to an account**, and
    every account it resolves to **exists in the seeded chart**. Parse §4 for this — a
    hand-maintained list has the same blind spot that produced DEF-035.
12. `CAPEX` never produces a P&L line; `PERSONAL` always resolves to 3200.
13. An unmapped category quarantines, naming the category, and **never** yields 6900.
14. The 11 balance-sheet-only `sourceType`s synthesise **zero** lines.

### Done when

- [ ] Tests 1–9 (above) and 10–14 pass.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green (**all existing tests
      still pass**) · `build` succeeds.
- [ ] No file outside **Files** modified.
- [ ] Any spec defect **reported, not silently worked around**.

---

## 1. Class A — already complete, no synthesis

These builders already emit a P&L leg. Stage 1 asserts they balance and maps the account.

| v1 `sourceType` | v1 nominal account | → v2 account |
|---|---|---|
| `payroll-salary-expense` | `expense__salary`, `expense__salary_additions` | 6100, 6150 |
| `depreciation` | `expense__depreciation` | 6700 |
| `amortization` | `expense__amortization` | 6750 |
| `loan` | `expense__interest` | 7200 |
| `ar-collection` | `expense__platform_fee` | 6400 |
| `asset-disposal` | `expense__loss_on_disposal` | 7400 |
| `liability-charge` | `expense__tax` | 6800 |
| `wastage-expense` | `expense__order_wastage`, `income__wastage_writeoff_contra` | 5300, contra |
| `payroll-payout` | `income__charge_recovery` | 7310 |
| `salary-advance` | `income__wastage_recovery` | 7320 |
| `remittance` | `others__remittance_overage` | 7350 (cash over/short) |

These are balance-sheet-to-balance-sheet by nature and correctly carry **no** P&L leg. Stage 1
must **not** synthesise one — doing so would invent income or expense that never occurred:

`ap-payment` · `cash-request` · `transfer` · `asset-purchase` · `prepaid-purchase` ·
`equity-movement` · `slicer-payment` · `liability-payment` · `reimbursement-payout` ·
`legacy-balance-import` · `asset-legacy-import`

> **Control:** a synthesised leg on any of the above is a Stage 1 **bug**, not a finding.
> Assert zero synthesis for this list in the test suite.

---

## 2. Class B — synthesise the nominal leg

### 2.1 `expense` — the highest volume

**Business event:** a cost was incurred and paid (cash / online) or accrued (AP).
**Source document:** the `expenses/{id}` doc.
**v1 posts:** one leg only — `OUT cash__*` / `OUT online__*` / `IN ap__{supplierId}`.
**Missing leg:** `DR <expense account>` for the same amount.

| Derive | From | Rule |
|---|---|---|
| Amount | the existing leg's `amount` | Equal and opposite. One leg in, one leg out. |
| Account | `expenses.expenseEntryGroup` + `category` + `subCategory` | Per `COA-ALIGNMENT.md` §4.1–4.4 |

Routing by `expenseEntryGroup`, which v1 denormalises onto the expense doc at post time:

| `expenseEntryGroup` | → v2 | Note |
|---|---|---|
| `COGS` | 5100 / 5200 per category | §4.1 — the two-stage change |
| `OPEX` | 6200–6900 per category | §4.2 |
| `CAPEX` | **not an expense** — 1500s fixed asset | §4.3. Synthesising a P&L leg here is wrong |
| `PERSONAL` | **3200 owner drawings** — equity, not expense | §4.4. Bible §13 row 57 |

> `CAPEX` and `PERSONAL` are the two rows most likely to be got wrong by a naive
> "expenseEntryGroup → 6xxx" mapping. Both must leave the P&L entirely.

### 2.2 `ar-charge`

**Business event:** revenue recognised on account (branch sale, platform order).
**v1 posts:** `IN ar__{customerId}` only. **Missing leg:** `CR` revenue.
Account follows the same revenue rules as §2.3 — and inherits the same §6 blocker.

### 2.3 `sale` — the structural problem

**Business event:** a day's trading.
**Source document:** `salesDays/{YYYY-MM-DD}`, recognised only at `status='verified'`.
**v1 posts:** `IN cash__cashier` (from `cashPayments`) and `IN online__{acct}` (from
`onlineBreakdown`) — **all debits, zero credits.** Confirmed in `sale.builder.ts:24-57`.

**These legs are tender, not revenue.** Synthesising "revenue = sum of the tender legs" is
wrong in three separate ways: it omits revenue collected on account, it nets discounts into
revenue instead of showing them as contra-revenue, and it silently absorbs any till variance.

The identity Stage 1 must test per sales day:

```
  totalSales                            (gross revenue, credit)
=   cashPayments + Σ onlineBreakdown    (tender, already posted as debits)
  + Δ ar__*                             (recognised, not yet collected)
  + totalDiscounts + comps              (contra-revenue, debit)
  + residual                            ← must be 0, else QUARANTINE
```

`SalesDayPlain` (`ERP-rebuild/src/types/index.ts`) carries `totalSales`, `dineInSales`,
`takeOutSales`, `deliverySales`, `cashPayments`, `eWalletPayments`, `creditCardPayments`,
`otherPayments`, `totalDiscounts`, `seniorDiscount`, `pwdDiscount`, `otherDiscount`, `comps`,
and `salesChannelBreakdown`.

**What `dineInSales` actually means — verified in POS, 2026-08-23.** ERP does not compute this
field; it pulls it from POS `/api/external/sales`. In POS `analytics/daily.ts:263`:

```ts
const isDineIn = r.sessionMode === 'package_dinein';
const mode = isDineIn ? "dineIn" : "walkIn";
```

So **ERP's `dineInSales` is the unlimited-package figure and nothing else** — package sales plus
dine-in addons. À la carte and online both fall into POS's "walkIn", and ERP's `takeOutSales` is
then computed as a **residual**, `Math.max(0, totalGross - dineInSales)`
(`POS/src/app/api/external/sales/route.ts:53`).

| → v2 | Derived from | Confidence |
|---|---|---|
| **4100** Food sales — dine-in, unlimited | `dineInSales` | ✅ this *is* the unli figure |
| **4150** à la carte *(incl. take-out + delivery)* | `takeOutSales` (residual) | ✅ direct — the split was withdrawn (§6.6) |
| **4400** Beverage sales | — | ❌ not in ERP; §6.2 makes it a lump account |
| **4900** Sales discounts (contra) | `seniorDiscount + pwdDiscount + otherDiscount` | ✅ direct |
| **4950** Sales returns and voids (contra) | `comps` | ✅ confirmed contra-revenue (§6.3) |
| `channel_id` dimension | `salesChannelBreakdown` keys | ✅ direct. Bible §13 row 44 |

> **`takeOutSales` is a residual, not a measurement.** It absorbs anything `totalGross` counts
> that `dineInSales` does not. Stage 1 must therefore treat a non-zero residual as a
> reconciliation signal, never as a revenue figure to trust on its own.

---

## 3. Balance rule and quarantine

Stage 1 classifies every `sourceType:sourceId` group into exactly one bucket:

| | Meaning |
|---|---|
| ✅ **balanced** | Synthesised leg produced Σdebits = Σcredits to the centavo |
| ⚠️ **ambiguous** | Mapping is not determinate — a Class C field, an unmapped category, a catch-all |
| ❌ **imbalanced** | Mapping applied cleanly and it still does not balance → **a genuine v1 defect** |

Rules, all non-negotiable:

1. **Never guess a mapping.** An unmapped `category` quarantines; it does not fall to 6900 Other.
   A catch-all that silently absorbs the unknown is how the books got here.
2. **Every quarantine row carries a reason code** and the source `sourceType:sourceId`. Never a
   bare "failed".
3. **ETL never mutates Firestore** (bible §11 rule 4). Read-only, always.
4. **Idempotent and re-runnable.** Same input, same classification, no accumulation.
5. **Rounding:** compare in integer centavos (`src/lib/money.ts`). v1 tolerates half a centavo
   (`balancer.ts`) because it stores floats; v2 does not inherit that tolerance. A sub-centavo
   residual is a **finding about v1's float storage**, not noise to swallow.
6. **❌ is a deliverable, not a failure.** Bible §1.4 — the imbalanced list *is* the audit of
   v1's books, and it is useful to Ian even if Stage 2 never runs.

---

## 4. Tests (written before implementation)

1. Each Class A balance-sheet-only `sourceType` synthesises **zero** legs.
2. Each Class A nominal `sourceType` maps to the COA code in §1.
3. `expense` with `expenseEntryGroup='CAPEX'` produces **no** P&L leg.
4. `expense` with `expenseEntryGroup='PERSONAL'` maps to **3200 equity**, not an expense.
5. `expense` with an unmapped `category` **quarantines** — it does not fall back to 6900.
6. A `sale` day where tender ≠ `totalSales` − discounts − Δ AR **quarantines** with a residual.
7. A `sale` day with `dineInSales > 0` quarantines under the §6.1 rule until Ian decides.
8. Re-running Stage 1 twice produces byte-identical output.
9. A synthetic unbalanced group is classified ❌ and never silently balanced.

## 5. Done when

- [ ] Ian has answered §6.
- [ ] The table is executable — every `sourceType` resolves to a class and a rule.
- [ ] Tests 1–9 pass.
- [ ] No `sourceType` in v1 is unaccounted for.

---

## 6. Ian's review — answered 2026-08-23

### 6.1 ✅ RESOLVED — dine-in unli IS derivable. My earlier claim was wrong.

I originally reported that dine-in could not be split into unli vs à la carte. That was
wrong, and the correction matters:

**ERP's `dineInSales` already *is* the unli figure.** ERP does not compute it — it pulls it
from POS, and POS defines dine-in as `sessionMode === 'package_dinein'` and nothing else
(`POS/src/lib/analytics/daily.ts:263`). So **4100 needs no reconstruction at all**; it maps
straight from `salesDays.dineInSales`.

What is genuinely conflated is the *other* side: `takeOutSales` is a residual
(`totalGross − dineInSales`) holding à la carte **and** online together.

**POS resolves it at receipt level.** `Receipt` (`POS/src/lib/types.ts`) carries
`sessionMode: 'package_dinein' | 'alacarte'` on every receipt, and lines carry `category`.
So the split is recoverable per receipt, not merely per day. No blended pre-cutover account
and no fabricated ratio is needed. **The 4190 account I proposed is withdrawn.**

### 6.2 ✅ RESOLVED — beverage is one lump account

Ian: one lump-sum record. **4410 and 4420 collapse into a single 4400 Beverage sales.**
COA-ALIGNMENT is amended accordingly; the licensing argument for splitting beer does not
outweigh carrying a split the business does not want to maintain (bible §1.1 — carry no
generality this business does not have).

*Recoverable later if wanted:* POS already aggregates `addonSalesAmountByCategory` and
`addonSalesByItem`, so a beverage split is a reporting change, not a re-migration.

### 6.3 ✅ RESOLVED — `comps` are contra-revenue

Confirmed by Ian. **4950 Sales returns and voids.** Not a marketing expense.

### 6.4 ⏳ OPEN — opening-balance date

Less constrained than it looked, since §6.1 means unli history is intact. Still recommend an
opening-balance entry at the start of the current fiscal year with full detail forward.
Stage 1 audits all history regardless (bible §1.4).

### 6.5 ✅ RESOLVED — VAT is a label, not a tax engine

Ian, 2026-08-23: the business is VAT-registered, but **reported sales are not all sales, and
this ERP is internal-use only — not a VAT-compliant system. VAT here is just a label.**

Design consequences, recorded so nobody re-derives them later:

1. **Shareat System is a management ledger, not the statutory filing basis.** It must never be
   described, labelled, or exported as BIR-ready output. Anyone later assuming it is would be
   wrong, and that assumption is exactly what a document like this exists to prevent.
2. **No VAT engine.** No output-VAT liability accounts, no input/output netting, no BIR
   report builders. Bible §16.5's "PH-specific rules" narrows to payroll statutory
   (SSS/PhilHealth/Pag-IBIG/withholding), which *is* real and does post.
3. **SC/PWD discounts are plain contra-revenue** into 4900. No VAT-exempt carve-out.
4. The dormant `vatableSales` / `outputVatAmount` fields on `SalesDayPlain` are **not
   migrated**. They were written by zero code paths in v1 and have no meaning in v2.
5. If a statutory basis is ever needed, it is a **separate reporting layer over the same
   ledger**, not a retrofit of these accounts.

### 6.6 ✅ RESOLVED — two food accounts only; take-out folds into à la carte

POS's à la carte sessions are **table-less** — `tableId` is forced to `null` whenever
`sessionMode === 'alacarte'` (`POS/src/components/cashier/firestore.ts:650`). Combined with
the store flag *"Offers Unlimited (Dine-in) — turn off for take-out-only kiosks"*, that
suggests à la carte is in practice a take-out/counter flow rather than seated dining.

If that is true, **4150 should be `reserved`, not active**, and all à la carte revenue posts
to 4200. If seated à la carte diners are a real and separate thing you want to see, 4150
stays active and POS needs the distinction recorded (§6.7).

*Answer needed:* when someone orders à la carte, are they eating in or taking away — and do
you want those two told apart in the P&L?

### 6.7 ⏳ OPEN — align POS online-order handling **before** online goes live

Ian: there are **no online transactions yet**, so no historical online data exists to migrate.

> **SUPERSEDED 2026-08-23.** This section originally recommended changing POS. The standing
> rule now makes all four reference repos read-only (bible §13 row 80), so **nothing is fixed
> in POS**. The finding stands and is logged as DEF-004; the fix lands in the rebuild.

That is the ideal moment, because the current shape has a real defect. Online-order receipts
are written with `sessionMode: "alacarte"` and then tagged
`(receipt as any).source = "online"` (`POS/src/app/api/admin/online-orders/route.ts:503,518`)
— an **untyped field bolted on via an `as any` cast**, absent from the `Receipt` type. Once
online volume exists, that cast is the only thing separating 4200 from 4150, and nothing
type-checks it.

**Recommendation — a small POS change now, not an ETL workaround later:** put a typed,
required fulfilment discriminator on `Receipt` (for example
`fulfilment: 'dine_in' | 'take_out' | 'delivery'`), set explicitly on every write path
including the online route, and stop inferring revenue class from `sessionMode` + an untyped
tag. `sessionMode` then means what it says — how the *session* was sold (package vs à la
carte) — and fulfilment says where the food went. Those are two different questions, and the
COA needs both: `sessionMode` drives 4100 vs 4150/4200, fulfilment drives 4150 vs 4200.

**In the rebuild, not in POS.** `fulfilment` becomes a required column on the receipt table
from day one. The concept already exists in POS as `onlineOrders.fulfillment.type`
(`pickup | delivery`) — it is simply never carried onto the receipt. That is a rule to
**harvest**, not a change to make in POS.

---

## 7. Net effect on the ETL

With §6.1–6.3 and §6.5 answered, the sale mapping is **fully determinate for history**:

| → v2 | Source | Status |
|---|---|---|
| **4100** dine-in unlimited | `salesDays.dineInSales` | ✅ direct |
| **4150** à la carte *(incl. take-out + delivery)* | `salesDays.takeOutSales` | ✅ direct |
| **4400** beverage | — | lump; not separated in history |
| **4900** discounts (contra) | `seniorDiscount + pwdDiscount + otherDiscount` | ✅ |
| **4950** comps (contra) | `comps` | ✅ |

**The historical window is clean precisely because online does not exist yet.** Every
pre-cutover `takeOutSales` peso is à la carte by construction. That property ends the day
online orders launch, which is why §6.7 should land before then.


---

## ⚠️ Corrections — 2026-08-23, after implementation

### 1. The `sourceType` names in §1 and §2 are wrong. All of them.

I wrote kebab-case pretty names. **v1 writes snake_case**, and several of my names collapse or
split against reality. Verified by grepping every builder:

| I wrote | v1 actually writes |
|---|---|
| `expense` | **`expense_payment`** |
| `liability-charge` | **`balance_adjustment`** |
| `equity-movement` | **`capital_contribution`** + a drawings variant |
| `cash-request` | **`cash_request_release`** + **`cash_request_return`** |
| `legacy-balance-import` | **five** values: `ap_legacy_import`, `ar_legacy_import`, `staff_advance_legacy_import`, `staff_reimbursable_legacy_import`, `cash_legacy_import` |
| `loan` | **`loan_disbursement`** (never nominal) + **`loan_payment`** (nominal only when interest > 0) |
| `ar-charge` **and** `sale` | **the same literal `'sale'`** — written by *both* `ar-charge.builder.ts` and `sale.builder.ts` |

> **A classification table keyed on my names would have matched nothing at all.**
> `leg-mapping.ts` keys on the real values. **It is authoritative; this document is not.**

**`ar-charge` and `sale` sharing one literal is the important one.** They are distinguishable
only by `sourceId` (an arTransaction id vs a salesDay id) and by which leg exists (`ar__*` vs
`cash__*`/`online__*`) — **never by `sourceType` alone.** Any Stage 1 logic that switches on
`sourceType` to tell revenue-on-account from a cash sale is wrong by construction.

### 2. Four `sourceType`s this document never named

`prepaid_writeoff` · `prepaid_refund` · `prepaid_legacy_import` (a sixth legacy-import flavour,
living in `prepaid-purchase.builder.ts` rather than the legacy-import builder) ·
`online_remittance`. All are `complete`, so Stage 1 is unaffected — **but §1's claim to cover
"every v1 `sourceType`" was not true.**

### 3. "Nominal" is mostly *conditional*, not fixed

§1's table implies each Class A nominal type always posts to one account. Reading the builders
rather than their header comments shows most only *sometimes* do:

- `asset_disposal` skips the loss leg entirely for a fully-depreciated asset
- `payroll_payout` posts `income__charge_recovery` **only** on a late charge — most payouts post
  **zero** P&L lines
- `remittance` / `online_remittance` reach 7350 only on an **overage**; a shortage goes to
  `staff_advance__*`, which is not P&L at all
- `salary_advance` is nominal only for the rarer `charge` type — disbursement and repayment,
  the common cases, never touch P&L
- `balance_adjustment` takes a **fully caller-supplied** counter account

None of this breaks the rule that matters — every one is still self-balanced by v1's own
builder, so zero synthesis is still correct. But **§1's single-fixed-account framing is
optimistic**, and T-114 must not rely on it.

### 4. `transfer` can carry a real expense leg

`transfer.builder.ts:71-79` posts an optional fee leg to a caller-chosen account. Still needs
**zero synthesis**, but §1's framing of it as purely balance-sheet is not quite right.

### 5. My Test 7 was stale — and was correctly not implemented

Test 7 said *"a sale day with `dineInSales > 0` quarantines until Ian decides."* **§6.1 of this
same document already resolved that** — `dineInSales` *is* the unli figure and 4100 needs no
reconstruction. Implementing Test 7 literally would have made **every dine-in-unli day
permanently unconvertible**.

The implementer refused to build it, documented the contradiction in `convert.ts`, and added a
corrected regression test instead. **Test 7 is struck.**

> A spec that contradicts itself between two sections is worse than one that is merely wrong,
> because both halves look authoritative.

### 6. One mapping left ambiguous rather than guessed

COA-ALIGNMENT §4.5 says *"Pest Control split two ways | Merge into 6620"* but — unlike its Rent
and Smallwares rows — never names the **second** literal category string. Not guessed. Recorded
in `AMBIGUOUS_CATEGORY_FINDINGS`, and any unmapped Pest-Control-adjacent category quarantines.
**Needs Ian, before T-114.**

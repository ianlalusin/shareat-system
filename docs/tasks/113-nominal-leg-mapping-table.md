# T-113 — Nominal-leg mapping table

> **Status:** awaiting Ian's review. Blocks T-114 (ETL Stage 1) and therefore T-115.
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

What that **does** support:

| → v2 | Derived from | Confidence |
|---|---|---|
| **4200** Take-out / à la carte | `takeOutSales + deliverySales` | ✅ direct. COA folds delivery into take-out |
| **4900** Sales discounts (contra) | `seniorDiscount + pwdDiscount + otherDiscount` | ✅ direct |
| **4950** Sales returns and voids (contra) | `comps` | ⚠️ see §6.3 |
| `channel_id` dimension | `salesChannelBreakdown` keys | ✅ direct. Bible §13 row 44 |

What it **does not** support — see §6.

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

## 6. Decisions needed from Ian — this is the review gate

### 6.1 ⛔ Historical dine-in cannot be split into unli vs à la carte

The approved COA splits dine-in into **4100 unlimited** and **4150 à la carte**, and
COA-ALIGNMENT says unli deserves its own line because it is "the single most important margin
signal in the business."

**`salesDays` has one `dineInSales` number.** There is no unli/à-la-carte breakdown anywhere on
the document. The split cannot be derived from ERP history at any confidence.

Options:

| | Approach | Cost |
|---|---|---|
| **A** *(recommended)* | Historical dine-in posts to a single **4190 Food sales — dine-in (pre-cutover)**, reserved and archived after cutover. The 4100/4150 split starts at go-live | One extra account; history stays honest about what it does not know |
| **B** | Reconstruct from POS item-level data rather than ERP salesDays | Unknown until the POS archive is checked; a separate discovery task |
| **C** | Apply a fixed historical ratio | **Not recommended** — invents a number and puts it in the ledger |

Option A is the standard treatment: you do not fabricate detail you never captured. It also
costs nothing going forward, because the split is a *reporting* need and reporting starts from
cutover regardless.

### 6.2 ⛔ Beverage revenue cannot be separated from food

**4410** non-alcoholic and **4420** alcoholic exist in the COA — 4420 is separate partly for
licensing. `salesDays` carries no beverage breakdown at all. Same three options as §6.1;
recommendation is the same (a pre-cutover blended account).

### 6.3 `comps` — contra-revenue or an expense?

Mapped to **4950** above as a placeholder. A comp given as a service recovery is arguably
marketing expense, not a sales return. Which is it in your business? This is a small number but
it changes gross-margin readability.

### 6.4 Opening-balance date

§6.1 and §6.2 make this sharper than it looked. If historical revenue cannot carry the split
the COA is built around, **loading years of detail buys progressively less** — Stage 1 still
audits all history either way (bible §1.4). Recommend an opening-balance entry at the start of
the current fiscal year and full detail forward from there.

### 6.5 Output VAT is not recoverable from history

`SalesDayPlain` declares `vatableSales`, `vatExemptSales`, `zeroRatedSales`, `outputVatAmount`
— and the schema map records these as **written by zero code paths**. Historical sales
therefore carry no output-VAT split. Senior/PWD discounts are VAT-exempt in PH, so this is not
cosmetic. Flagging now because it constrains any attempt to rebuild BIR-facing reports from v1
data; it does not block Phase 1.

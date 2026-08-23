# T-102 — Chart of accounts seed

> **Status:** spec ready. **Depends on:** T-101 (done). **Blocks:** T-103, T-108, T-113/T-114.
> **Written by:** Opus planner, 2026-08-23. Bible §3.3 format.
> **Source of truth for the account list:** `docs/decisions/COA-ALIGNMENT.md`, signed off by
> Ian 2026-08-22, amended 2026-08-23 (beverage collapsed to one account).

## Goal

Seed the approved chart of accounts into `accounts` as **migration-owned, idempotent
reference data**, with `legacy_code` set where a stable one-to-one predecessor exists, so the
ETL can trace a v1 posting to a v2 account.

## Why this is reference data, not a fixture

Bible §4.4 — this is the "duplicate Rent category" problem in its general form. Two writers
created the same concept under two ids, and the fix is **not** hardcoding; it is a unique
constraint on identity plus a seed that is applied idempotently **by `code`**.

1. The seed lives in a **migration**, versioned and committed.
2. It is applied **by `code`**, never by id. Re-running creates nothing.
3. Every seeded row is `is_system = true`. **Deactivate, never delete.** Codes are stable
   forever.
4. Admins may add their own accounts later; they simply cannot collide.

---

## Scope

Create or modify **only**:

```
packages/db/seed/chart-of-accounts.ts      the account list, typed and exported
packages/db/migrations/*.sql               a new migration (generated or hand-written)
packages/db/tests/chart-of-accounts.test.ts
```

Do **not** modify `packages/db/schema/*` — T-101's schema is fixed. If the seed cannot be
expressed against it, **stop and report**, do not alter the schema.

## Contract

### 1. Structure

Seven non-postable header accounts, each parent to its range:

`1000` Assets · `2000` Liabilities · `3000` Equity · `4000` Revenue · `5000` Cost of sales ·
`6000` Operating expenses · `7000` Other income and expense

`is_postable = false` on headers. Everything below is `is_postable = true` unless noted.
**Control accounts ARE postable** — the control account carries the balance; the subledger is
a separate table, not a set of accounts.

### 2. The accounts

Take the complete list from `COA-ALIGNMENT.md` §2. Summarised for verification — if this
table and COA-ALIGNMENT disagree, **COA-ALIGNMENT wins and this spec is a bug**:

| Range | Accounts |
|---|---|
| **Assets 1xxx** | 1110 cash-cashier · 1120 cash-staff · 1130 cash-office · 1140 e-wallet/online *(control)* · 1210 AR *(control)* · 1220 channel receivable *(control)* · 1221 clearing-Grab · 1222 clearing-Foodpanda · 1230 advances to employees *(control)* · 1240 advances to suppliers *(control)* · 1250 due from related store · 1310/1320/1330/1340 inventory · 1400 prepaid *(control)* · 1510/1520/1530 property & equipment · 1590 accumulated depreciation *(contra-asset)* |
| **Liabilities 2xxx** | 2110 AP *(control)* · 2130 reimbursements payable · 2140 customer store credits · 2145 unredeemed vouchers · 2150 due to related store · 2210 SSS · 2220 PhilHealth · 2230 Pag-IBIG · 2240 withholding tax · 2250 VAT payable · 2300 salaries payable · 2400 loans payable *(control)* · 2900 suspense — void cash |
| **Equity 3xxx** | 3100 owner's capital · 3200 owner's drawings · 3300 retained earnings · 3900 opening balance equity |
| **Revenue 4xxx** | 4100 food — unlimited · 4150 food — **à la carte, including take-out and delivery** *(4200 withdrawn)* · 4400 beverage · 4900 sales discounts *(contra)* · 4910 loyalty points redeemed *(contra)* · 4920 vouchers redeemed *(contra)* · 4950 sales returns and voids *(contra)* |
| **COGS 5xxx** | 5100 COGS food · 5200 COGS beverage · 5300 wastage and spoilage · 5400 inventory adjustment |
| **OPEX 6xxx** | 6100 salaries · 6110/6120/6130 employer SSS/PhilHealth/Pag-IBIG · 6140 13th month · 6150 salary additions · 6200 rent · 6300 utilities · 6400 platform and channel fees · 6410 online order expenses · 6500 supplies · 6600 repairs · 6700 depreciation · 6750 amortisation · 6800 taxes and licences · 6900 other |
| **Other 7xxx** | 7100 platform settlement gain · 7200 interest expense · 7310 staff charge recovery · 7320 wastage recovery · 7350 cash over and short · 7400 loss on disposal |

### 3. `normal_balance` — declared, never derived

Asset and expense → `debit`. Liability, equity and income → `credit`.

**Two deliberate exceptions**, and they are the whole reason this is a column:

- **1590 accumulated depreciation** is a *contra-asset*: `type = 'asset'`,
  `normal_balance = 'credit'`.
- **4900 / 4910 / 4920 / 4950** are *contra-revenue*: `type = 'income'`,
  `normal_balance = 'debit'`.

> A rule that derives `normal_balance` from `type` gets all six of these wrong. The legacy
> system derived it from an account-name prefix, which is how it got them wrong. **Set the
> column explicitly per account.**

### 4. `status` — active vs reserved

Default `'active'`. **Three** accounts are seeded **`'reserved'`** — 4150 is ACTIVE:

| Account | Why |
|---|---|
| **4920** vouchers redeemed | Not in use; earned-and-spent only |
| **2145** unredeemed vouchers | Pre-built for the day vouchers are *sold* — a flag flip, not a redesign |
| **2250** VAT payable | **Bible §13 row 75: this is a management ledger, not a statutory filing basis. VAT is a label; there is no VAT engine.** Reserved so the code exists without implying a compliance capability the system does not have |

`'reserved'` accounts exist, are visible, and **must not be postable targets** until activated.

### 5. `legacy_code` — only where a stable 1:1 predecessor exists

`legacy_code` is `UNIQUE` per org, so it can only carry a **fixed** v1 account id:
`cash__cashier` → 1110, `equity__capital` → 3100, `liability__void_cash_suspense` → 2900,
`expense__salary` → 6100, and so on.

**Per-entity v1 accounts get NO `legacy_code`.** `ap__{supplierId}`, `ar__{customerId}`,
`staff_advance__{staffId}`, `prepaid__{id}`, `asset__{id}`, `online__{id}` are *thousands* of
v1 accounts collapsing onto **one** control account each. They are mapped **by prefix at ETL
time** (T-113/T-114), not by this column.

> Attempting a 1:1 `legacy_code` for a per-entity prefix is the most likely way to get this
> task wrong. It will fail the UNIQUE constraint on the second supplier.

### 6. Idempotency

The seed applies **by `(org_id, code)`**. Running it twice must produce zero inserts and zero
updates. Prove it in a test, not by inspection.

---

## Invariants the tests must prove

1. Every seeded account has an explicit `normal_balance`; none is null.
2. 1590 is `type='asset'` with `normal_balance='credit'`.
3. All four contra-revenue accounts are `type='income'` with `normal_balance='debit'`.
4. Every non-header account's `parent_id` is the header for its range, and every header is
   `is_postable = false`.
5. No `is_postable = true` account is any other account's parent (T-101's trigger enforces it;
   the seed must not trip it).
6. Re-running the seed inserts nothing and changes nothing.
7. Every `legacy_code` is unique, and **no `legacy_code` contains `{` or `}`** — the guard
   against seeding a per-entity pattern.
8. The **three** `'reserved'` accounts in Contract §4 are reserved (4920, 2145, 2250); every
   other account — **including 4150** — is active.
9. Codes are unique per org, and the same code seeds independently into a second org.
10. Account count matches the COA-ALIGNMENT list exactly — a missing account is a silent P&L
    hole, which is the defect class this project exists to end.

## Out of scope

Posting to these accounts (T-105) · `journal_entries` / `journal_lines` (T-103) · the
per-entity ETL prefix mapping (T-113/T-114) · subledger tables · expense-category → account
mapping (COA-ALIGNMENT §4, its own task) · any change to T-101's schema.

## Done when

- [ ] Seed migration applies cleanly to an empty database, and re-applying is a no-op.
- [ ] All 10 invariants pass against real Postgres.
- [ ] `npm run typecheck` clean · `test` green · `test:integration` green · `build` succeeds.
- [ ] No file outside **Scope** modified.
- [ ] Any disagreement between this spec and `COA-ALIGNMENT.md` is **reported, not resolved
      by the implementer**.

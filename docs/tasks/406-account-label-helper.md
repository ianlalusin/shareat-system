# T-406 — `accountLabel` helper: account words, not account numbers (batch 1)

**Status:** SPEC 2026-10-14, Opus. Work list item 3 (`docs/plans/2026-10-14-ian-answers-worklist.md`), review item 15
(`docs/feedback/2026-10-14-ian-feedback-review.md`). Bible row 229: "never an id, a code or a key". No migration. Size S.

## Goal
Ordinary screens print GL numbers ("Owed (2110)", "posts to 5400", `{a.glAccountCode}`). Replace them with words from one
pure helper. Reports and accountant pages may keep "code · name". Grep (2026-10-14) found **~30 files**, not 16 — this is
**batch 1** (the review's list + `/till`, 19 files); batch 2 is listed under Out of scope.

## Builder — files
1. **NEW** `apps/erp/src/lib/account-label.ts` — pure, no React, no DB. A static `ACCOUNT_WORDS: Record<string,string>`
   (plain words, e.g. `'2110': 'Owed to suppliers'`, `'1220': 'Due from delivery platforms'`, `'5400': 'Stock count
   differences'`) covering every code used by the files below. Names follow `packages/db/seed/chart-of-accounts.ts`
   meaning. Exports: `UNKNOWN_ACCOUNT = 'Other account'`; `accountLabel(code)` -> words, `UNKNOWN_ACCOUNT` on miss/empty,
   never the code; `accountCodeAndName(code)` -> `'2110 · Owed to suppliers'` (reports only).
2. `money-accounts/lib.ts:49` — delete `GL_LABEL`; `money-accounts/page.tsx:120-121` -> `accountLabel(a.glAccountCode)`; :237 prose in words.
3. `money-transfers/page.tsx:158` (bare `{a.glAccountCode}`); `money-transfers/RecordTransferForm.tsx:100` ("6870").
4. `channel-settlements/page.tsx:153,198,294,310`; `channel-settlements/SettlementForm.tsx:338` (renders `d.account` —
   use `accountLabel(d.account)`; keep the `account` field in the 67-72 table), 397-398, 542, 545.
5. `customers/[customerId]/page.tsx:169,186,229,360`; `customers/[customerId]/AutoAllocateCollectionForm.tsx:251,272,297`.
6. `ap/page.tsx:70` ("Owed (2110)" -> "Owed"); `ap/invoices/[id]/page.tsx:316,341` (`cat?.accountCode` -> `accountLabel`,
   keep the "unmapped — will block" branch); `ap/suppliers/[id]/page.tsx:295`; `ap/suppliers/[id]/AutoAllocatePaymentForm.tsx:299`.
7. `payroll/page.tsx:91` (`<code>1230</code>`).
8. `inventory/deliveries/[id]/page.tsx:208`; `inventory/counts/page.tsx:63`; `inventory/counts/[id]/page.tsx:246`.
9. `commissary/discrepancies/page.tsx:71,185,186` (option text "Loss — Dr 5300" -> "Loss (wastage)"; option `value` unchanged).
10. `prepaid/[id]/page.tsx:262-267` — free-text "Account code, e.g. 1110" input -> `<Select name="refundAccountCode">`
    of the money-account codes (1110/1120/1130/1140), option text `accountLabel(code)`, value the code. Server action unchanged.
11. `till/page.tsx:331` — bare `{c.glAccountCode}` (T-404 missed it) -> drop it; the name beside it already says which.
12. `reports/ap-aging/page.tsx:65`, `components/reports/ApAgingTable.tsx:58` — report: use `accountCodeAndName('2110')`.

Rewrite prose sentences so they still read naturally; do not just swap a number for a word mid-sentence if it reads badly.

## Tester — files
- **NEW** `apps/erp/src/lib/account-label.test.ts` — known code -> words; unknown, `''`, `null`/`undefined` -> `'Other account'`;
  for every key, `accountLabel(k) !== k` and contains no digit; every key exists in `CHART_OF_ACCOUNTS` (relative import of
  `packages/db/seed/chart-of-accounts.ts`, as `tests/integration/constraint-message-lookup.test.ts` does).
- **NEW** `apps/erp/tests/t406-account-code-guard.test.ts` — `SWEPT` = the files in items 2-11. Strip comments, strip
  `accountLabel(...)` / `accountCodeAndName(...)` arguments and `value=`/`name=` attributes, then fail if any postable
  `CHART_OF_ACCOUNTS` code appears as a whole word, or `{…accountCode}` / `{…glAccountCode}` is a bare JSX child.
  `ACCOUNTANT_PAGES` allow-list (not scanned, kept explicit): `components/reports/*Table.tsx`, `reports/**`, `cutover/opening`.
  Assert `SWEPT` ∩ `ACCOUNTANT_PAGES` = ∅ and every `SWEPT` path exists (a rename must not silently drop a file).

## Invariants and mutants (each must turn a test red)
- **M1** `accountLabel` returns `code` on a miss -> helper test red.
- **M2** returns `''` on a miss -> helper test red.
- **M3** `accountLabel` returns `accountCodeAndName` output -> digit check red.
- **M4** restore "Owed (2110)" in `ap/page.tsx:70` -> guard red.
- **M5** restore `{a.glAccountCode}` in `money-transfers/page.tsx:158` -> guard red.
- **M6** remove a file from disk / rename -> "every SWEPT path exists" red.

## Out of scope — batch 2 (T-406b, spec later)
`sales-days/SalesDayForm.tsx` (75-184), `sales-days/[id]/page.tsx` (188-252), `settings/sales-channels/page.tsx:157`,
`cash-requests/[id]/page.tsx:87,201`, `commissary/orders/[id]/page.tsx:358`, `budgets/page.tsx:157`. Ledger tables in
`expenses/[id]` and `sales-days/[id]` (`LedgerTable`) are accountant views — batch 2 decides `accountCodeAndName` vs keep.
Not touched: posting logic, chart seed, any migration, the financial-statement tables.

## Done when
`npm run typecheck` clean; both new tests green; M1-M6 each shown red then reverted; grep of the item 2-11 files finds no
bare chart code in rendered text; one screenshot each of `/ap`, `/money-transfers`, `/customers/[id]` showing words.

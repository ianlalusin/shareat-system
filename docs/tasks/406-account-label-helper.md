# T-406 — `accountLabel` helper: account words, not account numbers (batch 1)

**Status:** **BATCH 1 DONE 2026-10-14** (accountLabel on 20 screens); batch 2 SPEC 2026-10-15 (22 files + guard, section below). | SPEC 2026-10-14, Opus. Work list item 3 (`docs/plans/2026-10-14-ian-answers-worklist.md`), review item 15
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

## Batch 2 (T-406b) — SPEC 2026-10-15, Opus. Haiku workers, one file each
**Rulings.** (a) **Ledger tables** in `expenses/[id]` and `sales-days/[id]` -> `accountCodeAndName(l.accountCode)`: the
journal must still match the trial balance by code, and the name makes it readable to the manager who opens it. Drop
`font-mono` on that cell. (b) **Settings pickers that MAP a category or channel to the chart** (`settings/expense-categories`,
the receivable `<Select>` in `settings/sales-channels`) keep `code · name`: admin configuration, codes disambiguate.
(c) Everything else is an operator screen or flash message: **words, or drop the parenthetical code** when the sentence
already names the account. Comments are not touched (the guard ignores them). Imports: `import { accountLabel } from '@/lib/account-label';`.

| # | File (apps/erp/src/…) | Exact change |
|---|---|---|
| 0 | `lib/account-label.ts` | Add to `ACCOUNT_WORDS`: `'1510': 'Equipment and property'`, `'2160': 'Service charge held for staff'`, `'2500': 'Other amounts owed'`, `'4100': 'Unlimited sales'`, `'4150': 'À la carte sales'`, `'4500': 'Other charges income'`, `'4900': 'Sales discounts'`, `'4950': 'Comps, returns and voids'`, `'7350': 'Cash over and short'`, `'7400': 'Loss on disposal of assets'` |
| 1 | `app/sales-days/SalesDayForm.tsx` | Labels: `Unlimited`, `À la carte`, `Comps`, `Service charge (held for staff)`, `Other charges — leftover, packaging`, `Cash (at the cashier)`, `Online / e-wallet`. :84 -> "All three are booked as sales discounts; **comps are booked separately**, never as a discount and never a marketing expense." :99 "are income (4500)" -> "are income"; :101 "float (2160)" -> "float"; :184 "1140 is one account" -> "Online money is one account" |
| 2 | `app/sales-days/[id]/page.tsx` | Row labels :181-204 drop every `→ NNNN` (e.g. "Cash → 1110" -> "Cash"; "Service charge → 2160 float (held for staff)" -> "Service charge (held for staff)"). ~:246 `` `settles later → ${accountLabel(c.receivableAccountCode)}` ``. LedgerTable :541 per ruling (a) |
| 3 | `app/expenses/[id]/page.tsx` | LedgerTable :337 per ruling (a). Leave :170 (`'office'` is not a chart code) |
| 4 | `app/settings/sales-channels/page.tsx` | :157 `` `settled to ${accountLabel(c.receivableAccountCode)}` ``. Picker :337 unchanged (ruling b) |
| 5 | `app/budgets/page.tsx` | :157 `` ` · ${accountLabel(b.accountCode)}` `` |
| 6 | `app/cash-requests/[id]/page.tsx` | :87 "is the balance of `<code>1120</code>` for this request" -> "is the cash the custodian of this request still holds" |
| 7 | `app/commissary/orders/[id]/page.tsx` | :358 "in-transit (1340)" -> "in-transit" |
| 8 | `app/commissary/orders/[id]/actions.ts` | :307 "in transit at cost (1340)" -> "in transit at cost" |
| 9 | `app/trade/orders/[id]/page.tsx` | :260 "in-transit (1340)" -> "in-transit" |
| 10 | `app/trade/orders/actions.ts` | :84 "in transit at cost (1340)" -> "in transit at cost" |
| 11 | `app/fixed-assets/new/page.tsx` | :40 "already in 1510" -> "already on the books as equipment" |
| 12 | `app/fixed-assets/[id]/page.tsx` | :352 "loss on disposal (7400)" -> "loss on disposal" |
| 13 | `app/liabilities/[id]/page.tsx` | :84 "the balance of `<code>2500</code>` for this obligation" -> "what the ledger still shows owed on this obligation"; picker :115 `{a.code} — {a.name}` -> `{a.name}` |
| 14 | `app/remittance/page.tsx` | :296 button -> "Recognise as other income" |
| 15 | `app/remittance/actions.ts` | :240 -> `'Overage recognised as other income.'` |
| 16 | `app/service-charge/page.tsx` | :89 "— `2160`, credits minus debits" -> "— the service charge float, credits minus debits" |
| 17 | `app/statutory-discounts/page.tsx` | :80 "reach account 4900" -> "reach sales discounts in the ledger" |
| 18 | `app/wastage/page.tsx` | :164 option text -> "Store absorbs — booked as wastage" (value unchanged) |
| 19 | `app/wastage/[id]/page.tsx` | :148 -> "Store absorbs — booked as wastage"; :149 -> "Charge staff — split by allocation, as staff advances" (values unchanged) |
| 20 | `app/customers/actions.ts` | :229 "store credit (2140)" -> "store credit"; :290 "bad debt (6860)" -> "bad debt" |
| 21 | `app/inventory/counts/actions.ts` | :158 "posted a variance to 5400" -> "posted a stock count difference" |
| 22 | `app/till/actions.ts` | :144 "against 1230." -> "as an advance to them." |

## Batch 2 — tests (write these FIRST; confirm red for the right reason)
- `apps/erp/tests/t406-account-code-guard.test.ts`: append files 1-22 to `SWEPT` (41 paths; length assertion 19 -> 41,
  rename the `it` to "batch 1 + 2"). Add `'app/settings/expense-categories/**'` to `ACCOUNTANT_PAGES`. Widen
  `BARE_JSX_CHILD` to `/\{\s*(?:[\w$]+\??\.)*\w*[aA]ccountCode\s*\}/` (catches `${c.receivableAccountCode}`) and add `key`
  to the stripped attributes (`\b(value|name|key)=`). Self-check: flags `` `settled to ${c.receivableAccountCode}` `` and
  `<Row label="Cash → 1110" />`; does not flag `{accountCodeAndName(l.accountCode)}` or `key={a.accountCode}`.
  If widening flags a destructuring like `{ receivableAccountCode }` in a batch-1 file, **report it; do not loosen**.
- `apps/erp/tests/t384-s3-lock-and-save-guard.test.ts:74` — key `'Recognise as other income (7350)'` -> `'Recognise as other income'`.
- `apps/erp/src/lib/account-label.test.ts` — no edit: its every-key loops cover the new words (no digit, key in chart).

**Mutants (each red, then reverted):** M7 restore "Cash → 1110" in `sales-days/[id]` · M8 restore `{l.accountCode}` in
`expenses/[id]` LedgerTable · M9 restore `` ${c.receivableAccountCode} `` in `settings/sales-channels` · M10 restore "(7350)"
in `remittance/actions.ts` · M11 add `'4950': '4950 comps'` to `ACCOUNT_WORDS` -> helper test red.

**Run:** `npx vitest run apps/erp/src/lib/account-label.test.ts apps/erp/tests/t406-account-code-guard.test.ts
apps/erp/tests/t384-s3-lock-and-save-guard.test.ts`, then `npm test` (the unit project: every guard and census file),
then `npm run typecheck`. No integration run needed — no file touches the database.

**Done when:** typecheck clean; the three files above green; M7-M11 shown red then reverted; grep of files 1-22 finds no
chart code outside comments, helper arguments and `value=`; screenshots of `/sales-days/[id]` and `/expenses/[id]`
showing the ledger as "code · name" and the sales-day panels in words.

**Not in batch 2 (flagged, not decided here):** the LedgerTable **Party** column prints `partyType:partyId` (a raw id,
row 229) — needs a party-name lookup, its own slice. Flash messages showing `Entry ${entryId.slice(0,8)}` (customers,
commissary, counts). Domain-side finding text with codes (e.g. the T-316 float detector's "(7350)" in `packages/domain`).
Not touched: posting logic, chart seed, any migration, the financial-statement tables.

## Done when
`npm run typecheck` clean; both new tests green; M1-M6 each shown red then reverted; grep of the item 2-11 files finds no
bare chart code in rendered text; one screenshot each of `/ap`, `/money-transfers`, `/customers/[id]` showing words.

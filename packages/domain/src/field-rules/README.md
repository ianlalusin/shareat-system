# Field Rules
## Overview
Client-safe leaf (`@shareat/domain/field-rules`, T-440) that holds ONE definition of "what this field needs" per form. The screen reads a rule set for its live helper line; the server reads the same set for its refusal sentence, so the two cannot drift. `check.ts` is the engine; every other file is plain data for one area of the ERP.

## Interface
- `check.ts`: `defineFieldRules`, `rulesOf`, `ruleInputNames`, `ruleApplies`, `checkField`, `ruleHint`, `nativeAttrs`, `checkAll`; types `FieldKind`, `FieldRule`, `FieldRuleDef`, `FieldRuleSetLike`, `FieldRuleSet`, `FieldCheck`, `FieldInput`, `NativeAttrs`, `RuleFailure`, `CheckAll`.
- `index.ts`: barrel re-exporting `check.ts` and every area file below.
- One `<AREA>_<FORM>_RULES` constant per form (each built with `defineFieldRules('<area>.<form>', {...})`):
  - `admin.ts`: `ADMIN_*` (copy defaults, store create/details/opening date, assign role, grant/revoke, unlink, link Firebase)
  - `ap.ts`: `SUPPLIER_ADD_RULES`, `SUPPLIER_INVOICE_LOG_RULES`, `SUPPLIER_PAYMENT_RULES`, `INVOICE_VOID_RULES`, `PAYMENT_VOID_RULES`, `INVOICE_EXPENSE_RULES`
  - `attendance.ts`: `ATTENDANCE_*` (overtime, start anchor, early out, discard, terminal revoke, leave request/record/void)
  - `budgets.ts`: `BUDGET_CAP_RULES`
  - `cash-requests.ts`: `CASH_REQUEST_*` (create, approve, refuse, release, settle)
  - `channel-settlements.ts`: `CHANNEL_SETTLEMENT_*`, `CHANNEL_PAYOUT_DESTINATION_RULES`
  - `commissary.ts`: `COMMISSARY_*` (link, offering, map, defer, return, order, line, withdraw, reject, receive)
  - `customers.ts`: `CUSTOMER_*`, `PRICE_*`, `COLLECTION_*`, `CHARGE_*`
  - `cutover.ts`: `CUTOVER_FIGURE_RULES`, `CUTOVER_ASSET_RULES`, `CUTOVER_COUNT_RULES`
  - `expenses.ts`: `EXPENSE_*`, `RECURRING_TEMPLATE_RULES`
  - `findings.ts`: `FINDINGS_MISSING_PERIOD_RULES`, `FINDINGS_MISSED_MONTH_RULES`
  - `fixed-assets.ts`: `ASSET_*`
  - `inventory.ts`: `INVENTORY_*` (count, delivery, location, threshold, POS map/void, production, refund, return, transfer, usage void)
  - `items.ts`: `ITEMS_*`; `liabilities.ts`: `LIABILITY_*`; `loans.ts`: `LOAN_ADD_RULES`, `LOAN_DRAW_RULES`, `LOAN_PAYMENT_RULES`, `LOAN_REVERSE_RULES`
  - `menu.ts`: `MENU_*`; `money-accounts.ts`: `MONEY_ACCOUNT_*`; `money-transfers.ts`: `TRANSFER_*`
  - `owners.ts`: `OWNERS_*`; `payroll.ts`: `PAYROLL_*`; `prepaid.ts`: `PREPAID_*`
  - `remittance.ts`: `REMITTANCE_*`, `CASH_POLICY_RULES`; `reports.ts`: `REPORTS_DUAL_RUN_DISPOSITION_RULES`
  - `sales-days.ts`: `SALES_DAY_*`; `service-charge.ts`: `SERVICE_CHARGE_DISTRIBUTE_RULES`
  - `settings.ts`: `SETTINGS_*`; `setup.ts`: `SETUP_FIRST_RUN_RULES`; `staff.ts`: `STAFF_*`
  - `statutory-discounts.ts`: `STATUTORY_DISCOUNT_*`; `till.ts`: `TILL_OPEN_SHIFT_RULES`
  - `trade.ts`: `TRADE_*`, `RETURN_RECORD_RULES`, `RETURN_VOID_RULES`; `wastage.ts`: `WASTAGE_*`
- `clock.ts`, `sign-in.ts`: intentionally empty (`export {}`), placeholders for the sweep.
- Server half lives elsewhere: `../shared/field-rules-assert.ts` (`assertFieldRules`), not in this folder.

## Invariants
- Client-safe leaf: may import only `./*`, `../shared/money-input`, `../shared/manual-cost-pattern`, `@shareat/core/datetime`, `@shareat/core/money`, `@shareat/core/sentence`. No `@shareat/db`, no `refuse` (Audit A1).
- Rules are plain, frozen DATA (a regex is a pattern SOURCE string) so a set can cross the server-to-client prop boundary. A rule cannot be named `form`; `when` must name another field and a non-empty `equals`.
- No sentence interpolates the typed value (government numbers are personal data, Audit A5); only money requirements may quote it, via the parser's own sentence.
- Date rules (`notAfterToday`, `notBeforeToday`) judge against the Manila business date, never the browser's.
- Domain callers apply a set only through `assertFieldRules`, after `authorize()` (T-364 order: nothing about the data is said before the gate).
- New files must be added to `index.ts`; `checkField` throws `TypeError` if given a non-string.

## Side Effects
- None (pure functions). The only environment read is the current Manila business date (`toBusinessDate()`) inside `checkField` for date rules.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)

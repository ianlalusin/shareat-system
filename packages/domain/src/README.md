# @shareat/domain source

## Overview
Business rules that compose repository calls and declare transaction ownership per function (PROJECT_BIBLE.md §4.3). Each subfolder is one business module. This package never imports from `apps/` (bible §8). Most SQL lives in `packages/db/src/repo/`; this layer composes repository calls. Existing attendance sweep/config code also contains raw SQL, as its child contract records.

## Interface
- `index.ts`: the package barrel (`@shareat/domain`). It re-exports every module's public API, plus selected named exports such as `recordDualRunDisposition`, `packageCapExcess`, `normalizePosV1Alias` and `resolvePosV1Methods`.
- `item-code.ts`: a compatibility re-export of `./items/code`. The manifest maps `@shareat/domain/item-code` directly to `./src/items/code.ts`; the root Vitest alias routes it through this wrapper.
- Other `package.json` subpath exports: `./money-lines`, `./money-input`, `./files/limits`, `./field-rules`, `./refusal-leaf`, `./attendance/fingerprint`, `./service-charge`. These are public subpaths, not a blanket browser-safety promise: `./service-charge` reaches server-side authorization and database code. Use only an entry whose transitive dependencies are appropriate for the caller; never import the main barrel into a client bundle.
- The main barrel and the manifest subpaths expose different boundaries. Add a barrel export for APIs intended through `@shareat/domain`; a manifest subpath may expose a leaf independently.
- `dual-run/dispositions` is exported from `index.ts` only, never from `dual-run/index.ts`.
- `index.ts` and the manifest exports map are the source of truth for the package surface.

## Subdirectories & System Boundaries

### Books and money
- ledger: [README](./ledger/README.md) - the only write path to journal entries (`postEntry`, `reverseEntry`, inter-store).
- fiscal-periods: [README](./fiscal-periods/README.md) - period close and year-end close.
- missed-months: [README](./missed-months/README.md) - catch-up booking of a missed month's depreciation.
- reports: [README](./reports/README.md) - financial statements and operational reports.
- findings: [README](./findings/README.md) - integrity findings, the books watchdog.
- expenses: [README](./expenses/README.md) - expense lifecycle; approval is the posting.
- budgets: [README](./budgets/README.md) - expense caps. Nothing posts.
- recurring-expenses: [README](./recurring-expenses/README.md) - templates and the job that drafts them.
- prepaid: [README](./prepaid/README.md) - prepaid items released monthly.
- fixed-assets: [README](./fixed-assets/README.md) - asset register and depreciation.
- liabilities: [README](./liabilities/README.md) - generic liabilities.
- loans: [README](./loans/README.md) - loan agreements, disbursement, repayment.
- owners: [README](./owners/README.md) - owner capital and drawings.
- money-accounts: [README](./money-accounts/README.md) - where money sits; draw-verdict rule.
- money-transfers: [README](./money-transfers/README.md) - transfers between money accounts, inter-store debt.
- cash-requests: [README](./cash-requests/README.md) - cash floats handed to people.
- till: [README](./till/README.md) - till custody, shift open/close, shortages.
- remittance: [README](./remittance/README.md) - pooled cashier handover.
- ap: [README](./ap/README.md) - suppliers, invoices, payments.
- ar: [README](./ar/README.md) - receivables, mirror of `ap`.
- customers: [README](./customers/README.md) - wholesale and credit customers, price lists.
- trade: [README](./trade/README.md) - trade orders and fulfilment.
- channel-settlements: [README](./channel-settlements/README.md) - clearing Foodpanda/Grab receivables.
- statutory-discounts: [README](./statutory-discounts/README.md) - SC/PWD register, outside the books.

### Sales and POS
- sales-days: [README](./sales-days/README.md) - daily sales report lifecycle.
- sales-channels: [README](./sales-channels/README.md) - channel administration, wastage policy.
- service-charge: [README](./service-charge/README.md) - service-charge distribution to staff.
- pos: [README](./pos/README.md) - bridge to the live POS v1 system.
- menu: [README](./menu/README.md) - menu and catalog master.
- activity: [README](./activity/README.md) - offline client-event envelope.

### Stock and production
- stock: [README](./stock/README.md) - quantity, FIFO cost, stock postings.
- stock-locations: [README](./stock-locations/README.md) - rooms and locations for a store's stock.
- items: [README](./items/README.md) - item master.
- deliveries: [README](./deliveries/README.md) - delivery documents and receiving.
- commissary: [README](./commissary/README.md) - commissary-to-branch supply flow.
- production: [README](./production/README.md) - slice, convert, cook runs; recipes.
- wastage: [README](./wastage/README.md) - order and channel wastage.

### People
- people: [README](./people/README.md) - staff master record, positions, rosters.
- attendance: [README](./attendance/README.md) - shift-day calendar, punches, day-pay resolver.
- leave: [README](./leave/README.md) - leave requests, caps, SIL balance.
- payroll: [README](./payroll/README.md) - pay runs, payslips, statutory contributions.

### Platform
- organizations: [README](./organizations/README.md) - standing up an organization.
- stores: [README](./stores/README.md) - store creation and management.
- files: [README](./files/README.md) - upload broker for the storage bucket.
- sync: [README](./sync/README.md) - Postgres/Firestore publisher and ingestor.
- scheduler: [README](./scheduler/README.md) - scheduled-job runners.
- cutover: [README](./cutover/README.md) - v1-to-v2 conversion wizard.
- dual-run: [README](./dual-run/README.md) - v1 vs v2 comparator.
- field-rules: [README](./field-rules/README.md) - client-safe per-form field rules.
- shared: [README](./shared/README.md) - refusals, money and quantity parsers, shared helpers.

## Invariants
- Postgres owns the truth. Every ledger write goes through `ledger/postEntry` or `reverseEntry`.
- Transaction ownership is declared by each function: top-level services may open transactions, while tx-level engines and composed workflows join the caller's transaction.
- Authorization goes through the single `authorize()` in `packages/auth`.
- Refusals use the shared refusal producer in `shared/`, not ad hoc errors.
- Client code uses an explicitly browser-safe leaf; a manifest subpath alone does not guarantee browser safety.
- Read `docs/GLOSSARY.md` before naming anything. Several field names mean the opposite of what they look like.

## Side Effects
- Writes PostgreSQL through `@shareat/db` repos (journal entries, documents, stock layers).
- Scheduler and sync modules drive Firestore mirror publish and inbox relay, and storage-bucket access via `files`.
- Several modules read the clock, so tests inject it.

## Verification
- Run: `npm test` (from the repo root; vitest unit project)

## `field-rules/` (no README inside: T-S1-7 keeps that folder to .ts files only)

### Overview
Client-safe leaf (`@shareat/domain/field-rules`, T-440) that holds ONE definition of "what this field needs" per form. The screen reads a rule set for its live helper line; the server reads the same set for its refusal sentence, so the two cannot drift. `check.ts` is the engine; every other file is plain data for one area of the ERP.

### Interface
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

### Invariants
- Client-safe leaf: may import only `./*`, `../shared/money-input`, `../shared/manual-cost-pattern`, `@shareat/core/datetime`, `@shareat/core/money`, `@shareat/core/sentence`. No `@shareat/db`, no `refuse` (Audit A1).
- Rules are plain, frozen DATA (a regex is a pattern SOURCE string) so a set can cross the server-to-client prop boundary. A rule cannot be named `form`; `when` must name another field and a non-empty `equals`.
- No sentence interpolates the typed value (government numbers are personal data, Audit A5); only money requirements may quote it, via the parser's own sentence.
- Date rules (`notAfterToday`, `notBeforeToday`) judge against the Manila business date, never the browser's.
- Domain callers apply a set only through `assertFieldRules`, after `authorize()` (T-364 order: nothing about the data is said before the gate).
- New files must be added to `index.ts`; `checkField` throws `TypeError` if given a non-string.

### Side Effects
- None (pure functions). The only environment read is the current Manila business date (`toBusinessDate()`) inside `checkField` for date rules.

### Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)

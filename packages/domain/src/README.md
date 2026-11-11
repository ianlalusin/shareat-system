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

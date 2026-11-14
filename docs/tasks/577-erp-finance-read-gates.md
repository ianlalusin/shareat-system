# T-577 — ERP finance screens: read gates by capability and store (DEF-834, bible row 461)

Status: SPEC (BOSS, 2026-11-13). Auth: Sonnet builder + Sonnet auditor. No migration.

## Ruling
Ian, 13 Nov: add `/ap`, `/budgets`, `/cash-requests` to `ROUTE_CAPABILITY`; store-scope the single-record pages
`expenses/[id]`, `sales-days/[id]`, `wastage/[id]`.

## Build
1. Read `apps/erp/src/lib/route-capability.ts` and its coverage test. Gate the three routes with the capability the
   screen's own actions already need for reading (choose from `docs/decisions/CAPABILITY-MATRIX.md`; if no read
   capability exists, the narrowest existing one its real users already hold). Name the choice in the PR. Never
   invent a capability without a CAPABILITY-MATRIX row.
2. The three single-record pages load the record, then `authorize(... { storeId: record.storeId })` before rendering;
   a record outside scope shows the standard not-found (not "forbidden", which leaks that it exists).
3. Child routes under the three list pages (e.g. `/ap/suppliers/[id]`, `/cash-requests/[id]`) get the same gate.

## Tests
- Per route: signed-in user without the capability refused; with it allowed.
- Per single-record page: store A user + store B record -> not found; store A record -> shown.
- Every ✅ has a test proving the ✗ fires (CAPABILITY-MATRIX rule). Route-capability coverage test updated.

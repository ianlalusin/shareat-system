# Organizations
## Overview
Standing up an organization (T-228, closes DEF-195): create the org row, its first admin, its first store and fiscal periods in the only order that works (no PIN without a store, no store without an admin, no admin without an org). Also holds the registered-identity fields and the pure identifier normalisers.

## Interface
- `index.ts`: `createOrganization`, `createFirstAdmin`, `bootstrapOrganization`, `setOrganizationIdentity`, `organizationIdentity`, `fiscalPeriodSeedWindow`, re-export `normaliseBranchCode`, types `CreateOrganizationInput`, `CreateOrganizationResult`, `CreateFirstAdminInput`, `CreateFirstAdminResult`, `BootstrapOrganizationInput`, `BootstrapOrganizationResult`, `OrganizationIdentity`.
- `identifiers.ts` (pure): `normaliseDigits`, `normaliseBranchCode` (3-5 digits).

## Invariants
- `createOrganization` takes no `Actor` and must not gain one: there is no principal before the org exists.
- `bootstrapOrganization` takes an already-open `Tx` and never opens one; its only callers are `scripts/bootstrap-org.ts` and `apps/erp/src/app/setup/actions.ts`.
- `organizations.code` UNIQUE is the real guard against double-runs; the pre-check only produces a readable error.
- The first store is part of the bootstrap (needed for the first PIN); later steps reuse `createStore` and its admin fan-out.
- Identifier normalisation is format-only (no checksum, no TIN-to-branch rule); the database holds the same rule and is the authority. Widen the pattern rather than dropping the check.
- `identifiers.ts` is a leaf module that exists to break an `organizations`/`stores` import cycle; nothing may import back out of it.

## Side Effects
- Writes the organization row and its seeds (chart of accounts, expense categories, 12 months of fiscal periods, canonical positions), the first admin person/role and the first store via repos in the caller's `Tx`.
- Reads the clock (`now` defaults to `new Date()` in `fiscalPeriodSeedWindow`).
- `identifiers.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)

# fixed-assets

## Overview

Fixed assets at `/fixed-assets`. Asset register, service dates, depreciation, disposal and opening valuation.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/fixed-assets`; dynamic route segments are supplied through App Router params.
- [lib.ts](./lib.ts) — `listActiveStores`, `RegisterRow`, `listRegister`, `getAsset`, `readPolicyForDisplay`, `CATEGORY_LABEL`, `INTERVAL_LABEL`, `currentPeriod`, `listStores`, `withOrgPrincipal`, `StoreOption`.
- [actions.ts](./actions.ts) — `createAssetAction`, `updateTermsAction`, `setAssetInServiceAction`, `disposeAssetAction`, `runDepreciationAction`.
- [page.tsx](./page.tsx) — `FixedAssetsPage`.
- [typed-forms.ts](./typed-forms.ts) — `ASSET_TERMS_EDIT`, `ASSET_IN_SERVICE_EDIT`.
- [[id]](./[id]/README.md) — Handlers and helpers at `/fixed-assets/[id]`. Asset register, service dates, depreciation, disposal and opening valuation.
- [new](./new/README.md) — Add asset at `/fixed-assets/new`. Asset register, service dates, depreciation, disposal and opening valuation.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `runDepreciationAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `createAsset`, `setAssetInService`, `updateAssetTerms`, `recordingRefusalsFor`, `recordApproval`; persistence or external operations belong to those called services.
- Repository calls: `fixedAssetsRepo.listAssets`, `fixedAssetsRepo.accumulatedByAsset`, `fixedAssetsRepo.getById`, `fixedAssetsRepo.accumulatedFromLedger`, `fixedAssetsRepo.postedDepreciationPeriods`, `fixedAssetsRepo.findPolicy`. These execute through the surrounding transaction context.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 4 local production/configuration files scanned; 30,434 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.

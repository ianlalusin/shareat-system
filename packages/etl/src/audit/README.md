# Legacy balance audit

## Overview

Reconstructs landed journal balances, cross-checks v1 cached accounts, classifies source groups and renders the resulting audit report.

## Interface

- [balances.ts](./balances.ts): includes `OPERATING_STORES`, `EXCLUDED_STORES`, `DEFAULT_STORE_IDS`, `PartyType`, `resolveV1Account`, `PARTY_CONTROL_ACCOUNTS`, `accountIdEncodedParty`, `LandedDocLike`, `filterJournalDocs`, `V1JournalLeg`, `parseJournalLeg`, `AccountBalance`.
- [compare.ts](./compare.ts): includes `OneSided`, `AccountCrossCheckRow`, `PartyCrossCheckRow`, `UnmappedV1Account`, `CrossCheckResult`, `filterAccountsDocs`, `crossCheck`.
- [groups.ts](./groups.ts): includes `GroupClass`, `GroupResult`, `ClassifyGroupsResult`, `classifyGroups`.
- [report.ts](./report.ts): includes `AuditReportInput`, `renderAuditReport`.

## Invariants

- Use landed documents supplied by the caller; these audit transforms do not open Firestore or PostgreSQL clients.
- Compare exact money values and surface unmapped or non-centavo legacy data. A v1 cached balance is evidence to cross-check, not the rebuilt authority.
- Report rendering presents the computed basis and findings; it must not silently invent a balancing correction.

## Side Effects

- Transforms and report rendering operate in memory. The CLI owns reading landed data and saving report files.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.

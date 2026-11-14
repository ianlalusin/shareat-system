# Authentication and authorization source

## Overview

Server identity resolution, capability decisions and approval checks, with a separate dependency-light error entry.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [admin-approval.ts](./admin-approval.ts): includes `ADMIN_PIN_REFUSED`, `AdminApprovalInput`, `verifyAdminApproval`.
- [authorize.ts](./authorize.ts): includes `Actor`, `AuthorizeContext`, `authorize`, `can`, `canAt`.
- [capabilities.ts](./capabilities.ts): includes `ROLES`, `Role`, `Capability`.
- [errors.ts](./errors.ts): includes `AuthenticationError`, `AuthorizationError`.
- [pos-approval.ts](./pos-approval.ts): includes `POS_APPROVAL_REFUSED`, `POS_APPROVAL_PIN_CAPPED`, `POS_TERMINAL_NOT_REGISTERED`, `PosApprovalInput`, `verifyPosManagerApproval`.

## Invariants

- authorize(actor, capability, context) throws on refusal; can/canAt are visibility probes and do not replace mutation gates.
- Role, store scope and explicit grants are distinct inputs. Keep capability definitions and the documented matrix consistent.
- Import errors through @shareat/auth/errors when only error classes are needed; the main barrel reaches database-backed modules.
- POS approval derives its store and terminal identity from the registered server-side link; a client approval flag is never trusted.

## Side Effects

- Database-backed identity, grants and approval paths read/write PostgreSQL and may append security audit events.
- PIN approval charges are committed independently so a subsequent refusal cannot erase the attempt.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.

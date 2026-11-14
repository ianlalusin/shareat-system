# Audit payload contracts

## Overview

Closed event catalogue, deterministic JSON encoding and secret redaction used by the audit repository.

## Interface

- [canonical-json.ts](./canonical-json.ts): includes `canonicalJson`.
- [catalogue.ts](./catalogue.ts): includes `AuditCategory`, `AuditSensitivity`, `AuditRetention`, `CatalogueEntry`, `severityFor`, `retentionFor`, `AUDIT_CATALOGUE`.
- [redact.ts](./redact.ts): includes `REDACTED`, `keyTokens`, `isSecretKey`, `RedactOptions`, `RedactResult`, `redactPayload`.

## Invariants

- Catalogue entries govern event category, sensitivity, retention and permitted scope/source; callers do not invent these attributes.
- Canonical JSON sorts object keys recursively and preserves array order, so reordered keys do not change event identity.
- Redaction tokenizes keys and also recognizes secret-looking values; account-number masking preserves only the permitted suffix.

## Side Effects

- These helpers transform in-memory data. Persistence and event-envelope acceptance belong to the audit-log repository.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.

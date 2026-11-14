# apps

## Overview

Front ends grouped in one workspace with shared package dependencies.

## Interface

- erp is the staff/business application; pos is the till/ordering app; customer is the fixture-backed diner skeleton.
- Observed workspace dev/start ports are ERP 9008, POS 9009 and Customer 9010. apps/website currently has no code-bearing contract.
- [customer](./customer/README.md) — child interface, invariants and side effects.
- [erp](./erp/README.md) — child interface, invariants and side effects.
- [pos](./pos/README.md) — child interface, invariants and side effects.

## Invariants

- An app may import packages but never another app; packages never import apps.
- Each app owns its runtime/build directory. Stop the relevant dev server before building that app.

## Side Effects

- App commands open their reserved ports; runtime effects are documented per child, including live backend paths where present.

## Verification

- From the repository root: `npm run test`, `npm test -w @shareat/pos`, and `npm test -w @shareat/customer` select the separate unit configurations.

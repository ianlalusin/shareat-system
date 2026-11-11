# src/lib/products contract

## Overview

Shared product-family, variant label, sellable-SKU and image-fallback helpers.

## Interface

- [variants.ts](./variants.ts) — `ProductLike`, `getKind`, `getEffectiveVariantLabel`, `isSellableSku`, `getGroupKey`, `getGroupTitle`, `getDisplayName`, `resolveFamilyImageUrl`, `FamilyRow`, `groupIntoFamilies`.

## Invariants

- An item-specific image takes precedence over inherited family imagery.
- Helpers accept a structural ProductLike input rather than requiring a full persisted entity.

## Side Effects

- Computes labels, groups and image choices without writes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (5444 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.

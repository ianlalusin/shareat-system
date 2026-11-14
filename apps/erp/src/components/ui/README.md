# ui

## Overview

Shared UI primitives, status vocabulary, dialogs, form layout and responsive workspaces.

Parent blueprint: [up one directory](../README.md).

## Interface

- [index.ts](./index.ts) — `Button`, `ButtonProps`, `ButtonVariant`, `Input`, `InputProps`, `Card`, `CardProps`, `FormGrid`, `Field`, `FormSection`, `CardGrid`, `FormGridProps`, `FieldProps`, `Badge`, `BadgeProps`, `Banner`, `BannerProps`, `BannerTone`, `FlashBanner`, `Select`, `SelectProps`, `Textarea`, `TextareaProps`, `Checkbox`, `CheckboxProps`, `Table`, `Th`, `Td`, `NumTd`, `LinkRow`, `RowLink`, `RowAction`, `ROW_LINK_STRETCH`, `TableCardSummary`, `EmptyState`, `EmptyStateProps`, `EmptyStateIllustration`, `StatusIcon`, `STATUS_ICON_KINDS`, `StatusIconKind`, `statusTone`, `statusLabel`, `STATUS_TONE`, `unmappedStatuses`, `Tone`, `StatusHero`, `StatusHeroProps`, `ConfirmDestructive`, `ConfirmDestructiveProps`, `SplitWorkspace`, `Dialog`, `FormModal`, `DialogProps`, `DialogSize`, `FormModalProps`, `HelpTip`, `HelpTipProps`, `DisclosureCard`.
- [Badge.tsx](./Badge.tsx) — `BadgeProps`, `Badge`.
- [Banner.tsx](./Banner.tsx) — `BannerTone`, `BannerProps`, `Banner`.
- [Button.tsx](./Button.tsx) — `ButtonVariant`, `ButtonProps`, `Button`.
- [Card.tsx](./Card.tsx) — `CardProps`, `Card`.
- [Checkbox.tsx](./Checkbox.tsx) — `CheckboxProps`, `Checkbox`.
- [ConfirmDestructive.tsx](./ConfirmDestructive.tsx) — `ConfirmDestructiveProps`, `ConfirmDestructive`.
- [Dialog.tsx](./Dialog.tsx) — `DialogSize`, `DialogProps`, `Dialog`, `FormModalProps`, `FormModal`.
- [DisclosureCard.tsx](./DisclosureCard.tsx) — `DisclosureCard`.
- [EmptyState.tsx](./EmptyState.tsx) — `EmptyStateIllustration`, `EmptyStateProps`, `EmptyState`.
- [FlashBanner.tsx](./FlashBanner.tsx) — `FlashBanner`.
- [FormGrid.tsx](./FormGrid.tsx) — `FormGridProps`, `FormGrid`, `FieldProps`, `Field`, `CardGrid`, `FormSection`.
- [HelpTip.tsx](./HelpTip.tsx) — `HelpTipProps`, `HelpTip`.
- [Input.tsx](./Input.tsx) — `InputProps`, `Input`.
- [Select.tsx](./Select.tsx) — `SelectProps`, `Select`.
- [SplitWorkspace.tsx](./SplitWorkspace.tsx) — `SplitWorkspace`.
- [StatusHero.tsx](./StatusHero.tsx) — `StatusHeroProps`, `StatusHero`.
- [StatusIcon.tsx](./StatusIcon.tsx) — module implementation.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.
- Status controls pair tone with words/icons; dialogs and destructive confirmations retain keyboard/focus behavior. The barrel exports both server-safe primitives and explicitly client-side controls.

## Side Effects

- Renders shared controls; client dialogs/disclosures manage open state, focus and document interaction. Business writes occur only through the callbacks/forms supplied by consumers.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 18 local production/configuration files scanned; 50,000 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.

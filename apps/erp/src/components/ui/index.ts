// T-334 slice 3: the one import path for the shared UI primitives (`@/components/ui`).
// Created by the orchestrator before tranche 1 so parallel adopters never race to create it.
export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';
export { Input } from './Input';
export type { InputProps } from './Input';
export { Card } from './Card';
export type { CardProps } from './Card';
export { FormGrid, Field, FormSection } from './FormGrid';
export type { FormGridProps, FieldProps } from './FormGrid';
// T-387 S3: the missing kit.
export { Badge } from './Badge';
export type { BadgeProps } from './Badge';
export { Banner } from './Banner';
export type { BannerProps, BannerTone } from './Banner';
export { FlashBanner } from './FlashBanner';
export { Select } from './Select';
export type { SelectProps } from './Select';
export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { Table, Th, Td, NumTd, LinkRow, RowLink, RowAction, ROW_LINK_STRETCH } from './Table';
export type { TableCardSummary } from './Table';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps, EmptyStateIllustration } from './EmptyState';
export { StatusIcon, STATUS_ICON_KINDS } from './StatusIcon';
export type { StatusIconKind } from './StatusIcon';
export { statusTone, statusLabel, STATUS_TONE, unmappedStatuses } from './status-tone';
export type { Tone } from './status-tone';
// T-387 S6: the big state.
export { StatusHero } from './StatusHero';
export type { StatusHeroProps } from './StatusHero';
export * from './status-steps';
// T-412: the one danger button, two tiers (retype the name / an administrator's PIN).
export { ConfirmDestructive } from './ConfirmDestructive';
export type { ConfirmDestructiveProps } from './ConfirmDestructive';

export { SplitWorkspace } from './SplitWorkspace';

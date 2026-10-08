// T-334 slice 3: the one import path for the shared UI primitives (`@/components/ui`).
// Created by the orchestrator before tranche 1 so parallel adopters never race to create it.
export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';
export { Input } from './Input';
export type { InputProps } from './Input';
export { Card } from './Card';
export type { CardProps } from './Card';
export { FormGrid, Field } from './FormGrid';
export type { FormGridProps, FieldProps } from './FormGrid';
export { EditableRecord } from './EditableRecord';
export type { EditableRecordProps } from './EditableRecord';

'use client';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { FormDisclosure, formActionLabel } from './FormDisclosure';

/** Raw mutation entry forms share CheckedForm's reveal without changing native form semantics. */
export const ActionForm = forwardRef<HTMLFormElement, ComponentPropsWithoutRef<'form'> & { revealLabel?: ReactNode }>(
  function ActionForm({ children, revealLabel, ...props }, ref) {
    return <FormDisclosure label={revealLabel ?? formActionLabel(children)}><form {...props} ref={ref}>{children}</form></FormDisclosure>;
  },
);

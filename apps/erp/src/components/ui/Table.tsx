/**
 * Table, Th, Td, NumTd — T-387 S3. `Table` is a horizontally scrolling box around a full-width `<table>`;
 * the header cell is `bg-canvas`; `NumTd` is the numeric column (`tabular-nums text-right`).
 * A caller className is appended on every part. No `'use client'`, no hooks.
 */
import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

const join = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

export function Table({ className, children }: { readonly className?: string; readonly children?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className={join('w-full border-collapse text-sm text-ink', className)}>{children}</table>
    </div>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  readonly numeric?: boolean;
}

export function Th({ numeric = false, className, scope = 'col', ...rest }: ThProps) {
  return (
    <th
      scope={scope}
      className={join(`bg-canvas px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted ${numeric ? 'text-right' : 'text-left'}`, className)}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={join('border-t border-surface-border px-3 py-2', className)} {...rest} />;
}

export function NumTd({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={join('border-t border-surface-border px-3 py-2 tabular-nums text-right', className)} {...rest} />;
}

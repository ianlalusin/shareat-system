/**
 * Table, Th, Td, NumTd — T-387 S3. `Table` is a horizontally scrolling box around a full-width `<table>`;
 * the header cell is `bg-canvas`; `NumTd` is the numeric column (`tabular-nums text-right`).
 * A caller className is appended on every part. No `'use client'`, no hooks.
 */
import Link from 'next/link';
import type { ComponentProps, HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

const join = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

/** T-258/T-411: the ::after box covers the nearest `relative` ancestor — the LinkRow. The ONE copy of this class. */
export const ROW_LINK_STRETCH = "after:absolute after:inset-0 after:content-['']";
/** A row that is one tap target. `relative` is what the RowLink's ::after stretches to; h-11 = 44px minimum. */
export function LinkRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={join('relative h-11 hover:bg-canvas focus-within:bg-canvas', className)} {...rest} />;
}
/** The row's ONE link: a real anchor with an accessible name (T-258 point 4), stretched over the whole row. */
export function RowLink({ className, ...rest }: ComponentProps<typeof Link>) {
  return <Link className={join(`underline underline-offset-2 ${ROW_LINK_STRETCH}`, className)} {...rest} />;
}
/** Anything else in a linked row (a form, a second link, an input) sits ABOVE the stretched box. */
export function RowAction({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={join('relative z-10 inline-block', className)} {...rest} />;
}

export function Table({ className, children }: { readonly className?: string; readonly children?: ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-[20px] border border-surface-border">
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

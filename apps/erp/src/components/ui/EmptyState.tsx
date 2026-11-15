/**
 * EmptyState — T-387 S3. Three inline illustrations (truck, flame, magnifier) from docs/design/t387/Feedback.dc.html,
 * drawn in `currentColor` and token classes (the board's hex values are not copied). Page content, not a live region.
 * The flame's flicker is `.empty-flame` in app/globals.css, inside the no-preference block.
 * No `'use client'`, no hooks (Guard 10).
 */
import type { ReactNode } from 'react';

export type EmptyStateIllustration = 'truck' | 'flame' | 'magnifier';

export interface EmptyStateProps {
  readonly illustration: EmptyStateIllustration;
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
  /** T-583: `sm` draws the same picture at 60x45 with tighter spacing, for a card. */
  readonly size?: 'md' | 'sm';
}

function Illustration({ name, size }: { readonly name: EmptyStateIllustration; readonly size: 'md' | 'sm' }) {
  return (
    <svg
      aria-hidden="true"
      data-illustration={name}
      viewBox="0 0 120 90"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={size === 'sm' ? 'h-[45px] w-[60px] text-ink' : 'h-[90px] w-[120px] text-ink'}
    >
      {name === 'truck' ? (
        <>
          <path d="M18 34h48v28H18zM66 42h16l10 10v10H66" />
          <circle cx="32" cy="66" r="6" className="fill-surface" />
          <circle cx="80" cy="66" r="6" className="fill-surface" />
          <path d="M6 76h108" strokeDasharray="6 6" className="text-muted" />
        </>
      ) : null}
      {name === 'flame' ? (
        <>
          <path d="M22 52h76M28 60h64M34 68h52" />
          <g className="empty-flame">
            <path
              d="M60 18s12 10 12 22a12 12 0 0 1-24 0c0-6 5-9 5-9s1 5 4 6c0-8 3-13 3-19z"
              className="fill-danger-surface stroke-danger"
            />
          </g>
        </>
      ) : null}
      {name === 'magnifier' ? (
        <>
          <circle cx="52" cy="40" r="20" />
          <path d="m67 55 18 18" />
          <path d="M44 40h16" className="text-muted" />
        </>
      ) : null}
    </svg>
  );
}

export function EmptyState({ illustration, title, body, action, size = 'md' }: EmptyStateProps) {
  const sm = size === 'sm';
  return (
    <div className={sm ? 'flex flex-col items-center gap-1 rounded-[20px] border border-dashed border-surface-border p-4 text-center' : 'flex flex-col items-center gap-2 rounded-[20px] border border-dashed border-surface-border p-8 text-center'}>
      <Illustration name={illustration} size={sm ? 'sm' : 'md'} />
      <b className={sm ? 'text-sm font-bold text-ink' : 'text-lg font-bold text-ink'}>{title}</b>
      {body ? <p className={sm ? 'text-xs text-muted' : 'text-sm text-muted'}>{body}</p> : null}
      {action ?? null}
    </div>
  );
}

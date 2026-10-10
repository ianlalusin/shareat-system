/**
 * Banner — T-387 S3. `role="alert"` for error, `role="status"` for the rest; one inline icon per tone (colour is
 * never the sole channel). Optional `fieldId` + `fieldLabel` renders a "Go to <label>" anchor to the field.
 * No `'use client'`, no hooks (Guard 10). Tokens only (Guards 7-9): warning text is `text-warning-ink`, error is
 * the soft surface `bg-danger-surface`.
 */
import type { ReactNode } from 'react';

export type BannerTone = 'error' | 'warning' | 'success' | 'info';

export interface BannerProps {
  readonly tone: BannerTone;
  readonly children?: ReactNode;
  readonly fieldId?: string;
  readonly fieldLabel?: string;
  readonly className?: string;
}

const TONE_CLASSES: Readonly<Record<BannerTone, string>> = {
  error: 'bg-danger-surface text-danger',
  warning: 'bg-warning-soft text-warning-ink',
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
};

function Icon({ tone }: { readonly tone: BannerTone }) {
  const common = {
    'aria-hidden': true as const,
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'mt-0.5 shrink-0',
  };
  switch (tone) {
    case 'error':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6M12 16.5v.5" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 3 2 20h20z" />
          <path d="M12 10v4M12 17v.5" />
        </svg>
      );
    case 'success':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.5 3 3 5-6" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.5" />
        </svg>
      );
  }
}

export function Banner({ tone, children, fieldId, fieldLabel, className }: BannerProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-3 rounded-[10px] px-4 py-3 text-sm ${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
    >
      <Icon tone={tone} />
      <div className="min-w-0 flex-1">
        {children}
        {fieldId && fieldLabel ? (
          <>
            {' '}
            <a href={`#${fieldId}`} className="inline-flex min-h-6 items-center font-semibold underline">
              {`Go to ${fieldLabel}`}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * StatusIcon — T-387 S3. The 11 icons from docs/design/t387/OrderStatus.dc.html as inline SVG in `currentColor`
 * (the caller sets the colour with a token class). The motion is CSS only: the keyframes live in app/globals.css
 * inside `@media (prefers-reduced-motion: no-preference)`, so reduced motion gets still icons.
 * No `'use client'`, no hooks (Guard 10).
 */
export type StatusIconKind =
  | 'draft'
  | 'submitted'
  | 'preparing'
  | 'ready'
  | 'dispatched'
  | 'received'
  | 'disputed'
  | 'cancelled'
  | 'rejected'
  | 'void'
  | 'counting';

export const STATUS_ICON_KINDS: readonly StatusIconKind[] = [
  'draft', 'submitted', 'preparing', 'ready', 'dispatched', 'received', 'disputed', 'cancelled', 'rejected', 'void', 'counting',
];

function Shape({ kind }: { readonly kind: StatusIconKind }) {
  switch (kind) {
    case 'draft':
      return (
        <>
          <path className="si-ink" d="M4 21h14" />
          <g className="si-pen">
            <path d="M14.5 4.5l3 3L9 16l-4 1 1-4z" />
          </g>
        </>
      );
    case 'submitted':
      return (
        <g className="si-plane">
          <path d="M21 3 3 10.5l7 2.5 2.5 7z" />
          <path d="M21 3 10 13" />
        </g>
      );
    case 'preparing':
      return (
        <>
          <path d="M3 13h14a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM17 14h4" />
          <path className="si-steam" d="M8 9c-1-1.5 1-2 0-4" />
          <path className="si-steam-late" d="M12 9c-1-1.5 1-2 0-4" />
        </>
      );
    case 'ready':
      return (
        <>
          <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
          <path className="si-check" d="m8.5 12.5 2.5 2.5 4.5-5" />
        </>
      );
    case 'dispatched':
      return (
        <>
          <path className="si-road" d="M-2 21h28" />
          <g className="si-truck">
            <path d="M2 6h12v10H2zM14 9h4l3 3.5V16h-7" />
            <circle cx="6" cy="17.5" r="1.8" />
            <circle cx="17" cy="17.5" r="1.8" />
          </g>
        </>
      );
    case 'received':
      return (
        <>
          <path d="M3 20h18" />
          <g className="si-drop">
            <path d="M6 9h12v9H6zM6 9l2-4h8l2 4" />
          </g>
        </>
      );
    case 'disputed':
      return (
        <g className="si-shake">
          <path d="M12 4v15M7 19h10M4 8h16M4 8l-2.5 6a2.5 2.5 0 0 0 5 0zM20 8l-2.5 6a2.5 2.5 0 0 0 5 0z" />
        </g>
      );
    case 'cancelled':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path className="si-x" d="m8.5 8.5 7 7M15.5 8.5l-7 7" />
        </>
      );
    case 'rejected':
      return (
        <>
          <g className="si-stamp">
            <path d="M9 3h6v5l3 3H6l3-3zM5 14h14v3H5z" />
          </g>
          <path d="M4 21h16" />
        </>
      );
    case 'void':
      return (
        <>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 11h7M9 15h5" />
          <path className="si-strike" d="M4 19 20 6" />
        </>
      );
    case 'counting':
      return (
        <g className="si-spin">
          <path d="M12 3a9 9 0 1 1-9 9" />
        </g>
      );
  }
}

export function StatusIcon({ kind, className }: { readonly kind: StatusIconKind; readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`status-icon status-icon-${kind} h-11 w-11 overflow-visible${className ? ` ${className}` : ''}`}
    >
      <Shape kind={kind} />
    </svg>
  );
}

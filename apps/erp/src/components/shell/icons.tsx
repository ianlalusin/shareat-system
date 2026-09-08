/**
 * T-234 slice 1 — the shell's icon set.
 *
 * ⛔ **Hand-drawn for this project, not copied from Heroicons.** The original spec called for
 * pasting Heroicons outline paths verbatim (MIT); we could not verify exact path fidelity against
 * the real library without a network fetch, and reconstructing bezier path data from memory is
 * exactly how a false "MIT, pasted" provenance claim ships looking right by accident. The
 * orchestrator's call (2026-09-08): hand-draw instead, say so plainly, no dependency either way.
 * These are simple 24×24 stroke icons in the same visual idiom (rounded caps/joins, 1.5 stroke) —
 * original artwork, not a derivative of any icon library's path data.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      // ⭐ Review round 2 nit: explicit intrinsic size, not just `viewBox`. Every caller sizes these
      // with a Tailwind class (`h-4 w-4` etc.), which still wins visually, but a bare `<svg>` with
      // no `width`/`height` renders at the browser's 300×150 default for one paint before CSS
      // applies — these two attributes are what CSS is overriding, not a substitute for it.
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** ☰ — opens the phone drawer. */
export function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
    </IconBase>
  );
}

/** Closes the drawer, or a scrim/dialog. */
export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 18 18 6M6 6l12 12" />
    </IconBase>
  );
}

/** A group heading's expand/collapse toggle — rotate via `className` for the open state. */
export function ChevronIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </IconBase>
  );
}

/** The rail's "expand to full sidebar" / "collapse to rail" toggle — rotate 180° for the reverse
 *  direction, the same way `ChevronIcon` does. */
export function CollapseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.75" y="4.5" width="16.5" height="15" rx="2" />
      <path d="M9 4.5v15" />
      <path d="M13.75 10.5 11.5 12l2.25 1.5" />
    </IconBase>
  );
}

/** Daily — sales days, attendance, payroll, expenses: the day-to-day operating group. */
function DailyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2" />
      <path d="M8 3v4.5M16 3v4.5M3.75 9.75h16.5" />
    </IconBase>
  );
}

/** Inventory — stock, receiving, production. */
function InventoryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.75 8.25h16.5v11.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V8.25Z" />
      <path d="M3 5.25A1.5 1.5 0 0 1 4.5 3.75h15A1.5 1.5 0 0 1 21 5.25v3H3v-3Z" />
      <path d="M10.25 12h3.5" />
    </IconBase>
  );
}

/** Money — accounts, transfers, fixed assets, owners. */
function MoneyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.25" y="6.75" width="19.5" height="10.5" rx="1.5" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M5.5 9h.01M18.5 15h.01" />
    </IconBase>
  );
}

/** Trade — supplier invoices, customers, trade orders. */
function TradeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 7.5h13.5M16.5 7.5 12.75 3.75M16.5 7.5 12.75 11.25" />
      <path d="M21 16.5H7.5M7.5 16.5 11.25 12.75M7.5 16.5 11.25 20.25" />
    </IconBase>
  );
}

/** Reports — findings, statements, reconciliation. */
function ReportsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20.25h16.5M6.75 20.25V13.5M12 20.25V8.25M17.25 20.25v-9" />
    </IconBase>
  );
}

/** Setup — users, stores, settings; drawn as adjustment sliders rather than a gear, which is much
 *  easier to hand-draw correctly at this size. */
function SetupIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13M21 18h-1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="7" cy="12" r="2" />
      <circle cx="19" cy="18" r="2" />
    </IconBase>
  );
}

/** The six `GROUPS` labels in `nav.tsx`, as string keys — never a component reference. A component
 *  function cannot cross the server → client boundary as a prop (T-234 QUESTION 4 / the
 *  orchestrator's answer), so every consumer imports this map itself and looks the icon up
 *  locally, rather than receiving it pre-resolved. */
export type GroupIconKey = 'daily' | 'inventory' | 'money' | 'trade' | 'reports' | 'setup';

export const GROUP_ICONS: Record<GroupIconKey, (props: IconProps) => React.JSX.Element> = {
  daily: DailyIcon,
  inventory: InventoryIcon,
  money: MoneyIcon,
  trade: TradeIcon,
  reports: ReportsIcon,
  setup: SetupIcon,
};

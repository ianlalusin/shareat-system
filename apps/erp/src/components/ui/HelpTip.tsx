'use client';
/**
 * HelpTip — T-448. Ian, 2026-10-22: "long description text can be hidden and put into a small (?)
 * that when hovered over or clicked will display". A toggletip: hover or focus previews it, a click
 * pins it, Esc or a click elsewhere closes it. The text is always in the DOM (hidden), and the button
 * points at it with aria-describedby, so a screen reader hears it without opening anything.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface HelpTipProps {
  readonly children: ReactNode;
  /** What the help is about, for the button's name: "Help: Coverage months". */
  readonly label?: string;
}

export function HelpTip({ children, label }: HelpTipProps) {
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const shown = pinned || hover;

  useEffect(() => {
    if (!pinned) return;
    const away = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [pinned]);

  return (
    <span
      ref={wrap}
      className="erp-help-tip-wrap ml-1"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        // 24px hit area (the census floor), a 16px circle drawn inside it.
        className="erp-help-tip -my-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold leading-none text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        aria-label={label ? `Help: ${label}` : 'Help'}
        aria-expanded={shown}
        aria-describedby={id}
        onClick={(e) => {
          // Inside a <label>, a click would also focus/toggle the control; keep it on the tip.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px]">?</span>
      </button>
      <span id={id} role="tooltip" className="erp-help-tip-pop" hidden={!shown}>
        {children}
      </span>
    </span>
  );
}

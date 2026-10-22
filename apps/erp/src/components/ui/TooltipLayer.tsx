'use client';
/**
 * TooltipLayer — T-448 (Ian: "on hover display button name"). ONE listener for the whole app: any element with
 * `data-tip` shows that text in a small dark bubble on hover or keyboard focus. Drawn `position: fixed` at the
 * document level, so a table's scroll box or a dialog's overflow never clips it (a CSS ::after tip would be).
 * Mounted once in the root layout; buttons stay hook-free server components.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface Tip {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly below: boolean;
  /** An open modal <dialog> sits in the browser's top layer, above any z-index: the tip is drawn inside it. */
  readonly host: Element;
}

function tipFor(el: Element | null): HTMLElement | null {
  return el instanceof Element ? (el.closest('[data-tip]') as HTMLElement | null) : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      current = el;
      const r = el.getBoundingClientRect();
      const below = r.top < 44;
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below, host: el.closest('dialog[open]') ?? document.body });
    };
    const hide = () => {
      current = null;
      setTip(null);
    };
    const over = (e: Event) => {
      const el = tipFor(e.target as Element);
      if (el && el !== current) show(el);
      else if (!el && current) hide();
    };
    const focus = (e: Event) => {
      const el = tipFor(e.target as Element);
      if (el && (el as HTMLElement).matches(':focus-visible')) show(el);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', key);
    };
  }, []);

  if (!tip) return null;
  // aria-hidden: the button already carries the same words as its accessible name.
  return createPortal(
    <div
      aria-hidden="true"
      className="erp-tip pointer-events-none fixed z-[2147483647] whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-xs font-medium text-canvas shadow-lg"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}
    >
      {tip.text}
    </div>,
    tip.host,
  );
}

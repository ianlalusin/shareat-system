'use client';
/**
 * Select all / Clear for one set of ticks (T-653). Client-side ticking only: nothing is saved until the form's own Save, and the server re-checks every
 * value it receives. It finds the boxes by NAME inside the nearest form, so it works for any group of checkboxes that share a name (refills, flavours).
 * The buttons are the kit size (44px tall), named for what they tick: "Select all refills for Unli Pork" / "Clear refills for Unli Pork".
 */
import { useRef } from 'react';

const BTN =
  'inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export interface CheckAllButtonsProps {
  /** The `name` the checkboxes share. */
  readonly name: string;
  /** What the boxes are, with the thing they belong to: "refills for Unli Pork", "flavours for Unli Pork". */
  readonly subject: string;
}

export function CheckAllButtons({ name, subject }: CheckAllButtonsProps) {
  const holder = useRef<HTMLSpanElement>(null);
  const set = (checked: boolean) => {
    const form = holder.current?.closest('form');
    if (!form) return;
    for (const box of form.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`)) {
      if (box.disabled || box.checked === checked) continue;
      box.checked = checked;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  return (
    <span ref={holder} className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={BTN} aria-label={`Select all ${subject}`} onClick={() => set(true)}>
        Select all
      </button>
      <button type="button" className={BTN} aria-label={`Clear ${subject}`} onClick={() => set(false)}>
        Clear
      </button>
    </span>
  );
}

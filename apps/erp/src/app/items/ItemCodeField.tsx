'use client';

/**
 * T-386 R10 - the item code, filled in from the name.
 *
 * The 4-character stem appears at once (the SAME `itemCodeStem` the server uses, imported from the client-safe subpath: one
 * implementation, I5). The number and the list of items that already share the stem come from `suggestAction`, a server action passed
 * in as a prop (the AutoAllocatePaymentForm pattern), debounced 300 ms. The component computes no number itself: the number is fixed
 * by the server when the item is saved, so what is shown is a suggestion, never a promise.
 *
 * - mode "new": a read-only display; a super-admin also gets an optional "Use a different code" input (name="code").
 * - mode "rename": a tick "Use the suggested code for the new name". The section's own code input stays where it is.
 *
 * With JavaScript off only the explanation and "Filled in when saved." show; the form still submits and the server assigns the code.
 * Uncontrolled fields only, so EditableRecord's Cancel (form.reset()) restores them.
 */
import { useEffect, useRef, useState } from 'react';
import { itemCodeStem } from '@shareat/domain/item-code';
import { Banner, Checkbox, Input } from '@/components/ui';

export interface ItemCodeSuggestionView {
  stem: string | null;
  code: string | null;
  full: boolean;
  sameStem: { id: string; code: string; name: string; status: string }[];
}

export interface ItemCodeFieldProps {
  nameInputId: string;
  mode: 'new' | 'rename';
  canOverride: boolean;
  currentCode?: string;
  itemId?: string;
  suggestAction: (name: string, forItemId?: string) => Promise<ItemCodeSuggestionView>;
}

const DEBOUNCE_MS = 300;

const statusNote = (status: string): string => (status === 'active' ? '' : ` (${status === 'inactive' ? 'retired' : status})`);

export function ItemCodeField({ nameInputId, mode, canOverride, currentCode, itemId, suggestAction }: ItemCodeFieldProps) {
  const [name, setName] = useState('');
  const [answer, setAnswer] = useState<ItemCodeSuggestionView | null>(null);
  const [adopt, setAdopt] = useState(false);
  const latest = useRef(0);
  const root = useRef<HTMLDivElement>(null);

  // Follow the Name input (it lives outside this component): read it now, on every keystroke, and again after a form reset.
  useEffect(() => {
    const input = document.getElementById(nameInputId) as HTMLInputElement | null;
    if (!input) return;
    const read = () => setName(input.value);
    read();
    input.addEventListener('input', read);
    const form = input.form;
    const afterReset = () => {
      setAdopt(false);
      setTimeout(read, 0);
    };
    form?.addEventListener('reset', afterReset);
    return () => {
      input.removeEventListener('input', read);
      form?.removeEventListener('reset', afterReset);
    };
  }, [nameInputId]);

  // Ask the server for the number and the same-stem list, 300 ms after the last keystroke; only the newest answer is kept.
  const trimmed = name.trim();
  const stem = trimmed ? itemCodeStem(trimmed) : null;
  useEffect(() => {
    if (!stem) {
      setAnswer(null);
      return;
    }
    const mine = ++latest.current;
    const timer = setTimeout(() => {
      suggestAction(trimmed, itemId).then(
        (a) => {
          if (latest.current !== mine) return;
          setAnswer(a);
        },
        () => {
          if (latest.current !== mine) return;
          setAnswer(null);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [stem, trimmed, itemId, suggestAction]);

  // The tick greys the section's own code input (cosmetic: the server ignores the typed code when the tick is on).
  useEffect(() => {
    if (mode !== 'rename') return;
    const code = root.current?.closest('form')?.elements.namedItem('code');
    if (code instanceof HTMLInputElement) {
      code.readOnly = adopt;
      code.classList.toggle('opacity-50', adopt);
    }
  }, [adopt, mode]);

  const shown = answer && answer.stem === stem ? answer : null;
  const suggested = shown?.code ?? null;
  const display = !stem ? '—' : suggested ?? (shown?.full ? `${stem}-???` : `${stem}-…`);
  const sameStem = shown?.sameStem ?? [];

  return (
    <div ref={root} className="col-span-full space-y-2 text-sm">
      {mode === 'new' && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Code</span>
          <span
            className="inline-flex rounded border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900"
            aria-live="polite"
          >
            {display}
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Filled in from the name. The number is fixed when the item is saved.
          </span>
          <noscript>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">Filled in when saved.</span>
          </noscript>
        </div>
      )}

      {shown?.full && (
        <p className="text-xs text-danger">
          Every number under {shown.stem} has been used (999 items). A super-admin can type a code with different letters.
        </p>
      )}

      {stem && sameStem.length > 0 && (
        <Banner tone="warning">
          Already coded {stem}: {sameStem.map((s) => `${s.code} ${s.name}${statusNote(s.status)}`).join(', ')}. Is this the same thing?
        </Banner>
      )}

      {mode === 'new' && canOverride && (
        <label className="block">
          <span className="block text-xs font-medium text-neutral-500 dark:text-neutral-400">Use a different code (super-admin)</span>
          <Input
            name="code"
            type="text"
            autoComplete="off"
            pattern="[A-Za-z0-9]{4}-[0-9]{3}"
            placeholder={suggested ?? 'CHWN-001'}
            className="mt-1 block w-full font-mono"
          />
        </label>
      )}

      {mode === 'rename' && (
        <Checkbox
          name="adoptSuggestedCode"
          onChange={(e) => setAdopt(e.target.checked)}
          label={
            <span>
              Use the suggested code for the new name{suggested ? `: ${suggested}` : ''}
              {currentCode && suggested && suggested === currentCode ? ' (it keeps its code)' : ''}
            </span>
          }
        />
      )}
    </div>
  );
}

export default ItemCodeField;

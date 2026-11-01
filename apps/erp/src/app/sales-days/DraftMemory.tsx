'use client';
/**
 * T-504 item 10 - the sales-day form remembers unsaved typing. Mounted INSIDE a form: it finds that form, keeps a browser-side
 * draft (localStorage, via `draft-memory.ts`, every call wrapped) keyed by person + store + business date, restores it on the
 * next visit with a line that says so and a Discard, and leaves a marker when the form submits so the day page can clear the
 * draft once a Save worked. Nothing is sent to the server; with no storage the form simply has no memory.
 */
import { useEffect, useRef, useState } from 'react';
import { ACTION_LINK } from '@/components/action-link';
import { clearDraft, draftKey, loadDraft, markSaving, saveDraft, takeSaving } from './draft-memory';

function storageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Every user-typed control by name. Hidden fields (ids), buttons and files are not the person's typing. */
function controls(form: HTMLFormElement): Control[] {
  return [...form.elements].filter((el): el is Control => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
    if (!el.name) return false;
    return !(el instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'file', 'password', 'reset'].includes(el.type));
  });
}

function readFields(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of controls(form)) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      if (el.checked) out[el.name] = 'on';
    } else {
      out[el.name] = el.value;
    }
  }
  return out;
}

function applyFields(form: HTMLFormElement, fields: Record<string, string>, skip?: string): void {
  for (const el of controls(form)) {
    if (el.name === skip) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = el.name in fields;
    else if (el.name in fields) el.value = fields[el.name] ?? '';
  }
  // CheckedForm re-reads every watched control on a reset event, so its live rules judge the restored values.
  form.dispatchEvent(new Event('reset'));
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function DraftMemory({
  personId,
  storeId,
  businessDate,
  dateFieldName,
}: {
  personId: string;
  storeId: string;
  /** The date the page opened on (the typed form's box default, or the day's own date on an edit). */
  businessDate: string;
  /** The date box's name when the person can change it (the new-day page), so each date keeps its own draft. */
  dateFieldName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [restored, setRestored] = useState<string | null>(null);

  const dateIn = (form: HTMLFormElement): string => {
    const el = dateFieldName ? form.elements.namedItem(dateFieldName) : null;
    const v = el instanceof HTMLInputElement ? el.value.trim() : '';
    return DATE_SHAPE.test(v) ? v : businessDate;
  };

  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return undefined;
    const storage = storageOrNull();
    const keyNow = () => draftKey(personId, storeId, dateIn(form));
    let activeKey = keyNow();

    const restore = (key: string): void => {
      const d = loadDraft(storage, key);
      if (!d) return;
      applyFields(form, d.fields, dateFieldName);
      setRestored(d.savedAt);
    };
    restore(activeKey);
    // New-day page only (the date box is editable): this page is never where a successful Save lands, so a marker found here is
    // left over from a create that was refused and bounced back. Drop it, or a later visit to that day would delete the kept draft.
    if (dateFieldName) takeSaving(storage, activeKey);

    const onEdit = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
      if (!t.name || (t instanceof HTMLInputElement && t.type === 'hidden')) return;
      if (dateFieldName && t.name === dateFieldName) {
        // The person moved to another date: that date's own draft (if any) comes back, and the old date's copy is let go.
        const oldKey = activeKey;
        activeKey = keyNow();
        if (oldKey !== activeKey) {
          clearDraft(storage, oldKey);
          setRestored(null);
          restore(activeKey);
        }
      }
      saveDraft(storage, activeKey, readFields(form));
    };
    const onSubmit = () => markSaving(storage, activeKey);

    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    form.addEventListener('submit', onSubmit);
    return () => {
      form.removeEventListener('input', onEdit);
      form.removeEventListener('change', onEdit);
      form.removeEventListener('submit', onSubmit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, storeId, businessDate, dateFieldName]);

  const discard = () => {
    const form = root.current?.closest('form');
    if (form) {
      clearDraft(storageOrNull(), draftKey(personId, storeId, dateIn(form)));
      const dateEl = dateFieldName ? form.elements.namedItem(dateFieldName) : null;
      const keep = dateEl instanceof HTMLInputElement ? dateEl.value : null;
      form.reset(); // back to the saved values; CheckedForm re-reads on reset
      if (dateEl instanceof HTMLInputElement && keep !== null) dateEl.value = keep;
    }
    setRestored(null);
  };

  return (
    <div ref={root} data-draft-key={draftKey(personId, storeId, businessDate)} aria-live="polite">
      {restored ? (
        <p className="flex flex-wrap items-center gap-3 rounded border border-neutral-300 bg-neutral-50 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900">
          <span>Restored what you typed on {timeLabel(restored)} — not saved yet.</span>
          <button type="button" onClick={discard} className={`${ACTION_LINK} font-medium hover:no-underline`}>
            Discard
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** Inside a plain form (the day page's Submit): leaves the "pressed" marker so a success can clear the draft. */
export function DraftMark({ personId, storeId, businessDate }: { personId: string; storeId: string; businessDate: string }) {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = root.current?.closest('form');
    if (!form) return undefined;
    const on = () => markSaving(storageOrNull(), draftKey(personId, storeId, businessDate));
    form.addEventListener('submit', on);
    return () => form.removeEventListener('submit', on);
  }, [personId, storeId, businessDate]);
  return <span ref={root} hidden />;
}

/** On the day page: a Save or Submit that worked lands here with no error, so the draft is cleared. A refusal keeps it. */
export function DraftSettle({ personId, storeId, businessDate, hadError }: { personId: string; storeId: string; businessDate: string; hadError: boolean }) {
  useEffect(() => {
    const storage = storageOrNull();
    const key = draftKey(personId, storeId, businessDate);
    const pressed = takeSaving(storage, key);
    if (pressed && !hadError) clearDraft(storage, key);
  }, [personId, storeId, businessDate, hadError]);
  return null;
}

'use client';
/**
 * T-570 (DEF-821) — every number box in the ERP filters and groups as the person types.
 *
 * Mounted once, in `app/layout.tsx`, and it works on the DOCUMENT rather than on a component per field, because
 * the rule is a property of the whole app and the boxes are spread over ~40 server-rendered pages, `CheckedForm`s,
 * `EditableRecord`s (the edit dialog) and dialogs — including ones added after today. A per-field wrapper would
 * have to be adopted at every call site and would silently miss the next one; this cannot.
 *
 * What "a number box" means here is exactly the two `inputMode` values the ERP already marks (T-343 S5.5):
 *   - `inputMode="decimal"` — money, quantities, rates. Grouped in threes, one decimal point, optional leading minus.
 *   - `inputMode="numeric"` — whole counts, minutes, PINs. Digits only, no grouping (a 6-digit PIN must never
 *     become "123,456").
 * `type="number"` is deliberately untouched: the browser owns that value and rewrites it itself.
 *
 * Three moments:
 *   1. **focus / Edit** — an existing value ("10493.75", or the deployed screen's "1,0493.75") is regrouped before
 *      the first keystroke, and a bubbling `input` event lets a controlled field and the live rules see the same text
 *      the person does. `defaultValue` is left alone (React re-applies it on the next commit) — what keeps
 *      `EditableRecord`'s "changed?" test honest is comparing a number box by its digits.
 *   2. **input** — anything that is not a digit, a '.' or the leading '-' is dropped as it is typed or pasted, and
 *      the grouping is recomputed on every keystroke with the caret kept on the same digit.
 *   3. **submit** — the grouping is stripped again, in the CAPTURE phase, so the FormData React builds for the
 *      server action never carries a comma. This is the belt to `parseDecimalInput`'s braces: the parser accepts a
 *      correct grouping (T-504 item 7), but a number-kind field is parsed by plain `Number()` downstream, and a
 *      stored value must never hold a comma either way.
 *
 * ⚠️ The display is put back after the submit handler has run, so a submission the browser or a live rule stops
 * does not leave the box ungrouped.
 */
import { useEffect } from 'react';
import { caretAfterFormat, formatNumberEntry, type NumberEntryOptions } from '@/lib/number-entry';

/** The text-like types a numeric value can actually be typed into (type=number is the browser's, not ours). */
const isDigit = (c: string) => c >= '0' && c <= '9';

const TEXT_TYPES = new Set(['text', 'search', 'tel']);

function optionsFor(el: HTMLInputElement): NumberEntryOptions | null {
  if (el.disabled || el.readOnly) return null;
  if (!TEXT_TYPES.has(el.type)) return null;
  const mode = (el.getAttribute('inputmode') ?? '').toLowerCase();
  if (mode === 'decimal') return { decimal: true, negative: true, group: true };
  if (mode === 'numeric') return { decimal: false, negative: false, group: false };
  return null;
}

/**
 * Writes the value the way a keystroke does — through the PROTOTYPE setter, not `el.value` — so React's own
 * value tracker stays on the pre-edit figure and its `onChange` still fires for a controlled box (MoneyLines).
 * Writing through `el.value` would update the tracker too, and React would then see "no change" and never learn
 * that the person typed. Same idiom as `DraftMemory`'s `setLikeTyping`.
 */
function writeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** A stored value we are willing to rewrite on focus: digits, separators and a sign, and at least one digit. */
const REWRITABLE = /^-?[0-9.,\s]*$/;

function reformat(el: HTMLInputElement, options: NumberEntryOptions, keepCaret: boolean): void {
  const before = el.value;
  const caret = keepCaret ? (el.selectionStart ?? before.length) : before.length;
  const after = formatNumberEntry(before, options);
  if (after === before) return;
  writeValue(el, after);
  if (document.activeElement === el) {
    const at = keepCaret ? caretAfterFormat(before, caret, after) : after.length;
    try {
      el.setSelectionRange(at, at);
    } catch {
      /* some input types do not expose a selection; the value is what matters */
    }
  }
}

export function NumericEntryBehaviour() {
  useEffect(() => {
    const onFocusIn = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement)) return;
      const options = optionsFor(el);
      if (!options || !REWRITABLE.test(el.value) || !/[0-9]/.test(el.value)) return;
      const formatted = formatNumberEntry(el.value, options);
      if (formatted === el.value) return;
      // ⚠️ defaultValue is deliberately NOT moved: React re-applies it from props on any later commit, so a value kept
      // in step here would silently revert. A comma the app added is not an edit, and that is decided where the
      // comparison lives — EditableRecord's "changed?" test reads a number box by its digits (`plainNumberEntry`).
      writeValue(el, formatted);
      try {
        el.setSelectionRange(formatted.length, formatted.length);
      } catch {
        /* no selection API on this input */
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // Backspace/Delete next to a grouping comma: left alone, the browser deletes the COMMA, the formatter puts it
    // back and the caret steps over it again - the person is stuck (audit N-001). The comma is the app's, not the
    // person's, so the key removes the digit on the far side of it instead.
    const onBeforeInput = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement) || !(event instanceof InputEvent)) return;
      const forward = event.inputType === 'deleteContentForward';
      if (!forward && event.inputType !== 'deleteContentBackward') return;
      if (!optionsFor(el) || el.selectionStart === null || el.selectionStart !== el.selectionEnd) return;
      const caret = el.selectionStart;
      const comma = forward ? caret : caret - 1;
      const digit = forward ? caret + 1 : caret - 2;
      if (el.value.charAt(comma) !== ',' || !isDigit(el.value.charAt(digit))) return;
      event.preventDefault();
      writeValue(el, el.value.slice(0, digit) + el.value.slice(digit + 1));
      const at = forward ? caret : caret - 2;
      el.setSelectionRange(at, at);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onInput = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (event instanceof InputEvent && event.isComposing) return; // an IME is still composing
      const options = optionsFor(el);
      if (!options) return;
      reformat(el, options, true);
    };

    const onSubmit = (event: Event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      for (const el of Array.from(form.elements)) {
        if (!(el instanceof HTMLInputElement)) continue;
        const options = optionsFor(el);
        if (!options) continue;
        const plain = formatNumberEntry(el.value, { ...options, group: false });
        if (plain === el.value) continue;
        writeValue(el, plain);
        // The action reads the form synchronously; put the grouped display back for a submission that is stopped.
        setTimeout(() => {
          if (!el.isConnected) return;
          const shown = formatNumberEntry(el.value, options);
          if (shown !== el.value) writeValue(el, shown);
        }, 0);
      }
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, []);

  return null;
}

/**
 * Number entry — the one rule for a box that holds a number (T-570, DEF-821).
 *
 * Every money/quantity box in the ERP is a TEXT input with `inputMode="decimal"` (T-343 S5.5s–w), so the browser
 * no longer filters what reaches it: a letter, a peso sign or a stray symbol used to be swallowed by
 * `type="number"`, and after that conversion it is typed straight into the value. Separately, the shared parser
 * accepts a correctly grouped "16,980" (T-504 item 7) but nothing ever PUTS the commas there — the person had to
 * type them, and a misplaced one ("1,0493.75", seen on the deployed sales-day screen) was only refused on save.
 *
 * These are the pure rules, shared by the browser behaviour (`components/forms/NumericEntry.tsx`) and its tests:
 *   - `formatNumberEntry` — what the box holds: digits, at most one '.', an optional leading '-', and the whole
 *     part grouped in threes. Everything else is dropped as it is typed.
 *   - `plainNumberEntry` — what the SERVER receives: the same text with the grouping removed (a stored value never
 *     holds a comma, T-504 item 7).
 *   - `caretAfterFormat` — where the cursor goes after a rewrite, so typing in the middle of "1,049" does not
 *     jump to the end of the box.
 *
 * ⚠️ A comma is a GROUPING mark here, never a decimal point. Typing "1,5" leaves "15" on screen (the person sees
 * the digits they typed) rather than 1.5 — the same reading the shared parser already refuses by name — and
 * DEF-472's lesson is that quietly re-reading a separator is how a number becomes 10× wrong.
 *
 * ⚠️ Grouping is emitted only in the shape the parser accepts (`^[+-]?[1-9]\d{0,2}(,\d{3})+(\.\d*)?$`):
 * leading zeros are dropped first, so this module can never produce "0,500" or "01,000" — both of which
 * `parseDecimalInput` refuses and `packages/domain/tests/t504-money-commas.test.ts` proves are refused.
 */

export interface NumberEntryOptions {
  /** Allow one decimal point (money, quantities, rates). `false` = whole digits only (a count, a PIN, minutes). */
  readonly decimal?: boolean;
  /** Allow a leading minus (a correction, a credit). `false` = digits only. */
  readonly negative?: boolean;
  /** Add the thousands separators. `false` = the plain text the server is given. */
  readonly group?: boolean;
}

const DEFAULTS = { decimal: true, negative: true, group: true } as const;

/** Every character that can survive sanitising: digits, the decimal point and (at most) a leading minus. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * The box text: sanitised, leading zeros dropped, whole part grouped.
 *
 * A partial entry is preserved rather than "completed", because the person is mid-keystroke: "-", "-.", "5." and
 * "." are all things a cursor can legitimately sit after, and none of them is a number yet.
 */
export function formatNumberEntry(raw: string, options: NumberEntryOptions = {}): string {
  const { decimal, negative, group } = { ...DEFAULTS, ...options };

  // A pasted peso figure is a number: drop the currency marks and the spaces grouping sometimes uses
  // (a non-breaking space is what Excel and bank statements paste, not a plain one).
  const cleaned = raw.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ').replace(/[\u20b1$€£¥]/g, '').replace(/\bPHP\b/gi, '');

  const sign = negative && cleaned.trimStart().startsWith('-') ? '-' : '';
  const body = cleaned.replace(/[^0-9.]/g, '');
  const firstDot = body.indexOf('.');
  // One decimal point: a second one is a typo, and dropping it is what every money field already does on save.
  const singleDot = firstDot < 0 ? body : body.slice(0, firstDot + 1) + body.slice(firstDot + 1).replace(/\./g, '');
  const plain = decimal ? singleDot : singleDot.replace(/\./g, '');

  const dot = plain.indexOf('.');
  const hasDot = dot >= 0;
  let whole = hasDot ? plain.slice(0, dot) : plain;
  const fraction = hasDot ? plain.slice(dot + 1) : '';

  // "007" is seven, and "00.50" is 0.50 — never "0,007" or "00.50" (the parser refuses leading zeros in a group).
  // ⚠️ ONLY where a decimal point is allowed: an identifier is not a number with a value. A 6-digit PIN "012345" is
  // not 12,345, and dropping the zero makes the person's PIN fail to sign in. In `numeric` mode the digits stay
  // exactly as typed.
  whole = decimal ? whole.replace(/^0+(?=\d)/, '') : whole;
  if (whole === '' && hasDot) whole = '0';
  if (group && whole.length > 3) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${sign}${whole}${hasDot ? `.${fraction}` : ''}`;
}

/**
 * Is pasted text a number we may read at all? (AUDIT T-570, BOSS ruling.) Typing is filtered one key at a time, but a
 * PASTE arrives whole, and "12,5" (a European decimal) or "1e3" would be silently re-read as 125 and 13 - ten times off.
 * A paste is accepted only if it already is a number: digits, a '.', a leading '-' where allowed, and any comma only as a
 * correct group of three. Currency marks and the unicode spaces a paste brings are ignored, as the formatter does.
 * Anything else is REFUSED (the caller keeps the previous value) - never guessed at (DEF-383, DEF-472).
 */
export function isCleanPaste(raw: string, options: NumberEntryOptions = {}): boolean {
  const { decimal, negative } = { ...DEFAULTS, ...options };
  const text = raw
    .replace(/[    ]/g, ' ')
    .replace(/[₱$€£¥]/g, '')
    .replace(/\bPHP\b/gi, '')
    .trim();
  const unsigned = negative && text.startsWith('-') ? text.slice(1) : text;
  const whole = '(?:\\d+|[1-9]\\d{0,2}(?:,\\d{3})+)';
  const shape = decimal ? `(?:${whole}(?:\\.\\d*)?|\\.\\d+)` : whole;
  return new RegExp(`^${shape}$`).test(unsigned);
}

/** The same text with the grouping removed — what is submitted, never with a comma in it. */
export function plainNumberEntry(raw: string, options: NumberEntryOptions = {}): string {
  return formatNumberEntry(raw, { ...options, group: false });
}

/**
 * Where the caret belongs after `before` (with the caret at `caret`) became `after`.
 *
 * The rule is "keep the same number of digits to the left". Separators inserted around the caret are crossed to
 * the RIGHT — otherwise a caret that lands just before an inserted comma would swallow the next keystroke into
 * the wrong group ("1,049" + typing 3 after the 0 must give 10,349, not 13,049).
 */
export function caretAfterFormat(before: string, caret: number, after: string): number {
  const upto = before.slice(0, Math.max(0, Math.min(caret, before.length)));
  const digitsBefore = (upto.match(/[0-9]/g) ?? []).length;
  const minusBefore = upto.includes('-');
  const dotBefore = upto.includes('.');

  let index = 0;
  if (digitsBefore > 0) {
    let seen = 0;
    index = after.length;
    for (let i = 0; i < after.length; i += 1) {
      if (isDigit(after.charAt(i))) {
        seen += 1;
        if (seen === digitsBefore) {
          index = i + 1;
          break;
        }
      }
    }
  }
  if (minusBefore && after.startsWith('-') && index === 0) index = 1;
  if (dotBefore) {
    const dotAt = after.indexOf('.');
    if (dotAt >= 0 && dotAt >= index) index = dotAt + 1;
  }
  while (index < after.length && after.charAt(index) === ',') index += 1;
  return index;
}

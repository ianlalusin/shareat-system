import type { Money } from '@shareat/core/money';
import type { PrintLayout } from './types';

/**
 * T-528a — the paper geometry, and the four primitives every document is built from.
 *
 * Character counts are a PRINTER FILE FORMAT, not a business value: a 58 mm roll in Font B really
 * does fit 42 characters, and a receipt that overflows its paper wraps into unreadable rubbish. They
 * are the one thing in this folder that is allowed to be a constant (work order §7 item 6).
 */

/**
 * Columns per line. Font B (`small`) is denser than Font A, so it fits more characters on the same
 * paper. These are the v1 figures (`apps/pos/.../receiptFormatter.ts`), kept because the printers in
 * the stores are the ones v1 drove.
 */
export function columnsFor(layout: PrintLayout): number {
  if (layout.width === 58) return layout.font === 'small' ? 42 : 32;
  return layout.font === 'small' ? 64 : 48;
}

/** A line-break inside a value the caller already treats as one string. */
function requireColumns(cols: number): void {
  if (!Number.isInteger(cols) || cols < 1) {
    throw new RangeError(`print width must be a positive integer number of columns, got ${cols}`);
  }
}

/** `text` centred in `cols`. Text wider than the paper is centred as far as it can be (0 spaces). */
export function center(text: string, cols: number): string {
  requireColumns(cols);
  const pad = Math.max(0, Math.floor((cols - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/**
 * `left` and `right` on one line, separated by at least one space, right-aligned to `cols`.
 *
 * When they cannot share a line, `left` wraps onto the lines ABOVE and `right` stays on the last
 * one — the amount belongs beside the end of the description, not orphaned on a line of its own.
 */
export function justify(left: string, right: string, cols: number): string[] {
  requireColumns(cols);
  // A `right` that fills or overruns the paper leaves no room for the left side at all. Amounts are
  // short enough that this never happens on a 58 mm roll; if it somehow does, keeping the figure
  // readable matters more than the column bound, so it gets its own final line.
  const room = cols - right.length - 1;
  if (room < 1) return [...wrap(left, cols), right];

  const gap = cols - left.length - right.length;
  if (gap >= 1) return [left + ' '.repeat(gap) + right];

  const parts = wrap(left, room);
  const last = parts.pop() ?? '';
  return [...parts, last + ' '.repeat(Math.max(1, cols - last.length - right.length)) + right];
}

/** Word wrap at `cols`, hard-cutting any single word longer than the paper. Empty text → `[""]`. */
export function wrap(text: string, cols: number): string[] {
  requireColumns(cols);
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > cols) {
      // A name with no spaces ("Supercalifragilistic…") must be cut, not overflow the roll.
      if (current) {
        lines.push(current);
        current = '';
      }
      let rest = word;
      while (rest.length > cols) {
        lines.push(rest.slice(0, cols));
        rest = rest.slice(cols);
      }
      current = rest;
      continue;
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= cols) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** A full-width dashed rule. */
export function rule(cols: number): string {
  requireColumns(cols);
  return '-'.repeat(cols);
}

/**
 * A `Money` as it is printed: thousands commas, no currency symbol (thermal code pages often have no
 * ₱), sign preserved.
 *
 * STRING WORK ONLY. There is no `Number()`, no `parseFloat`, no arithmetic — the figure arrives exact
 * as a decimal string (bible §6) and it is printed exactly as it arrived. Anything that recomputed
 * here could contradict the amount the diner actually paid.
 */
export function printAmount(m: Money): string {
  const value = m.trim();
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [whole = '0', frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const printed = frac === undefined ? grouped : `${grouped}.${frac}`;
  return negative ? `-${printed}` : printed;
}

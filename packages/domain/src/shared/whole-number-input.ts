/**
 * A raw box STRING that must be a whole number in a caller-given range — a shared parse for
 * whole-number form fields whose check runs in the domain, after `authorize()`. Its shape came
 * from the attendance settings action's old `int()` (T-343 S5.5w Amendment A3); since T-352 /
 * DEF-478 that action no longer parses at all, and its fields reach this function through
 * `parseConfigWholeNumber` in `packages/domain/src/attendance/config-input.ts`.
 *
 * T-351 / DEF-481 — loans' `termPeriods` and prepaid's `coverageMonths` were parsed BEFORE
 * `authorize()`, in the action, and by checking the DIGIT RUN rather than the VALUE (a
 * length-capped regex, not a range check). Both move here: parsing happens in the domain, after
 * `authorize()`, and the ceiling is a comparison on the parsed number, never on how many digits
 * were typed — `"000012"` is 12, not refused for its length.
 */
import { refuse } from './refusal';

/**
 * `rawLabel` identifies the field in the raw diagnostic, exactly as every other shared parser's
 * callers already do (never shown to anyone). `humanLabel` is the separate, id-free phrase the
 * userMessage uses. `unit` is an optional suffix on the range phrase (e.g. `' of months'`) —
 * passed through unchanged into both the blank and the out-of-range sentences.
 */
export function parseWholeNumberInput(
  raw: string | number,
  rawLabel: string,
  humanLabel: string,
  min: number,
  max: number,
  unit = '',
): number {
  // Parity with `money-input.ts`'s own reason (S5.5p): a non-string crossing the boundary must
  // still yield a presentable sentence, not a bare `TypeError` from this function itself.
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw refuse(`${rawLabel} is blank`, `${humanLabel} — enter a whole number${unit} from ${min} to ${max}.`);
  }
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || n < min || n > max) {
    throw refuse(
      `${rawLabel} is not a whole number${unit} from ${min} to ${max}: ${JSON.stringify(raw)}`,
      `${humanLabel} — "${trimmed}" is not a whole number${unit} from ${min} to ${max}.`,
    );
  }
  return n;
}

/**
 * T-386 R4/R5/R7 - issuing an item code. Internal to the items domain.
 *
 * The number comes from the stem's high-water mark (`item_code_counters`), read under the counter row's lock, so two simultaneous
 * allocations for one stem serialise for milliseconds and different stems never wait. The write that follows (an insert or an
 * update of `items.code`) fires `items_code_never_reused` in the same transaction, which raises the mark. Nothing is ever derived
 * from `max()` over current codes: codes change, and only the record of what was ISSUED keeps "never reused" true.
 */
import { itemCodesRepo, type Tx } from '@shareat/db';
import { ITEM_CODE_RE, formatItemCode, itemCodeStem, parseItemCode } from './code';
import { refuse } from '../shared/refusal';

const NO_STEM = 'Give the item a name with letters or numbers in it.';
const BAD_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';
const fullSentence = (stem: string) =>
  `Every number under ${stem} has been used (999 items). A super-admin can type a code with different letters.`;

const pad3 = (n: number): string => String(n).padStart(3, '0');

/** The stem of a name, or a plain refusal when the name has no letters or numbers. Checked before anything is written. */
export function requireItemCodeStem(name: string): string {
  const stem = itemCodeStem(name);
  if (stem === null) throw refuse(NO_STEM, NO_STEM);
  return stem;
}

/** Locks the stem's counter row and returns the next free code under it; refuses when all 999 numbers are used. */
export async function allocateItemCode(trx: Tx, orgId: string, stem: string): Promise<string> {
  const last = await itemCodesRepo.lockItemCodeStem(trx, orgId, stem);
  if (last >= 999) {
    const sentence = fullSentence(stem);
    throw refuse(sentence, sentence);
  }
  return formatItemCode(stem, last + 1);
}

/** R7. A super-admin's typed code: trimmed, upper-cased, of the shape, and its number above the stem's mark (read under the lock). */
export async function validateItemCodeOverride(trx: Tx, orgId: string, raw: string): Promise<string> {
  const code = raw.trim().toUpperCase();
  const parsed = ITEM_CODE_RE.test(code) ? parseItemCode(code) : null;
  if (!parsed) throw refuse(BAD_SHAPE, BAD_SHAPE);
  const last = await itemCodesRepo.lockItemCodeStem(trx, orgId, parsed.stem);
  if (parsed.seq > last) return code;
  const sentence =
    last >= 999
      ? fullSentence(parsed.stem)
      : `${code} cannot be used: numbers up to ${parsed.stem}-${pad3(last)} have already been given out under ${parsed.stem}. ` +
        `The next free one is ${parsed.stem}-${pad3(last + 1)}.`;
  throw refuse(sentence, sentence);
}

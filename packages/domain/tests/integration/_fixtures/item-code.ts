/**
 * T-386 - the one place a test makes an item code. `docs/tasks/386-item-code-auto-suggest.md` S3 "Fallout rule".
 *
 * Since T-386 a code passed to `createItem` is a super-admin OVERRIDE and must be of the shape `CHWN-001` (4 letters or digits, a dash,
 * 3 digits, number above the stem's high-water mark). A test that does not care about the code asks for `testItemCode()`: a code whose
 * 4-character stem has not been used by any earlier call in this process, with number 001, so it is above any mark and unique in any
 * org. Free-form codes such as `uid('WS')` or `'PORK-BELLY'` are refused by `createItem` once S3 lands.
 *
 * It is also valid on HEAD (before S3), where `createItem` takes any non-blank string, so a converted test passes both before and after.
 */
const STEMS = 36 ** 4;
// A per-process random start; 7919 is prime, so it is coprime with 36 and `(start + n * 7919) % 36^4` never repeats for n < 36^4.
let start = Math.floor(Math.random() * STEMS);
let n = 0;

/** A fresh, shaped, never-issued-in-this-process code: `K3F9-001`. */
export function testItemCode(): string {
  n += 1;
  const stem = ((start + n * 7919) % STEMS).toString(36).toUpperCase().padStart(4, '0');
  return `${stem}-001`;
}

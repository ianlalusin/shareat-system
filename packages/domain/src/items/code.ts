/**
 * T-386 R1/R2 - the item code `CHWN-001`: a 4-character STEM taken from the name by a fixed rule, a dash, a 3-digit number.
 *
 * Pure and dependency-free on purpose: the item form imports this file in the browser (`@shareat/domain/item-code`) and the
 * server imports the same function, so what the person sees is what is stored (I5). It imports nothing.
 */

/** The shape of a code: 4 upper-case letters/digits, a dash, a number 001-999. Not global or sticky (test() is repeatable). */
export const ITEM_CODE_RE = /^[A-Z0-9]{4}-(?!000)[0-9]{3}$/;

/** Whole tokens dropped from a name before the stem is taken. */
export const STOP_WORDS: readonly string[] = ['A', 'AN', 'AND', 'FOR', 'IN', 'OF', 'THE', 'W', 'WITH'];

const VOWELS = 'AEIOU';

/**
 * R2 step 8. At most `n` characters of `word`, in the word's own order: position 0; then each consonant position (anything
 * that is not A E I O U - Y and digits count as consonants) left to right, skipping a LETTER equal to the character just
 * before it (digits are never skipped); then, if still short, the earliest positions not yet chosen.
 */
export function abbr(word: string, n: number): string {
  if (word.length <= n) return word;
  const chosen = new Set<number>([0]);
  for (let i = 1; i < word.length && chosen.size < n; i++) {
    const ch = word.charAt(i);
    if (VOWELS.includes(ch)) continue;
    if (/[A-Z]/.test(ch) && ch === word.charAt(i - 1)) continue;
    chosen.add(i);
  }
  for (let i = 1; i < word.length && chosen.size < n; i++) chosen.add(i);
  return [...chosen]
    .sort((a, b) => a - b)
    .map((i) => word.charAt(i))
    .join('');
}

function tokensOf(name: string): string[] {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/['’]/g, '')
    .replace(/(?<=[0-9])[.,](?=[0-9])/g, '');
  return folded.match(/[A-Z0-9]+/g) ?? [];
}

/** R2. The 4-character stem of a name, or `null` when the name has no letters or digits (the caller refuses). */
export function itemCodeStem(name: string): string | null {
  const all = tokensOf(name);
  if (all.length === 0) return null;
  const kept = all.filter((t) => !STOP_WORDS.includes(t));
  const tokens = kept.length > 0 ? kept : all;
  const k = tokens.length;
  const quotas = k === 1 ? [4] : k === 2 ? [2, 2] : k === 3 ? [2, 1, 1] : [1, 1, 1, 1];
  let carry = 0;
  let stem = '';
  quotas.forEach((quota, i) => {
    const want = quota + carry;
    const part = abbr(tokens[i] ?? '', want);
    carry = want - part.length;
    stem += part;
  });
  return stem.padEnd(4, 'X').slice(0, 4);
}

/** `formatItemCode('CHWN', 7)` = `CHWN-007`. */
export function formatItemCode(stem: string, seq: number): string {
  return `${stem}-${String(seq).padStart(3, '0')}`;
}

/** `{ stem, seq }` of a code of the shape, else `null` (legacy codes such as `PORK-BELLY`). */
export function parseItemCode(code: string): { stem: string; seq: number } | null {
  if (!ITEM_CODE_RE.test(code)) return null;
  return { stem: code.slice(0, 4), seq: Number(code.slice(5)) };
}

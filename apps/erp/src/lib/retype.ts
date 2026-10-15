/**
 * retypeMatches - the Tier R comparison behind every "type the name to confirm" danger button (T-412).
 * docs/tasks/412-confirm-destructive-tiers.md "How the server verifies a Tier R action".
 *
 * The action loads the record's name from the DATABASE and passes it here as `expected`; `typed` is the form's
 * `confirmName`. A string only (a File, an array, a number or an object that merely prints as the name never matches),
 * compared after NFC, trim, collapsing runs of whitespace to one space and a case fold. Accents are NOT folded and spaces
 * are not removed: "cafe" is not "café", "PorkBelly" is not "Pork Belly". An empty or blank value never matches, not even
 * against an empty name.
 */
function fold(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function retypeMatches(typed: unknown, expected: string): boolean {
  if (typeof typed !== 'string') return false;
  const a = fold(typed);
  const b = fold(expected);
  return a !== '' && b !== '' && a === b;
}

/** The refusal sentence, naming the REAL name (the one the server loaded). */
export function retypeRefusal(name: string): string {
  return `Type the name exactly — '${name}' — to confirm.`;
}

/**
 * T-511 S6a: is a loan leg being docked at all? ONE answer for the preview and the record action (not a `'use server'` file, so both import it).
 * A blank amount, or a zero, is a loan picker left open: no loan leg. Anything else (including a typo) goes to the domain, which judges it in words.
 */
export function hasLoanAmount(raw: string): boolean {
  const text = raw.trim();
  return text !== '' && Number(text) !== 0;
}

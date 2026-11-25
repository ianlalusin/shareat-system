/**
 * T-640 - what a call cost, in MICRO-PESOS (1 peso = 1,000,000), as a whole number. An average call is a few centavos, so centavos are too
 * coarse (ADR-014 4.3); and no float ever touches money. Worked in BigInt and rounded UP, so a cost is never shown as less than it was.
 *
 *   micro-pesos = tokens x (US cents per million tokens) x (pesos per US dollar, in hundredths) / 10,000
 */
export interface ModelPrice {
  readonly centsPerMillionIn: number;
  readonly centsPerMillionOut: number;
}

function whole(n: number, what: string): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pricing: ${what} must be a whole number of 0 or more`);
  return BigInt(n);
}

export function costMicroPesos(tokens: { tokensIn: number; tokensOut: number }, price: ModelPrice, pesosPerUsdHundredths: number): number {
  const usdCentTokens = whole(tokens.tokensIn, 'tokensIn') * whole(price.centsPerMillionIn, 'price in') + whole(tokens.tokensOut, 'tokensOut') * whole(price.centsPerMillionOut, 'price out');
  const micro = (usdCentTokens * whole(pesosPerUsdHundredths, 'peso rate') + 9_999n) / 10_000n;
  return Number(micro);
}

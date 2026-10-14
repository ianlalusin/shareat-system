/**
 * The conversion date every opening figure, inventory draft and movement carries (POSTING-PATTERNS `opening_balance.load`).
 * A leaf module (imports nothing) so `tie-out.ts` and `opening-stock.ts`, which import each other, can both read it at load time.
 * T-394 R7 / DEF-642: `tie-out.ts` re-exports it; `opening-stock.ts` derives its private name from it.
 */
export const CONVERSION_DATE = '2027-01-01';

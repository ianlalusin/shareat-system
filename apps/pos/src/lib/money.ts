/**
 * T-423 S1: this file only re-exports. All money rounding lives in `@/lib/money/centavos` (DEF-003).
 * `roundMoney` / `round2` keep old imports working; new code uses the centavo functions directly.
 */
export { roundMoney } from "@/lib/money/centavos";
export { roundMoney as round2 } from "@/lib/money/centavos";

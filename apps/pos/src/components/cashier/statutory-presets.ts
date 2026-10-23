export const STATUTORY_DISCOUNT_REFUSAL = 'Use the Senior / PWD button so the name and ID are recorded.';
type NamedDiscount = { name?: string | null; vatExempt?: boolean | null };
export function isStatutoryDiscount(discount: NamedDiscount): boolean {
  return Boolean(discount.vatExempt || /senior|\bsc\b|pwd|osca/i.test(discount.name ?? ''));
}
export function selectableBillDiscounts<T extends NamedDiscount>(discounts: T[]): T[] {
  return discounts.filter(discount => !isStatutoryDiscount(discount));
}
export function checkCustomBillDiscount(discount: { name?: string | null }) {
  return isStatutoryDiscount(discount) ? { ok: false as const, message: STATUTORY_DISCOUNT_REFUSAL } : { ok: true as const };
}
export function assertBillDiscountAllowed(discount: NamedDiscount | null): void {
  if (discount && isStatutoryDiscount(discount)) throw new Error(STATUTORY_DISCOUNT_REFUSAL);
}

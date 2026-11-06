/** T-524 - the POS v2 domain: seating, ordering, kitchen, refills, per-line discounts, voiding and paying with a server recompute. docs/tasks/524-pos-v2-domain.md. */
export { priceSession } from './price';
export type { PriceDiscountInput, PriceLineInput, PriceSnapshot, PricedDiscount, PricedLine, PricedSession } from './price';
export type { PosDeps, PosRules } from './shared';
export { openStand, addLines, confirmHeads, setHeadsCashier, requestRefill, serveLine, cancelLine } from './order';
export type { LineInput, OpenStandInput } from './order';
export { addLineDiscount, removeLineDiscount, applyPresetToAllLines } from './discounts';
export type { AddLineDiscountInput } from './discounts';
export { voidUnpaidSession, completeSale, currentBusinessDate, getSessionBill, listOpenStands, listKitchenQueue, listRefillQueue, listTodaysSalesReceipts } from './sale';
export type { CompleteSaleInput, VoidInput } from './sale';

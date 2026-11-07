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
export {
  applyPosEvents,
  parsePosEvents,
  listPosQuarantine,
  replayQuarantinedEvent,
  discardQuarantinedEvent,
  refusalCode,
  POS_NOT_SWITCHED_ON,
  RETRYABLE_POS_CODES,
  isRetryableRefusal,
  MAX_EVENTS_PER_BATCH,
} from './inbox';
export type { PosEventIn, PosEventResult, PosPairing } from './inbox';
export { buildPosSnapshot, loadPosSnapshot, readPosState, NO_TILL_NUMBER } from './snapshot';
// `listTerminals` is already the clock terminals' (attendance) in this barrel, so only the list is aliased.
export { listTerminals as listPosTerminals, createTerminal, linkTerminal, setTerminalPrinter } from './terminals';
export type { TerminalList, TillView } from './terminals';
export type { PosSnapshot, PosStateAnswer } from './snapshot';

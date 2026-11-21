/** T-524 - the POS v2 domain: seating, ordering, kitchen, refills, per-line discounts, voiding and paying with a server recompute. docs/tasks/524-pos-v2-domain.md. */
export { priceSession } from './price';
export type { PriceDiscountInput, PriceLineInput, PriceSnapshot, PricedDiscount, PricedLine, PricedSession } from './price';
export type { PosDeps, PosRules } from './shared';
export { openStand, addLines, confirmHeads, setHeadsCashier, requestRefill, serveLine, cancelLine } from './order';
export type { LineInput, OpenStandInput } from './order';
export { addLineDiscount, removeLineDiscount, applyPresetToAllLines } from './discounts';
export type { AddLineDiscountInput } from './discounts';
export { voidUnpaidSession, completeSale, currentBusinessDate, getSessionBill, listOpenStands, listRefillableTables, listKitchenQueue, listRefillQueue, listTodaysSalesReceipts, findSalesReceiptByNo } from './sale';
export type { CompleteSaleInput, VoidInput } from './sale';
export { grantLineApproval } from './line-approval';
export type { LineApprovalGrant } from './line-approval';
export { checkSeniorIdRepeat } from './senior-repeat';
export type { SeniorIdCheck } from './senior-repeat';
export {
  applyPosEvents,
  applyPosBatch,
  parsePosEvents,
  parsePosBatchPairingId,
  POS_PAIRING_MISMATCH,
  POS_PAIRING_MISMATCH_CODE,
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
export { receiptIdentityOf } from './receipt-identity';
export type { ReceiptIdentity } from './receipt-identity';
export { buildPosSnapshot, loadPosSnapshot, readPosState, NO_TILL_NUMBER } from './snapshot';
// `listTerminals` is already the clock terminals' (attendance) in this barrel, so only the list is aliased.
export { listTerminals as listPosTerminals, createTerminal, linkTerminal, setTerminalPrinter } from './terminals';
export type { TerminalList, TillView } from './terminals';
export type { PosSnapshot, PosStateAnswer } from './snapshot';
export {
  readingFor,
  xReading,
  closeDay,
  closeBacklog,
  deriveSalesDayFromZ,
  sendV1Bridge,
  resendV1Bridge,
  listDayCloses,
  NO_SALES_TO_CLOSE,
  CLOSE_RACE,
  MORE_THAN_TWO_DAYS,
  DIFFERENT_MANAGER,
} from './day-close';
export type { Reading, TenderLine, CloseDayInput, CloseDayResult, CloseBacklogInput, BacklogClose, DayCloseListItem, V1BridgeWriter, V1BridgeStatus, V1HistoryStatus, CloseApproval } from './day-close';
export { recordConversion, voidConversion, listOpenConversions } from './convert';
export type { ConvertBlock, OpenConversion, RecordConversionInput, VoidConversionInput } from './convert';
export { recordTenderCorrection, CORRECTION_CLOSED } from './tender-correction';
export type { RecordTenderCorrectionInput } from './tender-correction';
export { checkWalletPayment, listWalletPaymentsToCheck, PAYMENT_CHECK_DAYS } from './payment-check';
export type { WalletPaymentToCheck } from './payment-check';
export { recordRefund } from './refund';
export type { RecordRefundInput, RecordRefundResult, RefundBlock, RefundSlipData } from './refund';
export { buildV1BridgePayload, V1_BRIDGE_LAST_DATE, v1BridgeDateAllowed } from './v1-bridge-payload';
export type { V1BridgeClose, V1BridgeTender, V1BridgePayload } from './v1-bridge-payload';
export { exportPosData, POS_EXPORT_MAX_DAYS } from './data-export';
export type { PosDataExport } from './data-export';
export { upsertPosStand, upsertPosDiscountPreset, checkPreset } from './store-setup';
export type { StandOutcome, PresetOutcome, PresetInput, CheckedPreset } from './store-setup';

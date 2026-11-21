/**
 * T-539 S1 - the POS's one reader of its business rules. docs/tasks/539-pos-business-rule-keys.md R4.
 *
 * SERVER-ONLY (reads through `loadRuleBook`); like rules.ts it is NOT exported from `./index.ts`, the DB-free leaf.
 * The shape is exactly T-524's `PosRules` (pos/shared.ts on lane/t524-tests); not imported from `pos/`, which is not on main yet.
 */
import type { Tx } from '@shareat/db';
import { loadRuleBook, ruleValue } from './rules';

export interface PosRules {
  readonly vatPercentBasisPoints: bigint;
  readonly scPwdPercentBasisPoints: bigint;
  readonly businessDayStartHour: number;
  /** T-539 S3: minutes a table may sit before its tile turns red. */
  readonly tableWarnMinutes: number;
  /** T-558: the largest short payment (centavos) a sale may carry as a routine variance; a bigger gap is a finding. The tablet only displays it. */
  readonly saleVarianceToleranceCentavos: bigint;
  /** T-576: when true, a line cancel / line discount / discount removal needs a manager PIN (or manager approval). The tablet reads it from the snapshot to ask for the PIN. */
  readonly requirePinLineActions: boolean;
}

/**
 * The six POS values in force on `onDate`, from one query. `onDate` is the Manila calendar date (YYYY-MM-DD) of the event time:
 * the rule in force that day, so an old receipt keeps its old rate. No row -> the registry default (12%, 20%, 4, 90).
 */
export async function readPosRules(tx: Tx, orgId: string, onDate: string): Promise<PosRules> {
  const book = await loadRuleBook(tx, orgId, ['tax.vat_percent', 'pos.senior_pwd_discount_percent', 'pos.business_day_start_hour', 'pos.table_warn_minutes', 'pos.sale_variance_tolerance', 'pos.require_pin_line_actions']);
  return {
    vatPercentBasisPoints: book.valueOn('tax.vat_percent', onDate).basisPoints(),
    scPwdPercentBasisPoints: book.valueOn('pos.senior_pwd_discount_percent', onDate).basisPoints(),
    businessDayStartHour: book.valueOn('pos.business_day_start_hour', onDate).hour(),
    tableWarnMinutes: book.valueOn('pos.table_warn_minutes', onDate).minutes(),
    saleVarianceToleranceCentavos: book.valueOn('pos.sale_variance_tolerance', onDate).centavos(),
    requirePinLineActions: book.valueOn('pos.require_pin_line_actions', onDate).flag(),
  };
}

/**
 * T-575: how many business days back a senior/PWD card number counts as "used before" (`pos.senior_id_repeat_days`: whole days, 1 = the same business day). Its own reader,
 * not a `PosRules` field: only the server uses it (the tablet never enforces it), so it stays out of the snapshot and out of the injectable `readRules`.
 */
export async function readReceiptLookupDays(tx: Tx, orgId: string, onDate: string): Promise<number> {
  return (await ruleValue(tx, orgId, 'pos.receipt_lookup_days', onDate)).days();
}

/** T-621: what the tablet uses while offline. Display and timing only; the server never enforces either. */
export interface PosOfflineRules {
  /** `pos.offline_unsent_warn_amount` in centavos: unsent sales at or above it show the warning band. */
  readonly offlineUnsentWarnCentavos: bigint;
  /** `pos.offline_xslip_hours`: whole hours offline between automatic offline X-slips. */
  readonly offlineXSlipHours: number;
}

/**
 * T-621 reader. Its own function, not `PosRules` fields: like `readReceiptLookupDays` it is read only by the snapshot, so the injectable `readRules` and every
 * test that pins the `PosRules` shape stay as they are.
 */
export async function readPosOfflineRules(tx: Tx, orgId: string, onDate: string): Promise<PosOfflineRules> {
  const book = await loadRuleBook(tx, orgId, ['pos.offline_unsent_warn_amount', 'pos.offline_xslip_hours']);
  return {
    offlineUnsentWarnCentavos: book.valueOn('pos.offline_unsent_warn_amount', onDate).centavos(),
    offlineXSlipHours: book.valueOn('pos.offline_xslip_hours', onDate).hours(),
  };
}

/** T-575 reader, see above. */
export async function readSeniorIdRepeatDays(tx: Tx, orgId: string, onDate: string): Promise<number> {
  return (await ruleValue(tx, orgId, 'pos.senior_id_repeat_days', onDate)).days();
}

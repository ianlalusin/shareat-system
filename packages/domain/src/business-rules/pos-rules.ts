/**
 * T-539 S1 - the POS's one reader of its business rules. docs/tasks/539-pos-business-rule-keys.md R4.
 *
 * SERVER-ONLY (reads through `loadRuleBook`); like rules.ts it is NOT exported from `./index.ts`, the DB-free leaf.
 * The shape is exactly T-524's `PosRules` (pos/shared.ts on lane/t524-tests); not imported from `pos/`, which is not on main yet.
 */
import type { Tx } from '@shareat/db';
import { loadRuleBook } from './rules';

export interface PosRules {
  readonly vatPercentBasisPoints: bigint;
  readonly scPwdPercentBasisPoints: bigint;
  readonly businessDayStartHour: number;
  /** T-539 S3: minutes a table may sit before its tile turns red. */
  readonly tableWarnMinutes: number;
}

/**
 * The four POS numbers in force on `onDate`, from one query. `onDate` is the Manila calendar date (YYYY-MM-DD) of the event time:
 * the rule in force that day, so an old receipt keeps its old rate. No row -> the registry default (12%, 20%, 4, 90).
 */
export async function readPosRules(tx: Tx, orgId: string, onDate: string): Promise<PosRules> {
  const book = await loadRuleBook(tx, orgId, ['tax.vat_percent', 'pos.senior_pwd_discount_percent', 'pos.business_day_start_hour', 'pos.table_warn_minutes']);
  return {
    vatPercentBasisPoints: book.valueOn('tax.vat_percent', onDate).basisPoints(),
    scPwdPercentBasisPoints: book.valueOn('pos.senior_pwd_discount_percent', onDate).basisPoints(),
    businessDayStartHour: book.valueOn('pos.business_day_start_hour', onDate).hour(),
    tableWarnMinutes: book.valueOn('pos.table_warn_minutes', onDate).minutes(),
  };
}

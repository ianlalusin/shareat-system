/**
 * T-504 - how ONE typed channel box is read, shared by `writeChannels` (create / edit) and the platform-sales writer, so the
 * rule has one copy on the server (the sentences are in `business-rules/sales-day.ts`, which the form's live check reads too).
 *
 *   blank, unticked   -> `blank: true`  (a draft may carry it: no row; the SUBMIT completeness check is what refuses it)
 *   blank, ticked     -> a confirmed zero
 *   0, unticked       -> refused: type the sales, or tick No sales
 *   amount, ticked    -> refused: choose one (DEF-628 - was silently dropped / zeroed)
 *   amount above zero -> that amount
 *   0, ticked         -> a confirmed zero
 */
import { isZero, ZERO, type Money } from '@shareat/core/money';
import { channelBothSentence, channelMissingSentence } from '../business-rules/sales-day';
import { parseMoneyInput } from '../shared/money-input';
import { refuse } from '../shared/refusal';

export function interpretChannelEntry(
  name: string,
  rawAmount: string | undefined,
  noSales: boolean,
  fn: string,
): { amount: Money; noSales: boolean; blank: boolean } {
  const raw = (rawAmount ?? '').trim();
  if (raw === '') return { amount: ZERO, noSales, blank: !noSales };
  const amount = parseMoneyInput(raw, `${fn}: "${name}"'s amount`, `The amount for "${name}"`);
  if (noSales && !isZero(amount)) {
    throw refuse(`${fn}: "${name}" is marked "no sales" but carries ${amount}`, channelBothSentence(name));
  }
  if (!noSales && isZero(amount)) {
    throw refuse(`${fn}: "${name}" is zero with "no sales" not ticked`, channelMissingSentence(name));
  }
  return { amount, noSales, blank: false };
}

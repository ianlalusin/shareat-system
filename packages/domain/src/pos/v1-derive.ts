/**
 * T-375 S3 (R4) - the derivation: ONE POS v1 `sales` payload to a sales day's figures. `docs/tasks/
 * 375-pos-v1-day-feed.md` S3.
 *
 * PURE: no I/O, no clock. It is called by `importSalesDay` after the fetch and before any write, so a refusal here
 * leaves nothing behind (I5). The one float -> centavo conversion happens at the wire (`toCentavos`, the rule of
 * R4: `c = round(x * 100)`, accepted only if `|x * 100 - c| <= 0.001`); after it, only `@shareat/core/money`.
 *
 * Names: P = paid total, D = discounts, C = charges, K = the package-only figure, M = the sum of the method totals,
 * N = the receipt count, X = M - P (the difference).
 *   - X < 0 refuses (the methods are short of the total);
 *   - X <= 1 centavo per receipt is ROUNDING: refunds 0, X is added to other charges (cash kept, 4500);
 *   - a larger X is REFUNDS (4950), taken out of the cash drawer (Ian, Q3 (a), 2026-10-05).
 * The POS residual field is never read (R12): a la carte is the day's total less the package figure.
 */
import { add, compare, fromCentavos, isZero, subtract, toCentavos as moneyToCentavos, ZERO, type Money } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { POS_V1_SALES_FIELDS as S } from '@shareat/db';
import { humanDate } from '../shared/refusal-leaf';
import { resolvePosV1Methods, toCentavos, type ResolverTender } from './v1-methods';

export const POS_V1_VAT_EXCLUSIVE_SENTENCE =
  'This store adds VAT on top of its prices in POS. Importing it needs a ruling on where that VAT goes. Ask the office.';

export interface DeriveSalesDayContext {
  /** The link's channel: the one remitted-daily channel POS's till money lands in. */
  readonly channelId: string;
  readonly taxType: 'vat_inclusive' | 'vat_exclusive' | 'non_vat';
  /** The store's tenders (all of them; the resolver keeps the active ones). */
  readonly tenders: readonly ResolverTender[];
  /** A Manila business date, `YYYY-MM-DD`: so a refusal can name the day. */
  readonly businessDate: string;
  /** For the not-found sentence. */
  readonly storeName?: string;
}

export interface DerivedFigures {
  readonly totalSales: Money;
  readonly unliSales: Money;
  readonly alaCarteSales: Money;
  readonly seniorDiscount: Money;
  readonly pwdDiscount: Money;
  readonly otherDiscount: Money;
  readonly comps: Money;
  readonly serviceCharge: Money;
  readonly otherCharges: Money;
  readonly cashCollected: Money;
  readonly onlineCollected: Money;
  readonly creditSales: Money;
  readonly refunds: Money;
}

export type DeriveSalesDayResult =
  | {
      readonly ok: true;
      readonly figures: DerivedFigures;
      /** The link's channel and the whole day's total (the remitted row). */
      readonly channel: { readonly channelId: string; readonly amount: Money };
      /** One row per money account (wallet tenders, summed). */
      readonly tenders: readonly { readonly moneyAccountId: string; readonly amount: Money }[];
      /** W1: how far POS's package figure exceeded the day's sales (0.00 when it did not). Not booked. */
      readonly capExcess: Money;
    }
  | { readonly ok: false; readonly sentence: string; readonly raw: string };

function pesos(value: Money): string {
  const negative = value.startsWith('-');
  const [whole = '0', frac = '00'] = (negative ? value.slice(1) : value).split('.');
  return `${negative ? '-' : ''}₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

function refused(raw: string, sentence: string): DeriveSalesDayResult {
  return { ok: false, sentence, raw };
}

function dayLabel(businessDate: string): string {
  try {
    return humanDate(parseBusinessDate(businessDate));
  } catch {
    return businessDate;
  }
}

/** One wire number to centavos, or a refusal naming the field. */
function figure(
  source: Record<string, unknown>,
  key: string,
  label: string,
  when: string,
): { ok: true; centavos: bigint } | { ok: false; result: DeriveSalesDayResult } {
  const x = source[key];
  if (typeof x !== 'number') {
    return {
      ok: false,
      result: refused(
        `deriveSalesDay: field "${key}" is missing or not a number`,
        `POS didn't send ${label} for ${when}, so the day can't be imported.`,
      ),
    };
  }
  const c = toCentavos(x);
  if (c === null) {
    return {
      ok: false,
      result: refused(
        `deriveSalesDay: field "${key}" is ${String(x)}, not a whole number of centavos`,
        `POS sent ${label} for ${when} as an amount that isn't a whole number of centavos, so the day can't be imported.`,
      ),
    };
  }
  if (c < 0n) {
    return {
      ok: false,
      result: refused(
        `deriveSalesDay: field "${key}" is negative (${c} centavos)`,
        `POS sent a negative figure for ${label} on ${when}, so the day can't be imported.`,
      ),
    };
  }
  return { ok: true, centavos: c };
}

export function deriveSalesDay(payload: unknown, ctx: DeriveSalesDayContext): DeriveSalesDayResult {
  // The VAT ruling comes first: nothing else is worth deriving for a store whose VAT has nowhere to go.
  if (ctx.taxType === 'vat_exclusive') {
    return refused('deriveSalesDay: the store link is vat_exclusive (Q4: no store is; the guard stays)', POS_V1_VAT_EXCLUSIVE_SENTENCE);
  }
  const when = dayLabel(ctx.businessDate);

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return refused('deriveSalesDay: the sales payload is not an object', `POS sent an answer for ${when} that can't be read, so the day can't be imported.`);
  }
  const body = payload as Record<string, unknown>;
  if (body[S.found] !== true) {
    return refused(
      'deriveSalesDay: found is not true',
      `POS has no sales for ${ctx.storeName ?? 'this store'} on ${when}. The day waits until POS has them.`,
    );
  }

  const paid = figure(body, S.paidTotal, "the day's paid total", when);
  if (!paid.ok) return paid.result;
  const discounts = figure(body, S.discounts, 'the discounts', when);
  if (!discounts.ok) return discounts.result;
  const charges = figure(body, S.charges, 'the charges', when);
  if (!charges.ok) return charges.result;
  const packageOnly = figure(body, S.packageOnly, 'the package figure', when);
  if (!packageOnly.ok) return packageOnly.result;
  const receipts = body[S.receiptCount];
  if (typeof receipts !== 'number' || !Number.isInteger(receipts) || receipts < 0) {
    return refused(
      `deriveSalesDay: field "${S.receiptCount}" is not a whole, non-negative count`,
      `POS didn't send a usable receipt count for ${when}, so the day can't be imported.`,
    );
  }

  const rawMethods = body[S.methods];
  if (typeof rawMethods !== 'object' || rawMethods === null || Array.isArray(rawMethods)) {
    return refused(
      `deriveSalesDay: field "${S.methods}" is not an object`,
      `POS didn't say how ${when} was paid, so the day can't be imported.`,
    );
  }
  const resolved = resolvePosV1Methods(rawMethods as Record<string, number>, ctx.tenders);
  if (!resolved.ok) return refused(resolved.raw, resolved.sentence);

  const P = fromCentavos(paid.centavos);
  const D = fromCentavos(discounts.centavos);
  const C = fromCentavos(charges.centavos);
  const K = fromCentavos(packageOnly.centavos);
  const wallets = [...resolved.wallets.entries()].map(([moneyAccountId, amount]) => ({ moneyAccountId, amount }));
  const online = add(ZERO, ...wallets.map((w) => w.amount));
  const cashMethods = resolved.cash;
  const M = add(cashMethods, online);

  const X = subtract(M, P);
  if (compare(X, ZERO) < 0) {
    return refused(
      `deriveSalesDay: methods ${M} are less than the paid total ${P}`,
      `POS's payments for ${when} (${pesos(M)}) are less than its sales (${pesos(P)}), so the day can't be imported. This has to be fixed on the POS.`,
    );
  }

  // R4 (W11): up to one centavo a receipt is rounding; more is a refund.
  const isRounding = isZero(X) || moneyToCentavos(X) <= BigInt(receipts);
  const refunds = isRounding ? ZERO : X;
  const rounding = isRounding ? X : ZERO;

  if (compare(refunds, cashMethods) > 0) {
    return refused(
      `deriveSalesDay: refunds ${refunds} exceed the cash methods ${cashMethods}`,
      `POS shows ${pesos(refunds)} refunded on ${when} but only ${pesos(cashMethods)} cash taken, so the day can't be imported. Tell the office; this needs a ruling.`,
    );
  }
  const cash = subtract(cashMethods, refunds);

  const total = subtract(add(P, D, refunds), C);
  if (compare(total, ZERO) < 0) {
    return refused(
      `deriveSalesDay: total ${total} is negative (P ${P} + D ${D} + refunds ${refunds} - C ${C})`,
      `POS's charges for ${when} are more than its sales, so the day can't be imported. Tell the office; this needs a ruling.`,
    );
  }

  // W1: a package figure above the day's sales is capped, never refused.
  const unli = compare(K, total) > 0 ? total : K;
  const alaCarte = subtract(total, unli);
  const capExcess = subtract(K, unli);

  return {
    ok: true,
    figures: {
      totalSales: total,
      unliSales: unli,
      alaCarteSales: alaCarte,
      seniorDiscount: ZERO,
      pwdDiscount: ZERO,
      otherDiscount: D,
      comps: ZERO,
      serviceCharge: ZERO,
      otherCharges: add(C, rounding),
      cashCollected: cash,
      onlineCollected: online,
      creditSales: ZERO,
      refunds,
    },
    channel: { channelId: ctx.channelId, amount: total },
    tenders: wallets,
    capExcess,
  };
}

/**
 * W1, for the day page: how far POS's package figure in a stored `sales` payload exceeded `unliSales` (what the
 * derivation booked), or 0.00. Computed from the feed on read - there is no column for it. A payload that cannot be
 * read gives 0.00 (the note is a courtesy; the import already refused any such payload).
 */
export function packageCapExcess(payload: unknown, unliSales: Money): Money {
  if (typeof payload !== 'object' || payload === null) return ZERO;
  const k = toCentavos((payload as Record<string, unknown>)[S.packageOnly] as number);
  if (k === null || k < 0n) return ZERO;
  const excess = subtract(fromCentavos(k), unliSales);
  return compare(excess, ZERO) > 0 ? excess : ZERO;
}

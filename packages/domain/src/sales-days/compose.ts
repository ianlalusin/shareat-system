/**
 * routeInputForDay - the ONE place a stored sales day becomes the input of `routeSalesDay`. Verify calls it; the
 * correction's "new" figures (T-375 S6, R10) will too, so the two can never compose a day differently.
 * `docs/tasks/375-pos-v1-day-feed.md` R8, R4 (refunds).
 *
 * ## The platform seam (R8) - the two lines to delete when Ian rings platforms through POS
 *
 * On a FEED day (`source = 'pos_v1_day_feed'`) the day's own figures are exactly what POS said; platform sales
 * (Foodpanda and the like) are typed separately as non-remitted channel rows (`setPlatformSales`). They are added to
 * `totalSales` and `alaCarteSales` HERE, at routing time, never written into the day (platform orders are take-out,
 * always a la carte, 4150; the receivable is the channel's own, e.g. 1220). A legacy typed day already carries them
 * in its own figures, so it routes exactly as before: the composition is for feed days only.
 */
import { add, isZero, money, type Money } from '@shareat/core/money';
import type { salesDaysRepo } from '@shareat/db';
import type { RouteSalesDayInput } from './routing';

type DayRow = salesDaysRepo.SalesDayRow;
type ChannelRow = salesDaysRepo.SalesDayChannelRow;
type TenderRow = salesDaysRepo.SalesDayTenderRow;

/** The sum of a day's non-remitted channel rows that carry an amount (what a feed day adds at routing time). */
export function platformSalesTotal(channels: Pick<ChannelRow, 'isRemittedDaily' | 'amount' | 'noSales'>[]): Money {
  const rows = channels.filter((c) => !c.isRemittedDaily && !c.noSales).map((c) => money(c.amount));
  return rows.length === 0 ? money('0') : add(...rows);
}

export function routeInputForDay(day: DayRow, channels: ChannelRow[], tenders: TenderRow[]): RouteSalesDayInput {
  let totalSales = money(day.totalSales);
  let alaCarteSales = money(day.alaCarteSales);
  // T-531: and a day derived from the POS receipts, which also owns only what POS rang (the same composition, so verify and the correction never differ).
  if (day.source !== 'legacy_typed') {
    const platform = platformSalesTotal(channels);
    if (!isZero(platform)) {
      totalSales = add(totalSales, platform);
      alaCarteSales = add(alaCarteSales, platform);
    }
  }
  return {
    totalSales,
    unliSales: money(day.unliSales),
    alaCarteSales,
    seniorDiscount: money(day.seniorDiscount),
    pwdDiscount: money(day.pwdDiscount),
    otherDiscount: money(day.otherDiscount),
    comps: money(day.comps),
    serviceCharge: money(day.serviceCharge),
    otherCharges: money(day.otherCharges),
    cashCollected: money(day.cashCollected),
    onlineCollected: money(day.onlineCollected),
    creditSales: money(day.creditSales),
    // T-375 (W11): a feed day's refunds post to 4950 beside its cash net of them; a typed day has none.
    refunds: money(day.refunds),
    allowShortPayment: day.source === 'pos_receipts',
    tenders: tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: money(t.amount) })),
    channels: [
      // T-531: a day from the POS receipts has no remitted channel ROW (the POS has no channels), but the router's channel check ("the channels sum to the total") applies as soon
      // as a platform row exists. This one in-memory row stands for the till's own sales, exactly as a feed day's remitted row does; it is never stored and posts no line.
      ...(day.source === 'pos_receipts'
        ? [{ channelId: 'pos_receipts', channelName: 'POS receipts', isRemittedDaily: true, receivableAccountCode: null, amount: money(day.totalSales), noSales: false }]
        : []),
      ...channels.map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName,
        isRemittedDaily: c.isRemittedDaily,
        receivableAccountCode: c.receivableAccountCode,
        amount: money(c.amount),
        noSales: c.noSales,
      })),
    ],
  };
}

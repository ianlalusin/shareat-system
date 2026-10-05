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
  if (day.source === 'pos_v1_day_feed') {
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
    tenders: tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: money(t.amount) })),
    channels: channels.map((c) => ({
      channelId: c.channelId,
      channelName: c.channelName,
      isRemittedDaily: c.isRemittedDaily,
      receivableAccountCode: c.receivableAccountCode,
      amount: money(c.amount),
      noSales: c.noSales,
    })),
  };
}

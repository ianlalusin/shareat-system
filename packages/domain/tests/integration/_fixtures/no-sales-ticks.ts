import { sql as dsql } from 'drizzle-orm';
import type { Tx } from '@shareat/db';

/**
 * T-504 - a day is only SUBMITTED once every channel it types has an amount or "No sales" ticked. A fixture that only cares
 * about the day's FIGURES (not its channels) ticks "No sales" on every channel it left blank, exactly as a person would, and
 * leaves any row that already carries an amount alone. A typed day: every active channel. A POS-fed day: only the non-remitted
 * ones (the Platform sales section); POS's own rows are never touched. Rows the fixture wrote as 0 with no tick are ticked.
 */
export async function tickMissingChannels(tx: Tx, salesDayId: string): Promise<void> {
  await tx.execute(dsql`
    insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales)
    select d.id, c.id, 0, true
      from sales_days d
      join sales_channels c on c.store_id = d.store_id and c.is_active
     where d.id = ${salesDayId}
       and (d.source <> 'pos_v1_day_feed' or not c.is_remitted_daily)
       and not exists (select 1 from sales_day_channels r where r.sales_day_id = d.id and r.channel_id = c.id)`);
  // A typed day whose channels carry nothing yet: its sales were all taken at the till, so the first remitted channel (by name)
  // carries the day's total - verify refuses a channel breakdown that does not add up to the total once any channel row exists.
  await tx.execute(dsql`
    with d as (select id, store_id, total_sales from sales_days where id = ${salesDayId} and source <> 'pos_v1_day_feed'),
    first_remitted as (
      select c.id from d join sales_channels c on c.store_id = d.store_id and c.is_active and c.is_remitted_daily order by c.name limit 1)
    update sales_day_channels r set amount = d.total_sales, no_sales = false
      from d, first_remitted f
     where r.sales_day_id = d.id and r.channel_id = f.id and r.amount = 0 and d.total_sales > 0
       and not exists (select 1 from sales_day_channels x where x.sales_day_id = d.id and x.amount > 0)`);
  await tx.execute(dsql`
    update sales_day_channels r set no_sales = true
      from sales_days d, sales_channels c
     where r.sales_day_id = d.id and c.id = r.channel_id and d.id = ${salesDayId}
       and r.amount = 0 and not r.no_sales
       and (d.source <> 'pos_v1_day_feed' or not c.is_remitted_daily)`);
}

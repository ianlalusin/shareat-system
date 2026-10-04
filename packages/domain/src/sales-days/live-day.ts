/**
 * T-373 S1 (DEF-552, R1-R3): the one door a writer walks through before it records something AGAINST a
 * sales day (a POS usage pull, an order wastage). It takes the day row `FOR SHARE` and refuses a day
 * that is missing, belongs to another store, or has been voided.
 *
 * `FOR SHARE` conflicts with the `FOR UPDATE` that void/edit/verify take, so a writer and a void
 * serialize (the one that waited re-reads the committed status under READ COMMITTED); two writers do
 * not block each other. Call it AFTER `authorize()` and BEFORE the first write; never hold it across
 * a network fetch (R2).
 */
import { salesDaysRepo, type Tx } from '@shareat/db';
import { gone, humanDate, refuse } from '../shared/refusal';
import type { BusinessDate } from '@shareat/core/datetime';

export async function lockLiveSalesDay(
  tx: Tx,
  orgId: string,
  input: { salesDayId: string; storeId: string; doing: 'usage' | 'wastage' },
) {
  const day = await salesDaysRepo.getByIdForShare(tx, orgId, input.salesDayId);
  if (!day) throw gone(`lockLiveSalesDay: sales day ${input.salesDayId} does not exist in org ${orgId}`, 'sales day');
  if (day.storeId !== input.storeId) {
    throw refuse(
      `lockLiveSalesDay: sales day ${day.id} belongs to store ${day.storeId}, not ${input.storeId}`,
      'That sales day belongs to another store.',
    );
  }
  if (day.status === 'voided') {
    throw refuse(
      `lockLiveSalesDay: sales day ${day.id} is voided`,
      `The sales day for ${humanDate(day.businessDate as BusinessDate)} has been voided, so ${input.doing} can't be recorded against it.`,
    );
  }
  return day;
}

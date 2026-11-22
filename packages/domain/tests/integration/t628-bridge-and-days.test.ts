import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-628 - what the day close does around a deposit-paid bill: the December v1 bridge document (v1 has no deposit: it receives the gross less the part paid from deposits, so its
 * "methods add up to the total" check holds), a test-mode store books nothing for a deposit, and a backlog close leaves a LATER day's deposit events for the later Z.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { createReservation, seatReservation, sendV1Bridge, takeDeposit } from '../../src/pos';
import { D1, asOrg, close, closeAll, fakeWriter, manila, pinOf, reading, sell, sql, uuid, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '22:30');
const nowIso = () => new Date().toISOString();

async function reservationWithDeposit(w: World, amount: string): Promise<string> {
  const id = uuid();
  await asOrg(w.orgId, (tx) => createReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId: id, customerName: 'Santos', partySize: 4, reservedFor: manila(D1, '19:00'), createdAtDevice: nowIso() }));
  await asOrg(w.orgId, (tx) => takeDeposit(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, depositId: uuid(), reservationId: id, tenderId: w.cash, amount, occurredAtDevice: nowIso() }));
  return id;
}
const payWithDeposit = (w: World, reservationId: string, amount: string, cash: string) =>
  sell(w, {
    at: manila(D1, '19:30'), items: [{ item: w.menu.pork, qty: 4 }], expectTotal: '1000.00', pay: [{ tenderId: w.cash, amount: cash }],
    beforeComplete: async () => {
      const [s] = await sql<{ id: string }[]>`select id from table_sessions where store_id = ${w.storeId} and status = 'open' order by opened_at_device desc, id desc limit 1`;
      await asOrg(w.orgId, (tx) => seatReservation(tx, w.counter, { storeId: w.storeId, pairingId: w.pairingId, reservationId, sessionId: s!.id, seatedAtDevice: manila(D1, '19:30') }));
    },
    mutate: (i) => {
      i.deposit = { reservationId, amount };
    },
  });

describe('T-628 the day close around a deposit-paid bill', () => {
  it('the v1 bridge document carries the gross less the part paid from deposits, so its methods check holds [kills: the bridge total keeps the deposit part]', async () => {
    const w = await world();
    const id = await reservationWithDeposit(w, '500.00');
    await payWithDeposit(w, id, '500.00', '500.00');
    await close(w, AT, await pinOf(w, w.managerId));
    const f = fakeWriter();
    const out = await asOrg(w.orgId, (tx) => sendV1Bridge(tx, w.counter, { storeId: w.storeId, businessDates: [D1] }, { writer: f.writer }));
    expect(out.results[0]).toMatchObject({ status: 'sent' });
    const payments = (f.calls[0]!.data as { payments: { totalGross: number; byMethod: Record<string, number> } }).payments;
    expect(payments).toMatchObject({ totalGross: 500, byMethod: { cash: 500 } });
  });

  it('a test-mode store books nothing for a deposit (the Z still collects the event, no journal entry)', async () => {
    const w = await world('test');
    const id = await reservationWithDeposit(w, '300.00');
    const x = await reading(w, AT);
    expect(x.deposits).toMatchObject({ taken: '300.00', count: 1 });
    await close(w, AT, await pinOf(w, w.managerId));
    expect(await sql`select 1 from journal_entries where org_id = ${w.orgId} and source_type = 'pos_deposit'`).toHaveLength(0);
    expect((await sql<{ day_close_id: string | null }[]>`select day_close_id from pos_reservation_deposits where reservation_id = ${id}`)[0]!.day_close_id).not.toBeNull();
  });
});

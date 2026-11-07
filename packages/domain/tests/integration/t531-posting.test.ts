/**
 * T-531 R4 "Posting" and R10 (TESTER) - the derived sales day is verified by a DIFFERENT, senior person through the EXISTING `verifySalesDay`, and posts a balanced
 * `sale.mixed` entry (docs/POSTING-PATTERNS.md "Sale", the two balance identities). docs/tasks/531-pos-day-close.md R4, R8 "Posting", R10 (Ian, row 449).
 *
 * R10, for a day with `source = 'pos_receipts'` ONLY: the verifier needs (1) verify_sales_day at the store, (2) role manager / admin / super_admin (the same ladder
 * `roles.ts` ranks: staff < manager < admin < super_admin; there is NO separate "area manager" role in the code, hand-back Q4), (3) not to be the person who closed the Z
 * (pos_day_closes.closed_by), (4) verify_own_sales_day does not exempt them. The refusal sentence: "A sales day from the POS is verified by a store manager or above
 * who did not close the day." Asserted for the closer in BOTH forms (the closer is also the submitter, so the generic "You submitted this day" sentence could fire first:
 * the spec says the R10 sentence is the one, hand-back Q5). A manager of another store fails clause 1 (an AuthorizationError, not the R10 sentence).
 * A v1-fed day keeps today's rule (hand-granted staff may verify it; the submitter may not verify their own).
 *
 * RED NOW FOR THE RIGHT REASON: closeDay does not exist, so the day cannot be made ("MISSING EXPORT ... (T-531 not built)"); the v1-fed controls run for real.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { editSalesDay, submitSalesDay, verifySalesDay } from '@shareat/domain';
import {
  D1, FAR, asOrg, close, closeAll, journalLines, manila, pinOf, salesDaysOf, sql, standardDay, uid, world, type World,
} from './_fixtures/t531-day-close';
import { insertDerivedSalesDayRow } from './_fixtures/pos-day';
import { submitThenVerify } from './_fixtures/sales-day-flow';
import { tickMissingChannels } from './_fixtures/no-sales-ticks';

afterAll(closeAll);

const R10 = 'A sales day from the POS is verified by a store manager or above who did not close the day.';
const AT = manila(D1, '22:30');

/** The standard day closed by `closer` (default the cashier), approved by `approver`'s PIN; returns the submitted pos_receipts day's id. */
async function closedDay(w: World, o: { closer?: World['counter']; approver?: string } = {}): Promise<string> {
  await standardDay(w);
  await close(w, AT, await pinOf(w, o.approver ?? w.managerId), { who: o.closer ?? w.counter });
  const [d] = await salesDaysOf(w);
  expect(d, 'the derived day exists (closeDay built)').toBeDefined();
  expect(d).toMatchObject({ status: 'submitted', source: 'pos_receipts' });
  return d!.id;
}
const verifyAs = (w: World, who: World['counter'], dayId: string) => asOrg(w.orgId, (tx) => verifySalesDay(tx, who, dayId));
async function expectR10(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected the verification to be refused').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toBe(R10);
}
const grant = (w: World, personId: string, name: string) =>
  sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${personId}, ${name}, ${w.adminId}, 'grant', ${name === 'verify_own_sales_day' ? null : w.storeId})`;
const dayState = async (id: string) => (await sql<{ status: string; journal_entry_id: string | null; verified_by: string | null }[]>`select status, journal_entry_id, verified_by from sales_days where id = ${id}`)[0]!;

// ======================================================================================================================
describe('R4 posting - a store manager who did not close the day verifies it, and a balanced sale.mixed entry is posted', () => {
  it('the entry matches POSTING-PATTERNS: DR cash 2,396.71, DR e-wallet 500.00, DR discounts 178.29 / CR unli 2,245.00, CR a la carte 830.00; both balance identities hold on the day', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const res = await verifyAs(w, w.manager, dayId);
    expect(res.created).toBe(true);
    expect(await dayState(dayId)).toMatchObject({ status: 'verified', verified_by: w.managerId, journal_entry_id: res.journalEntryId });

    const lines = await journalLines(res.journalEntryId);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1110', '2396.71', '0.00'],
      ['1140', '500.00', '0.00'],
      ['4100', '0.00', '2245.00'],
      ['4150', '0.00', '830.00'],
      ['4900', '178.29', '0.00'],
    ]);
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(lines.reduce((a, l) => a + cents(l.debit), 0)).toBe(307500);
    expect(lines.reduce((a, l) => a + cents(l.credit), 0)).toBe(307500);

    const [d] = await salesDaysOf(w);
    // identity 1 (tender side): cash + online + discounts + comps = total sales; identity 2 (revenue side): unli + a la carte = total sales
    expect(cents(d!.cash_collected) + cents(d!.online_collected) + cents(d!.senior_discount) + cents(d!.pwd_discount) + cents(d!.other_discount) + cents(d!.comps)).toBe(cents(d!.total_sales));
    expect(cents(d!.unli_sales) + cents(d!.ala_carte_sales)).toBe(cents(d!.total_sales));
  });

  it('verify works although the store has an ACTIVE remitted channel (Walk-in) with no sales_day_channels row: a POS-derived day owes no typed channel rows', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from sales_channels where store_id = ${w.storeId} and is_active and is_remitted_daily`;
    expect(row!.n, 'fixture sanity: the store has an active remitted channel').toBeGreaterThan(0);
    await expect(verifyAs(w, w.manager, dayId)).resolves.toMatchObject({ created: true });
  });

  it('re-verifying is a no-op (created:false, the same entry); an admin who did not close the day may verify too', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const first = await verifyAs(w, w.admin, dayId);
    const again = await verifyAs(w, w.manager, dayId);
    expect(again).toEqual({ journalEntryId: first.journalEntryId, created: false });
    expect((await sql<{ n: number }[]>`select count(*)::int n from journal_entries where source_id = ${dayId}`)[0]!.n).toBe(1);
  });
});

// ======================================================================================================================
describe('R10 - every clause has its refusal; a refused verification leaves the day submitted and posts nothing', () => {
  it('clause 3: the person who closed the Z (a store manager) is refused, with the R10 sentence', async () => {
    const w = await world();
    const dayId = await closedDay(w, { closer: w.manager, approver: w.adminId });
    await expectR10(verifyAs(w, w.manager, dayId));
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null, verified_by: null });
    await expect(verifyAs(w, w.admin, dayId), 'control: another senior person (the admin who approved) may').resolves.toMatchObject({ created: true });
  });

  it('clause 4: an admin who closed the Z and holds verify_own_sales_day is STILL refused (the exemption does not apply to a POS day)', async () => {
    const w = await world();
    await grant(w, w.adminId, 'verify_own_sales_day');
    const dayId = await closedDay(w, { closer: w.admin, approver: w.managerId });
    await expectR10(verifyAs(w, w.admin, dayId));
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null });
    await expect(verifyAs(w, w.manager, dayId), 'control: the manager who did not close it may').resolves.toMatchObject({ created: true });
  });

  it('clause 2: a cashier (staff) HAND-GRANTED verify_sales_day at the store is refused, with the R10 sentence', async () => {
    const w = await world();
    await grant(w, w.kitchenId, 'verify_sales_day');
    const dayId = await closedDay(w);
    await expectR10(verifyAs(w, w.kitchen, dayId));
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null });
    await expect(verifyAs(w, w.manager, dayId), 'control: a store manager may').resolves.toMatchObject({ created: true });
  });

  it('clause 1: a manager of ANOTHER store is refused (authorization, not the R10 sentence)', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    await expect(verifyAs(w, w.managerOther, dayId)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null });
  });

  // R10 clause 3, "or any Z of that date if there are several": not written. Two Zs on one business date cannot exist on the live schema
  // (UNIQUE store+date+terminal, and R4 refuses a second sales day), hand-back Q1.
  it.todo('with several Zs of the date, any of their closers is refused (blocked on hand-back Q1)');
});

// ======================================================================================================================
describe('R10 - a v1-FED day follows today\'s rule, untouched (runs now)', () => {
  /** A feed day on a live store whose live_from is AFTER the feed date (the new row-436 guard refuses one at or after it). */
  async function feedDay(w: World) {
    const { id } = await insertDerivedSalesDayRow(sql, {
      orgId: w.orgId, storeId: w.storeId, businessDate: D1, createdBy: w.adminId, posStoreId: uid('pos'),
      figures: { total_sales: '1100.00', unli_sales: '600.00', ala_carte_sales: '500.00', other_discount: '100.00', other_charges: '0.00', cash_collected: '1000.00', online_collected: '0.00' },
    });
    return id;
  }

  it('hand-granted staff may verify a v1-fed day (not a store manager, not the submitter), and the entry posts', async () => {
    const w = await world('live', FAR);
    await grant(w, w.kitchenId, 'verify_sales_day');
    const dayId = await feedDay(w);
    const res = await asOrg(w.orgId, (tx) => submitThenVerify(tx, w.kitchen, dayId, w.manager));
    expect(res.created).toBe(true);
  });

  it('the submitter of a v1-fed day is refused with TODAY\'s sentence, not the POS one', async () => {
    const w = await world('live', FAR);
    const dayId = await feedDay(w);
    await asOrg(w.orgId, async (tx) => {
      await tickMissingChannels(tx, dayId);
      await submitSalesDay(tx, w.manager, dayId);
    });
    const err = await verifyAs(w, w.manager, dayId).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toBe('You submitted this day, so someone else has to verify it.');
  });
});

// ======================================================================================================================
// Added by the BUILDER (ruling 2 treats a pos_receipts day like a feed day for channel completeness; this proves the rule can be MET): the platform rows (a non-remitted
// channel such as Foodpanda) are typed beside the POS day exactly as on a feed day, and the entry then carries the receivable and the extra a la carte revenue.
describe('ruling 2 - an active platform channel is required on a POS-derived day, and typing it lets the day post', () => {
  it('verify refuses naming the channel; after the verifier types its sales (editSalesDay platform rows) the entry adds DR 1220 500.00 and CR 4150 up by 500.00', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${w.orgId}, ${w.storeId}, 'Foodpanda', false, '1220') returning id`;
    const err = await verifyAs(w, w.manager, dayId).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toContain('Foodpanda');
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null });

    await asOrg(w.orgId, (tx) => editSalesDay(tx, w.manager, { salesDayId: dayId, platform: [{ channelId: ch!.id, amount: '500.00', noSales: false }] }));
    const res = await verifyAs(w, w.manager, dayId);
    expect(res.created).toBe(true);
    const lines = await journalLines(res.journalEntryId);
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1110', '2396.71', '0.00'],
      ['1140', '500.00', '0.00'],
      ['1220', '500.00', '0.00'],
      ['4100', '0.00', '2245.00'],
      ['4150', '0.00', '1330.00'],
      ['4900', '178.29', '0.00'],
    ]);
  });
});

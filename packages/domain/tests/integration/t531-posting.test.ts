import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
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
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RefusalError } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { editSalesDay, reimportSalesDay, submitSalesDay, verifySalesDay, voidSalesDay } from '@shareat/domain';
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

// ======================================================================================================================
// BOSS condition on the platform rows: they can never double-count. Platform sales enter a POS-derived day ONLY as typed rows on a non-remitted platform channel; the
// POS has no platform tender (tenders.kind is cash | wallet, proven in the migration test), the till's own channel and every remitted channel refuse a typed row, and no
// POS figure (row 270) can be typed on the day.
describe('no double count - POS receipts + typed platform rows', () => {
  const foodpanda = async (w: World) =>
    (await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${w.orgId}, ${w.storeId}, 'Foodpanda', false, '1220') returning id`)[0]!.id;
  const typePlatform = (w: World, dayId: string, channelId: string, amount = '500.00') =>
    asOrg(w.orgId, (tx) => editSalesDay(tx, w.manager, { salesDayId: dayId, platform: [{ channelId, amount, noSales: false }] }));
  const sentence = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err, 'expected a refusal').toBeInstanceOf(RefusalError);
    return (err as RefusalError).userMessage;
  };
  const cents = (s: string) => Math.round(Number(s) * 100);

  it('receipts (cash + GCash) + a typed Foodpanda row: revenue = receipt subtotal + platform, tender debits only from the receipts, 1220 only from the platform; both balance checks pass', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    await typePlatform(w, dayId, await foodpanda(w));
    const res = await verifyAs(w, w.manager, dayId);

    // the day's OWN figures are the receipts', untouched by the platform row
    const [d] = await salesDaysOf(w);
    expect(d).toMatchObject({ total_sales: '3075.00', unli_sales: '2245.00', ala_carte_sales: '830.00', cash_collected: '2396.71', online_collected: '500.00' });
    const [rec] = await sql<{ subtotal: string; net: string }[]>`
      select sum(r.subtotal)::text subtotal,
             (select sum(p.amount - p.change_given) from pos_sales_receipt_payments p join pos_sales_receipts r2 on r2.id = p.receipt_id where r2.org_id = ${w.orgId})::text net
        from pos_sales_receipts r where r.org_id = ${w.orgId}`;
    expect(d!.total_sales).toBe(Number(rec!.subtotal).toFixed(2));

    const lines = await journalLines(res.journalEntryId);
    const by = (code: string, side: 'debit' | 'credit') => lines.filter((l) => l.code === code).reduce((a, l) => a + cents(l[side]), 0);
    // tender / debit side: the receipts' money (cash + e-wallet = collected net of change) and the platform receivable; nothing else but the discount
    expect(by('1110', 'debit') + by('1140', 'debit')).toBe(cents(rec!.net));
    expect(by('1220', 'debit')).toBe(50000);
    expect(lines.filter((l) => Number(l.debit) > 0).map((l) => l.code).sort()).toEqual(['1110', '1140', '1220', '4900']);
    // revenue side: receipt subtotal (unli + a la carte) + the platform amount, once
    expect(by('4100', 'credit')).toBe(cents(d!.unli_sales));
    expect(by('4150', 'credit')).toBe(cents(d!.ala_carte_sales) + 50000);
    const debit = lines.reduce((a, l) => a + cents(l.debit), 0);
    const credit = lines.reduce((a, l) => a + cents(l.credit), 0);
    expect([debit, credit]).toEqual([357500, 357500]);
    // identity 1 (tender side, platform included) and identity 2 (revenue side)
    expect(cents(d!.cash_collected) + cents(d!.online_collected) + 50000 + cents(d!.senior_discount) + cents(d!.pwd_discount) + cents(d!.other_discount) + cents(d!.comps)).toBe(cents(d!.total_sales) + 50000);
    expect(cents(d!.unli_sales) + cents(d!.ala_carte_sales) + 50000).toBe(cents(d!.total_sales) + 50000);
    // the only stored tender row is the receipts' GCash; the platform money is a channel row, never a tender
    expect((await sql<{ n: number }[]>`select count(*)::int n from sales_day_tenders where sales_day_id = ${dayId}`)[0]!.n).toBe(1);
  });

  it("a typed row on the till's own channel (remitted Walk-in), on ANOTHER remitted channel, and on the POS channel even if it were made non-remitted is refused with a sentence; nothing is stored", async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const [link] = await sql<{ sales_channel_id: string }[]>`select sales_channel_id from pos_v1_store_links where store_id = ${w.storeId}`;
    expect(await sentence(typePlatform(w, dayId, link!.sales_channel_id))).toBe('Walk-in is paid at the till, so its sales come from POS, not from here.');
    const [other] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${w.orgId}, ${w.storeId}, 'Dine-in 2', true) returning id`;
    expect(await sentence(typePlatform(w, dayId, other!.id))).toBe('Dine-in 2 is paid at the till, so its sales come from POS, not from here.');
    await sql`update sales_channels set is_remitted_daily = false, receivable_account_code = '1220' where id = ${link!.sales_channel_id}`;
    expect(await sentence(typePlatform(w, dayId, link!.sales_channel_id))).toBe("Walk-in is the till's own channel, so its sales come from POS, not from here.");
    expect((await sql<{ n: number }[]>`select count(*)::int n from sales_day_channels where sales_day_id = ${dayId}`)[0]!.n).toBe(0);
  });

  it('row 270: no POS figure can be typed on the day: editSalesDay refuses, and the derivation-flag trigger refuses every figure write and every tender row outside the derivation', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    expect(await sentence(asOrg(w.orgId, (tx) => editSalesDay(tx, w.manager, { salesDayId: dayId, totalSales: '1.00' } as never)))).toBe(
      "This day's figures come from the POS close and can't be typed. Only platform sales can be entered here.",
    );
    const lockedBy = async (p: PromiseLike<unknown>) => {
      const err = (await Promise.resolve(p).then(() => null, (e: unknown) => e)) as { code?: string; constraint_name?: string } | null;
      expect(err, 'the write was ACCEPTED').not.toBeNull();
      return { code: err!.code, constraint: err!.constraint_name };
    };
    const FIG = { code: '23514', constraint: 'sales_days_figures_locked' };
    const TEN = { code: '23514', constraint: 'sales_day_tenders_locked' };
    expect(await lockedBy(sql`update sales_days set total_sales = total_sales + 1, ala_carte_sales = ala_carte_sales + 1 where id = ${dayId}`)).toEqual(FIG);
    expect(await lockedBy(sql`update sales_days set unli_sales = unli_sales - 10, ala_carte_sales = ala_carte_sales + 10 where id = ${dayId}`)).toEqual(FIG);
    for (const col of ['senior_discount', 'pwd_discount', 'other_discount', 'comps', 'service_charge', 'other_charges', 'cash_collected', 'online_collected', 'credit_sales']) {
      expect(await lockedBy(sql`update sales_days set ${sql(col)} = ${sql(col)} + 1 where id = ${dayId}`), col).toEqual(FIG);
    }
    const [t] = await sql<{ money_account_id: string }[]>`select money_account_id from sales_day_tenders where sales_day_id = ${dayId}`;
    expect(await lockedBy(sql`insert into sales_day_tenders (sales_day_id, money_account_id, amount) values (${dayId}, ${t!.money_account_id}, 1.00)`)).toEqual(TEN);
    expect(await lockedBy(sql`update sales_day_tenders set amount = amount + 1 where sales_day_id = ${dayId}`)).toEqual(TEN);
    expect(await lockedBy(sql`delete from sales_day_tenders where sales_day_id = ${dayId}`)).toEqual(TEN);
    expect(await salesDaysOf(w)).toMatchObject([{ total_sales: '3075.00', cash_collected: '2396.71', online_collected: '500.00' }]);
  });
});

// ======================================================================================================================
// Added by the BUILDER (audit fixes 1 and 2): a POS-derived day is never voided (its receipts stay frozen to the Z, so the date could never be derived again) and a manual
// import never touches a date the POS close holds.
describe('a POS-derived day cannot be voided or re-imported', () => {
  const NOT_VOIDABLE = "A sales day from the POS can't be voided. Correct it with a refund or a platform correction.";
  const refusalOf = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err, 'expected a refusal').toBeInstanceOf(RefusalError);
    return (err as RefusalError).userMessage;
  };

  it('voidSalesDay refuses with the sentence for a submitted day and for a verified day (the entry stands), and the day is unchanged', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    expect(await refusalOf(asOrg(w.orgId, (tx) => voidSalesDay(tx, w.admin, dayId, 'wrong day')))).toBe(NOT_VOIDABLE);
    expect(await dayState(dayId)).toMatchObject({ status: 'submitted', journal_entry_id: null });
    const res = await verifyAs(w, w.manager, dayId);
    expect(await refusalOf(asOrg(w.orgId, (tx) => voidSalesDay(tx, w.admin, dayId, 'wrong day')))).toBe(NOT_VOIDABLE);
    expect(await dayState(dayId)).toMatchObject({ status: 'verified', journal_entry_id: res.journalEntryId });
    // the receipts are still frozen to the Z: nothing was freed
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_sales_receipts where org_id = ${w.orgId} and day_close_id is null`)[0]!.n).toBe(0);
  });

  it('a manual re-import of the date is refused with a sentence (not the raw database error), for a submitted day and for a verified one', async () => {
    const w = await world();
    const dayId = await closedDay(w);
    const reimport = () => asOrg(w.orgId, (tx) => reimportSalesDay(tx, w.manager, { salesDayId: dayId }));
    const date = (await salesDaysOf(w))[0]!.business_date;
    const wantsDate = (s: string) => {
      expect(s).toContain('was closed on the new POS, so it can\'t be imported from v1.');
      expect(s).not.toMatch(/23514|figures_locked/);
    };
    wantsDate(await refusalOf(reimport()));
    await verifyAs(w, w.manager, dayId);
    wantsDate(await refusalOf(reimport()));
    expect(date).toBe(D1);
  });
});

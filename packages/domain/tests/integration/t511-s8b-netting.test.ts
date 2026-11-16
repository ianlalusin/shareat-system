import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * T-511 S8b (5) - the carrier day of a Foodpanda weekly nets the earlier invoices' charges its own file prints on Appendix C, chosen on the server from file facts alone.
 * docs/tasks/511-settlement-upload-s8-spec.md "S8b" item 5. Real Postgres, real ingest, real posting, `approveDay` as the app calls it.
 *
 * The world is the real weekly in miniature: two sales days (2 and 3 Nov), one order each of 1,000.00 (commission 200.00, withholding 5.00, tax on charges 24.00, balance 771.00),
 * and three small invoices (+89.29, -89.29, +89.29, each with 12% VAT: totals 100.00, -100.00, 100.00) booked first. The weekly's Appendix C prints the three documents as
 * (-100, +100, -100). The carrier day (3 Nov) therefore deposits 771.00 - 100.00 = 671.00 and clears the 100.00 the three charges left on 1220.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { closeDb } from '@shareat/db';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { fpPriorRow } from '../unit/t511-s3-helpers';
import {
  MALVAR_FP, TEST_DOCS, TEST_INVOICES, approve, auditRows, blockersOf, chargeLinks, entryCount, ingest, lineOn, netDebit, postCharge, postedDay, s7World, sentenceOf, setDestination, settlementFull, settlementsOf,
  smallInvoice, weekly, zipFile, lineOfDoc, type S7World,
} from './_fixtures/t511-s8b-world';

const sql = postgres(url, { max: 6 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const D1 = '2026-11-02';
const D2 = '2026-11-03';
const PRIOR = [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow(TEST_DOCS.rebill, -100)];
const PANDAGO = 'PandaGO Order-10.31.2026-zz99-test01';

interface Setup {
  w: S7World;
  d1: string;
  d2: string;
}

/** The small invoices ingested (and `book` of them booked) and the weekly with `prior` ingested, its two days verified in the books. */
async function setup(hint: string, o: { prior?: Parameters<typeof weekly>[0]['prior']; book?: ('original' | 'reversal' | 'rebill')[]; real?: boolean; cod?: boolean; tag?: string } = {}): Promise<Setup> {
  const w = await s7World(sql, `s8b-${hint}`, { loanPeriods: false });
  await setDestination(sql, w, w.fpA);
  const small = [
    { which: 'original' as const, net: 89.29, description: o.real === false ? undefined : PANDAGO },
    { which: 'reversal' as const, net: -89.29, description: 'Incorrect Invoice Amount Reversal: 299999000001' },
    { which: 'rebill' as const, net: 89.29, description: o.real === false ? undefined : PANDAGO },
  ];
  // the REAL descriptions are the default now (S8b item 9: a "Delivery Service Fees" row books, "PandaGO Order-..." or not); `cod` makes the re-bill a PandaGO cash-on-delivery row instead
  for (const s of small) {
    const category = o.cod && s.which === 'rebill' ? 'Pandago COD' : undefined;
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: TEST_INVOICES[s.which], doc: TEST_DOCS[s.which], net: s.net, ...(s.description ? { description: s.description } : {}), ...(category ? { category } : {}) })));
  }
  for (const which of o.book ?? ['original', 'reversal', 'rebill']) expect((await postCharge(w, w.admin, await lineOfDoc(sql, w.orgId, TEST_DOCS[which]))).posted).toBe(true);
  for (const d of [D1, D2]) await postedDay(w, w.fpA, d, '1000.00');
  await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: o.tag ?? hint, orders: [{ date: D1, revenue: 100000n }, { date: D2, revenue: 100000n }], prior: o.prior ?? PRIOR }).zip));
  return { w, d1: (await lineOn(sql, w.orgId, w.fpA, D1)).id, d2: (await lineOn(sql, w.orgId, w.fpA, D2)).id };
}

/** The blockers of a day apart from "decide the earlier day first" (a later day always has that one until the earlier day is booked; it is not what these tests are about). */
const blockersWithoutOrder = async (w: S7World, lineId: string) => (await blockersOf(w, w.managerA2, lineId)).blockers.filter((b) => b.code !== 'earlier_day_open');
const codes = async (s: Setup, lineId: string): Promise<string[]> => (await blockersWithoutOrder(s.w, lineId)).map((b) => b.code);

/** Nothing was written by a refused approval. */
async function snapshot(orgId: string) {
  return { entries: await entryCount(sql, orgId), settlements: (await settlementsOf(sql, orgId)).length, links: (await chargeLinks(sql, orgId)).length };
}

describe('S8b (5) the carrier day nets the earlier invoices its upload prints', () => {
  it('3 Nov deposits 771.00 - 100.00 = 671.00, links all three charges, and 1220 ends at 0.00; 2 Nov (not the carrier) nets nothing [kills: the earlier charges never netted (a 100.00 variance booked instead); every day netting them; a charge left on 1220]', async () => {
    const s = await setup('net');
    const { w } = s;
    expect(await codes(s, s.d1)).toEqual([]);
    expect(await codes(s, s.d2)).toEqual([]);

    const r1 = await approve(w, w.managerA2, s.d1);
    expect(r1.chargeIds).toEqual([]);
    expect((await settlementFull(sql, r1.settlementId)).net_deposited).toBe('771.00');

    const r2 = await approve(w, w.managerA2, s.d2);
    expect(r2.chargeIds).toHaveLength(3);
    const set2 = await settlementFull(sql, r2.settlementId);
    expect([set2.net_deposited, set2.variance, set2.settlement_gain, set2.difference_reason]).toEqual(['671.00', '0.00', '0.00', null]);
    const links = await chargeLinks(sql, w.orgId);
    expect(links.map((l) => l.settlement_id)).toEqual([r2.settlementId, r2.settlementId, r2.settlementId]);
    expect(links.map((l) => l.charge_id).sort()).toEqual([...r2.chargeIds].sort());
    expect(await netDebit(sql, w.orgId, '1220'), 'the 100.00 the three small charges left on 1220 is cleared').toBe('0.00');
    expect(await netDebit(sql, w.orgId, '6400'), '229.00 a day in fees + the 100.00 of net small charges, each expensed once').toBe('558.00');
    expect(await netDebit(sql, w.orgId, '6420'), 'no variance expense').toBe('0.00');
    expect(await netDebit(sql, w.orgId, '7100'), 'no gain').toBe('0.00');
    const audit = (await auditRows(sql, w.orgId, 'settlement_day.approved')).find((a) => a.entity_id === s.d2)!;
    expect((audit.after as { chargeIds: string[] }).chargeIds).toHaveLength(3);
  });

  it('a second statement that prints the same three items nets nothing again: no new link, no -100.00, no blocker (they are informational) [kills: a double net; a mismatch caused by an item that was settled before]', async () => {
    const s = await setup('twice');
    const { w } = s;
    await approve(w, w.managerA2, s.d1);
    await approve(w, w.managerA2, s.d2);
    expect(await chargeLinks(sql, w.orgId)).toHaveLength(3);
    for (const d of ['2026-11-09', '2026-11-10']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000011', tag: 'twice-2', orders: [{ date: '2026-11-09', revenue: 100000n }, { date: '2026-11-10', revenue: 100000n }], prior: PRIOR }).zip));
    const n1 = await lineOn(sql, w.orgId, w.fpA, '2026-11-09');
    const n2 = await lineOn(sql, w.orgId, w.fpA, '2026-11-10');
    expect(await codes(s, n2.id)).toEqual([]);
    await approve(w, w.managerA2, n1.id);
    const r = await approve(w, w.managerA2, n2.id);
    expect(r.chargeIds).toEqual([]);
    expect((await settlementFull(sql, r.settlementId)).net_deposited).toBe('771.00');
    expect(await chargeLinks(sql, w.orgId), 'still only the first payout\'s three links').toHaveLength(3);
  });

  it('a document with no charge on file blocks the carrier in plain words; approving it is refused with that sentence and writes nothing; the other day is not held; rejecting the carrier is the way out [kills: a payout booked around a hole (it would show as a 100.00 variance); a UUID in the sentence]', async () => {
    const s = await setup('missing', { prior: [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow('2000000009999990', -100)] });
    const { w } = s;
    expect(await codes(s, s.d1)).toEqual([]);
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_not_uploaded']);
    expect(blockers[0]!.sentence).toBe('Foodpanda settles an earlier item in this payout (document 2000000009999990, deducted 100.00), but no charge with that document number is on file. Upload that invoice first, or reject this day.');
    await approve(w, w.managerA2, s.d1);
    const before = await snapshot(w.orgId);
    const err = await approve(w, w.managerA2, s.d2).then(() => null, (e: Error & { userMessage?: string }) => e);
    expect(err?.userMessage).toBe(blockers[0]!.sentence);
    expect(await snapshot(w.orgId)).toEqual(before);
  });

  it('an amount that does not match the charges on file blocks with both sums; nothing is written [kills: a payout that guesses; the cross-check with the sign of the printed amount ignored]', async () => {
    const s = await setup('mismatch', { prior: [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow(TEST_DOCS.rebill, -90)] });
    const { w } = s;
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_items_mismatch']);
    expect(blockers[0]!.sentence).toBe('Foodpanda says this payout settles earlier items worth 90.00 deducted, but the charges on file add up to 100.00 deducted (document 2999999900000003). Check that the right invoices were uploaded, or reject this day.');
    await approve(w, w.managerA2, s.d1);
    const before = await snapshot(w.orgId);
    await expect(approve(w, w.managerA2, s.d2)).rejects.toMatchObject({ userMessage: blockers[0]!.sentence });
    expect(await snapshot(w.orgId)).toEqual(before);
  });

  it('a matching charge that is on file but not booked blocks as "book it first"; once booked the carrier clears and nets it [kills: an unbooked charge skipped (it would stay a receivable credit forever)]', async () => {
    const s = await setup('unbooked', { book: ['original', 'reversal'] });
    const { w } = s;
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_not_booked']);
    expect(blockers[0]!.sentence).toContain(TEST_DOCS.rebill);
    expect(blockers[0]!.sentence).toMatch(/Book it first/);
    await approve(w, w.managerA2, s.d1);
    await expect(approve(w, w.managerA2, s.d2)).rejects.toMatchObject({ userMessage: blockers[0]!.sentence });
    expect((await postCharge(w, w.admin, await lineOfDoc(sql, w.orgId, TEST_DOCS.rebill))).posted).toBe(true);
    expect(await codes(s, s.d2)).toEqual([]);
    expect((await approve(w, w.managerA2, s.d2)).chargeIds).toHaveLength(3);
  });

  it('the REAL descriptions ("PandaGO Order-10.31.2026-..." Delivery Service Fees rows, S8b item 9): they stage as period charges, book dated by their own order date (31 Oct), and the carrier nets all three [kills: the PandaGO delivery fee left unbookable (the real week could never match the bank); the order date lost]', async () => {
    const s = await setup('pandago', { book: [] });
    const { w } = s;
    expect((await blockersWithoutOrder(w, s.d2)).map((b) => b.code), 'unbooked: held, and told to book it').toEqual(['prior_item_not_booked', 'prior_item_not_booked', 'prior_item_not_booked']);
    for (const doc of [TEST_DOCS.original, TEST_DOCS.reversal, TEST_DOCS.rebill]) expect((await postCharge(w, w.admin, await lineOfDoc(sql, w.orgId, doc))).posted, doc).toBe(true);
    const dates = await sql<{ charge_date: string; entry_date: string }[]>`select charge_date::text, entry_date::text from channel_period_charges where org_id = ${w.orgId} order by charge_date`;
    expect(dates.filter((d) => d.charge_date === '2026-10-31')).toHaveLength(2); // the two PandaGO orders; the reversal row has no date of its own (the invoice date)
    expect(await codes(s, s.d2)).toEqual([]);
    await approve(w, w.managerA2, s.d1);
    const r = await approve(w, w.managerA2, s.d2);
    expect(r.chargeIds).toHaveLength(3);
    expect((await settlementFull(sql, r.settlementId)).net_deposited).toBe('671.00');
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
  });

  it('a PandaGO row that is NOT a delivery fee (cash on delivery) still cannot be booked: the carrier is held in its own words, not "book it first", which no button can do [kills: booking the cash PandaGO riders collected as an expense; the wrong instruction]', async () => {
    const s = await setup('cod', { cod: true, book: ['original', 'reversal'] });
    const { w } = s;
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_cannot_book']);
    expect(blockers[0]!.sentence).toContain(TEST_DOCS.rebill);
    expect(blockers[0]!.sentence).toMatch(/does not book from a file/);
    const sentence = await sentenceOf(postCharge(w, w.admin, await lineOfDoc(sql, w.orgId, TEST_DOCS.rebill)));
    expect(sentence).toMatch(/not a charge without a sales day|never booked from a statement/);
  });

  it('a charge of ANOTHER channel under the same document number is not matched: the document is looked up in this channel only [kills: a lookup by document number alone (another store\'s charge netted from this payout)]', async () => {
    const w = await s7World(sql, 's8b-chan', { loanPeriods: false });
    await setDestination(sql, w, w.fpA);
    // Malvar's own Foodpanda channel books a charge whose document number is the one Lipa's weekly prints
    await ingest(w, w.admin, zipFile(smallInvoice({ invoice: "299999000099", doc: TEST_DOCS.original, net: 89.29, vendor: MALVAR_FP })));
    expect((await postCharge(w, w.admin, await lineOfDoc(sql, w.orgId, TEST_DOCS.original))).posted).toBe(true);
    for (const d of [D1, D2]) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: 'chan', orders: [{ date: D1, revenue: 100000n }, { date: D2, revenue: 100000n }], prior: [fpPriorRow(TEST_DOCS.original, -100)] }).zip));
    const d2 = await lineOn(sql, w.orgId, w.fpA, D2);
    const blockers = await blockersWithoutOrder(w, d2.id);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_not_uploaded']);
    expect(await chargeLinks(sql, w.orgId)).toEqual([]);
  });

  it('a re-issue of the statement that changes ONLY Appendix C is read from the newer file: the day lines (same figures) keep pointing at the old upload, the printed items do not [kills: the carrier reading the superseded upload\'s items (a stale deduction booked)]', async () => {
    const s = await setup('reissue');
    const { w } = s;
    // the same weekly (same figures, same invoice number) now printing two of the three items; its day lines are "unchanged", so they keep their first upload as the source
    const second = await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: 'reissue-2', orders: [{ date: D1, revenue: 100000n }, { date: D2, revenue: 100000n }], prior: PRIOR.slice(0, 2) }).zip));
    expect(second.alreadyUploaded).toBe(false);
    expect(second.daysStaged, 'the figures did not change').toBe(0);
    const [first] = await sql<{ source_upload_id: string }[]>`select source_upload_id::text from settlement_day_lines where id = ${s.d2}`;
    expect(first!.source_upload_id, 'the carrier day still points at the first, superseded upload').not.toBe(second.uploadId);
    expect(await codes(s, s.d2)).toEqual([]);
    await approve(w, w.managerA2, s.d1);
    const r = await approve(w, w.managerA2, s.d2);
    expect(r.chargeIds, 'two items printed now: two charges netted, not three').toHaveLength(2);
    const set = await settlementFull(sql, r.settlementId);
    expect(set.net_deposited, '+100 and -100 net to nothing').toBe('771.00');
  });

  it('a re-issue of a small invoice whose charge is already booked does not hold the carrier as "not booked": the booked charge is the document\'s charge, and it is netted once [kills: a re-issued copy counted as an unbooked charge (the day stuck for ever); the same charge netted twice]', async () => {
    const s = await setup('smallreissue');
    const { w } = s;
    // the rebill invoice comes again (same invoice number and document, other bytes): a second staged line of a charge that is already booked
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: TEST_INVOICES.rebill, doc: TEST_DOCS.rebill, net: 89.29, description: PANDAGO, pdfTag: 'again' })));
    expect(await codes(s, s.d2)).toEqual([]);
    await approve(w, w.managerA2, s.d1);
    const r = await approve(w, w.managerA2, s.d2);
    expect(r.chargeIds, 'three charges, not four').toHaveLength(3);
    expect((await settlementFull(sql, r.settlementId)).net_deposited).toBe('671.00');
    expect(await netDebit(sql, w.orgId, '1220')).toBe('0.00');
  });

  it('audit 1: an item Foodpanda only PARTLY settled (Remaining Amount is not the Amount) holds the carrier in plain words and approve writes nothing [kills: a half-settled earlier charge netted as whole]', async () => {
    const s = await setup('partly', { prior: [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow(TEST_DOCS.rebill, -100, '31.10.2026', -40)] });
    const { w } = s;
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_partly_settled']);
    expect(blockers[0]!.sentence).toBe(`Foodpanda only partly settled an earlier item (document ${TEST_DOCS.rebill}); this cannot be booked automatically. Reject the day or ask for help.`);
    await approve(w, w.managerA2, s.d1);
    const before = await snapshot(w.orgId);
    await expect(approve(w, w.managerA2, s.d2)).rejects.toMatchObject({ userMessage: blockers[0]!.sentence });
    expect(await snapshot(w.orgId)).toEqual(before);
  });

  it('audit 2: the check is per document: Appendix C (original -300, re-bill +100) against books original +100 and re-bill +100 add up the same in total and are still blocked, once per document [kills: one total over all items]', async () => {
    const s = await setup('perdoc', { prior: [fpPriorRow(TEST_DOCS.original, -300), fpPriorRow(TEST_DOCS.rebill, 100)], book: ['original', 'reversal', 'rebill'] });
    const blockers = await blockersWithoutOrder(s.w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_items_mismatch', 'prior_items_mismatch']);
    expect(blockers[0]!.sentence).toContain(`(document ${TEST_DOCS.original})`);
    expect(blockers[1]!.sentence).toContain(`(document ${TEST_DOCS.rebill})`);
  });

  it('audit 4: a charge staged before document numbers were kept is not "upload that invoice first": the sentence says it was uploaded before numbers were kept and asks for the file again; the repeat upload of the same bytes fills the number and the carrier is free [kills: the wrong instruction for a charge that is on file; a legacy charge matched by nothing]', async () => {
    const s = await setup('legacy', {});
    const { w } = s;
    const bytes = zipFile(smallInvoice({ invoice: TEST_INVOICES.original, doc: TEST_DOCS.original, net: 89.29, description: PANDAGO }));
    await sql`update settlement_other_lines ol set official_document = null from settlement_uploads u where u.id = ol.upload_id and u.org_id = ${w.orgId} and u.invoice_number = ${TEST_INVOICES.original}`;
    const blockers = await blockersWithoutOrder(w, s.d2);
    expect(blockers.map((b) => b.code)).toEqual(['prior_item_not_uploaded']);
    expect(blockers[0]!.sentence).toContain('That earlier invoice was uploaded before document numbers were kept. Upload its file again.');
    expect(blockers[0]!.sentence).not.toMatch(/Upload that invoice first/);
    const again = await ingest(w, w.managerA, bytes);
    expect(again.alreadyUploaded).toBe(true);
    expect(await codes(s, s.d2)).toEqual([]);
    await approve(w, w.managerA2, s.d1);
    expect((await approve(w, w.managerA2, s.d2)).chargeIds).toHaveLength(3);
  });

  it('only the carrier is held and only the carrier nets: a weekly with no Appendix C and no own charges is unchanged (S7 behaviour) [kills: a regression of the plain day]', async () => {
    const w = await s7World(sql, 's8b-plain', { loanPeriods: false });
    await setDestination(sql, w, w.fpA);
    for (const d of [D1, D2]) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: 'plain', orders: [{ date: D1, revenue: 100000n }, { date: D2, revenue: 100000n }] }).zip));
    const d1 = await lineOn(sql, w.orgId, w.fpA, D1);
    const d2 = await lineOn(sql, w.orgId, w.fpA, D2);
    await approve(w, w.managerA2, d1.id);
    const r = await approve(w, w.managerA2, d2.id);
    expect(r.chargeIds).toEqual([]);
    expect((await settlementFull(sql, r.settlementId)).net_deposited).toBe('771.00');
  });
});

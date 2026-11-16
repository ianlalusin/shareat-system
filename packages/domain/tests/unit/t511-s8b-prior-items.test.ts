/**
 * T-511 S8b (5) - the earlier-invoice deductions of a Foodpanda payout, as pure rules: which charges the carrier day nets, which blockers hold it, the cross-check.
 * docs/tasks/511-settlement-upload-s8-spec.md "S8b" item 5. The numbers are the real weekly's: three items on Appendix C, (2999999900000001, -100), (3999999900000002, +100),
 * (2999999900000003, -100), against the three small invoices' charges 100.00, -100.00, 100.00 (89.29 + 10.71 VAT, reversal, re-bill).
 */
import { describe, expect, it } from 'vitest';
import { evaluatePriorItems, type EarlierCharge, type EarlierItemFact } from '../../src/settlement-intake/prior-items';
import { carrierChargesFor } from '../../src/settlement-intake/settlement-input';

const charge = (id: string, total: string, over: Partial<EarlierCharge> = {}): EarlierCharge => ({ chargeId: id, totalAmount: total, invoiceNumber: `inv-${id}`, chargeDate: '2026-10-31', nettedBySettlementId: null, ...over });
const item = (document: string, amount: string, charges: EarlierCharge[], over: Partial<EarlierItemFact> = {}): EarlierItemFact => ({ document, amount, remaining: amount, charges, stagedBookable: 0, stagedOther: 0, legacyUndocumented: 0, ...over });

const REAL = (): EarlierItemFact[] => [
  item('2999999900000001', '-100.00', [charge('c1', '100.00')]),
  item('3999999900000002', '100.00', [charge('c2', '-100.00')]),
  item('2999999900000003', '-100.00', [charge('c3', '100.00')]),
];

describe('evaluatePriorItems - the real three items', () => {
  it('all three booked and un-netted: all three are netted, no problem, the printed side (+100) equals the books (+100) [kills: a sign flipped on either side; a charge left out]', () => {
    const v = evaluatePriorItems(REAL());
    expect(v.problems).toEqual([]);
    expect(v.charges.map((c) => c.chargeId)).toEqual(['c1', 'c2', 'c3']);
    expect(v.views.map((x) => [x.document, x.total, x.netted])).toEqual([['2999999900000001', '100.00', false], ['3999999900000002', '-100.00', false], ['2999999900000003', '100.00', false]]);
  });

  it('an amount that does not match the charges: prior_items_mismatch in plain words naming both sums [kills: no cross-check; the printed sign not negated; a check on the count instead of the money]', () => {
    const facts = REAL();
    facts[0] = item('2999999900000001', '-100.00', [charge('c1', '112.00')]);
    const v = evaluatePriorItems(facts);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_items_mismatch']);
    expect(v.problems[0]!.sentence).toBe('Foodpanda says this payout settles earlier items worth 100.00 deducted, but the charges on file add up to 112.00 deducted (document 2999999900000001). Check that the right invoices were uploaded, or reject this day.');
  });

  it('the printed sign matters: all three printed with the OPPOSITE signs (+100, -100, +100) is a mismatch, not a pass [kills: comparing |amount| instead of the signed amount]', () => {
    const v = evaluatePriorItems([
      item('2999999900000001', '100.00', [charge('c1', '100.00')]),
      item('3999999900000002', '-100.00', [charge('c2', '-100.00')]),
      item('2999999900000003', '100.00', [charge('c3', '100.00')]),
    ]);
    expect(v.problems.map((p) => p.code), 'one blocker per document').toEqual(['prior_items_mismatch', 'prior_items_mismatch', 'prior_items_mismatch']);
  });

  it('a document with no charge on file is blocked as "upload it first" and names the document, the amount and the escape; nothing is netted for it [kills: a missing document read as zero; the day approved with a hole]', () => {
    const facts = REAL();
    facts[1] = item('3999999900000002', '100.00', []);
    const v = evaluatePriorItems(facts);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_item_not_uploaded']);
    expect(v.problems[0]!.sentence).toContain('3999999900000002');
    // the house money format: a word for the direction, never a bare signed number (S8b audit 13)
    expect(v.problems[0]!.sentence).toContain('(document 3999999900000002, credited 100.00)');
    expect(v.problems[0]!.sentence).not.toMatch(/[ (]-[0-9]/);
    expect(v.problems[0]!.sentence).toMatch(/Upload that invoice first, or reject this day\.$/);
    expect(v.problems[0]!.sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it('a charge on file but not booked is blocked as "book it first"; a staged line of a kind nothing books (PandaGO) is blocked in its own words; booked wins over neither [kills: an unbooked charge ignored; the wrong instruction for an unbookable kind]', () => {
    const facts = REAL();
    facts[0] = item('2999999900000001', '-100.00', [], { stagedBookable: 1 });
    facts[2] = item('2999999900000003', '-100.00', [], { stagedOther: 1 });
    const v = evaluatePriorItems(facts);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_item_not_booked', 'prior_item_cannot_book']);
    expect(v.problems[0]!.sentence).toMatch(/not booked yet. Book it first/);
    expect(v.problems[1]!.sentence).toMatch(/does not book from a file/);
    // one row of a document booked and another still staged: the document is not fully booked
    const partial = evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00')], { stagedBookable: 1 })]);
    expect(partial.problems.map((p) => p.code)).toEqual(['prior_item_not_booked']);
  });

  it('a charge a live settlement already netted is informational: listed as netted, never netted again, and left out of the cross-check [kills: a double net; a mismatch caused by an item that was settled before]', () => {
    const facts = REAL();
    facts[0] = item('2999999900000001', '-100.00', [charge('c1', '100.00', { nettedBySettlementId: 's-1' })]);
    const v = evaluatePriorItems(facts);
    expect(v.charges.map((c) => c.chargeId)).toEqual(['c2', 'c3']);
    expect(v.views.find((x) => x.document === '2999999900000001')?.netted).toBe(true);
    // the netted item is outside the check: the other two are (-100 printed => 100 owed... c2 is -100, c3 is 100) 0 = 0
    expect(v.problems).toEqual([]);
    const only = evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00', { nettedBySettlementId: 's-1' })])]);
    expect(only.charges).toEqual([]);
    expect(only.problems).toEqual([]);
  });

  it('a document printed twice is blocked in its own words, even when the two rows add up to the books [kills: de-duplicating the printed rows (a double deduction passing as a single charge)]', () => {
    const one = charge('c1', '100.00');
    const v = evaluatePriorItems([item('2999999900000001', '-100.00', [one]), item('2999999900000001', '-100.00', [one])]);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_items_mismatch']);
    expect(v.problems[0]!.sentence).toContain('printed document 2999999900000001 more than once');
    // two half-rows that add up to the one charge are still a document printed twice
    const halves = evaluatePriorItems([item('2999999900000001', '-60.00', [one]), item('2999999900000001', '-40.00', [one])]);
    expect(halves.problems.map((p) => p.code)).toEqual(['prior_items_mismatch']);
    expect(halves.problems[0]!.sentence).toContain('more than once');
  });

  it('audit 2: the cross-check is PER DOCUMENT: (A, -300) and (B, +100) against books A = +100 and B = +100 add up the same in total (200 = 200) and are still blocked, naming A [kills: one total over all items (an over-deduction on one document hidden by a credit on another)]', () => {
    const w = evaluatePriorItems([item('A', '-300.00', [charge('c1', '100.00')]), item('B', '100.00', [charge('c2', '100.00')])]);
    expect(w.problems.map((p) => p.code)).toEqual(['prior_items_mismatch', 'prior_items_mismatch']);
    expect(w.problems[0]!.sentence).toBe('Foodpanda says this payout settles earlier items worth 300.00 deducted, but the charges on file add up to 100.00 deducted (document A). Check that the right invoices were uploaded, or reject this day.');
    expect(w.problems[1]!.sentence).toContain('(document B)');
  });

  it('audit 1: an item Foodpanda only PARTLY settled (remaining is not the amount, or is unknown) is blocked in plain words and nothing is netted for it [kills: a half-settled item booked as fully settled]', () => {
    const half = evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00')], { remaining: '-40.00' })]);
    expect(half.problems.map((p) => p.code)).toEqual(['prior_item_partly_settled']);
    expect(half.problems[0]!.sentence).toBe('Foodpanda only partly settled an earlier item (document 2999999900000001); this cannot be booked automatically. Reject the day or ask for help.');
    const unknown = evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00')], { remaining: null })]);
    expect(unknown.problems.map((p) => p.code)).toEqual(['prior_item_partly_settled']);
    // equal in value, written differently: fine
    expect(evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00')], { remaining: '-100' })]).problems).toEqual([]);
    // an item that was already netted is informational: its remaining is not looked at
    expect(evaluatePriorItems([item('2999999900000001', '-100.00', [charge('c1', '100.00', { nettedBySettlementId: 's-1' })], { remaining: '0.00' })]).problems).toEqual([]);
  });

  it('audit 4: a document with nothing on file while the channel holds charges staged before document numbers were kept says so and asks for the file again; it never says "upload that invoice first" [kills: the wrong instruction for a charge that is on file without its number]', () => {
    const v = evaluatePriorItems([item('2999999900000001', '-100.00', [], { legacyUndocumented: 2 })]);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_item_not_uploaded']);
    expect(v.problems[0]!.sentence).toContain('That earlier invoice was uploaded before document numbers were kept. Upload its file again.');
    expect(v.problems[0]!.sentence).not.toMatch(/Upload that invoice first/);
  });

  it('a document with two booked charges (a document that has two rows) nets both and checks their SUM against the one printed amount [kills: only the first charge netted]', () => {
    const v = evaluatePriorItems([item('2999999900000001', '-150.00', [charge('c1', '100.00'), charge('c2', '50.00')])]);
    expect(v.problems).toEqual([]);
    expect(v.charges.map((c) => c.chargeId)).toEqual(['c1', 'c2']);
  });

  it('no printed items: nothing to net, nothing to say [kills: a problem raised for an ordinary weekly]', () => {
    expect(evaluatePriorItems([])).toEqual({ charges: [], views: [], problems: [] });
  });

  it('items that net to zero (+100 and -100) are still matched and netted: two ids, total 0.00 [kills: a zero-sum pair skipped (the charges would stay as 1220 credits)]', () => {
    const v = evaluatePriorItems([item('a', '-100.00', [charge('c1', '100.00')]), item('b', '100.00', [charge('c2', '-100.00')])]);
    expect(v.problems).toEqual([]);
    expect(v.charges.map((c) => c.chargeId)).toEqual(['c1', 'c2']);
  });

  it('a row problem hides the cross-check (one cause, one sentence), never both [kills: a mismatch sentence on top of "upload it first"]', () => {
    const v = evaluatePriorItems([item('a', '-100.00', [charge('c1', '100.00')]), item('b', '-100.00', [])]);
    expect(v.problems.map((p) => p.code)).toEqual(['prior_item_not_uploaded']);
  });
});

describe('carrierChargesFor - the carrier day nets its own invoice AND the earlier invoices its upload lists', () => {
  const own = { chargeId: 'own1', totalAmount: '112.00', nettedBySettlementId: null as string | null };
  const base = (earlier: EarlierItemFact[], charges = [own]) => ({ carrierDate: '2026-11-07', charges, earlier });
  const day = { salesDate: '2026-11-07', isCurrent: true };

  it('own 112.00 plus the real three (100.00, -100.00, 100.00) = four ids and 212.00; the earlier ids are listed for the screen [kills: only the own invoice netted (the whole point of S8b); the earlier charges not summed]', () => {
    const c = carrierChargesFor(day, base(REAL()));
    expect(c.isCarrier).toBe(true);
    expect(c.charges).toEqual({ ids: ['own1', 'c1', 'c2', 'c3'], total: '212.00' });
    expect(c.problems).toEqual([]);
    expect(c.earlierViews).toHaveLength(3);
    expect(c.priorItems).toEqual([{ document: '2999999900000001', amount: '-100.00' }, { document: '3999999900000002', amount: '100.00' }, { document: '2999999900000003', amount: '-100.00' }]);
  });

  it('a day that is not the carrier nets nothing and shows nothing, whatever the upload lists [kills: every day of the invoice netting the earlier items]', () => {
    const c = carrierChargesFor({ salesDate: '2026-11-06', isCurrent: true }, base(REAL()));
    expect(c).toEqual({ isCarrier: false, unbooked: 0, charges: null, problems: [], earlierViews: [], priorItems: [] });
  });

  it('a non-current line is not a carrier either [kills: a replaced day netting charges]', () => {
    expect(carrierChargesFor({ salesDate: '2026-11-07', isCurrent: false }, base(REAL())).charges).toBeNull();
  });

  it('a charge named by an item AND already among the own invoice\'s charges is netted once [kills: the same id twice in settleChargeIds / double the total]', () => {
    const c = carrierChargesFor(day, base([item('x', '-112.00', [{ chargeId: 'own1', totalAmount: '112.00', invoiceNumber: null, chargeDate: null, nettedBySettlementId: null }])]));
    expect(c.charges).toEqual({ ids: ['own1'], total: '112.00' });
  });

  it('with no earlier facts at all (an invoice before S8b) the old behaviour is unchanged: own charges only, no problem [kills: a regression of the S7 carrier rule]', () => {
    const c = carrierChargesFor(day, { carrierDate: '2026-11-07', charges: [own] });
    expect(c.charges).toEqual({ ids: ['own1'], total: '112.00' });
    expect(c.problems).toEqual([]);
  });

  it('the problems of the earlier items surface on the carrier, and the earlier charges are NOT offered for netting while one is wrong [kills: a payout netting around a hole]', () => {
    const facts = REAL();
    facts[1] = item('3999999900000002', '100.00', []);
    const c = carrierChargesFor(day, base(facts));
    expect(c.problems.map((p) => p.code)).toEqual(['prior_item_not_uploaded']);
    expect(c.charges).toEqual({ ids: ['own1'], total: '112.00' });
  });
});

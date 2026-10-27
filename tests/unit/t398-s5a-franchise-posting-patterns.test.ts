import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKED_EXAMPLES, type FixtureLine, type WorkedExample } from '../worked-examples/fixtures';

/**
 * T-398 S5a (TESTER) -- the four franchise (inter-entity) posting patterns.
 * docs/tasks/398-s5/{POSTING-PATTERNS-DRAFT,TESTS,S5-REFRESH}.md, TESTS.md legs PP1-PP3.
 *
 * These cases are ADDITIVE to tests/unit/posting-patterns-doc.test.ts (which already pins heading <-> fixture parity
 * in both directions for every id). They pin what that file cannot: the NAMED ids, their exact lines, centavo
 * arithmetic, the doc section's place and its FENCED (Q5) markers, and the retired "do not use for a franchise" warning.
 *
 * RED today for one reason: docs/POSTING-PATTERNS.md has no "Franchise dispatch" section and still carries the old
 * warning. (The four fixtures were added to tests/worked-examples/fixtures.ts by this tester, so the existing doc-parity
 * test is red too: four fixtures have no heading.)
 *
 * VAT (Q5, answer due 13 Nov): NOTHING here asserts that a VAT line is absent (draft rule, C3). The only VAT-related
 * assertion is that the lines whose amount would move under Q5 (a) are MARKED as fenced in the doc.
 *
 * No floats: every amount below is a decimal string converted to integer centavos by string arithmetic.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'POSTING-PATTERNS.md'), 'utf8');

const IDS = [
  'trade_dispatch.franchise',
  'trade_receipt.franchise',
  'trade_receipt.franchise-bill',
  'trade_dispatch.franchise_transit_shortage',
] as const;

const fixture = (id: string): WorkedExample | undefined => WORKED_EXAMPLES.find((f) => f.id === id);
const headingLine = (id: string) => DOC.split(/\r?\n/).findIndex((l) => new RegExp('^###\\s+`' + id.replace(/\./g, '\\.') + '`').test(l));

/** '3100.00' -> 310000n. Strings only; throws on anything that is not a 2-decimal money string. */
function centavos(s: string): bigint {
  const m = /^(\d+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error(`not a 2-decimal money string: ${JSON.stringify(s)}`);
  return BigInt(m[1]!) * 100n + BigInt(m[2]!);
}
const sum = (lines: FixtureLine[], side: 'debit' | 'credit') =>
  lines.reduce((acc, l) => acc + (l[side] === undefined ? 0n : centavos(l[side]!)), 0n);
/** '10.000' (3 dp) * '310.00' (2 dp) -> centavos, rounded half-up, all in integers. */
function mulQtyRate(qty: string, rate: string): bigint {
  const q = /^(\d+)\.(\d{3})$/.exec(qty)!;
  const qThousandths = BigInt(q[1]!) * 1000n + BigInt(q[2]!);
  const r = centavos(rate);
  const prod = qThousandths * r; // thousandths of a centavo
  return (prod + 500n) / 1000n;
}

describe('PP1 -- the four ids exist as headings AND fixtures (kills: delete one heading or one fixture)', () => {
  it.each(IDS)('%s has a ### heading in docs/POSTING-PATTERNS.md', (id) => {
    expect(headingLine(id), `RED today: no \`### \`${id}\`\` heading in docs/POSTING-PATTERNS.md (S5a not written)`).toBeGreaterThanOrEqual(0);
  });

  it.each(IDS)('%s has a fixture in tests/worked-examples/fixtures.ts', (id) => {
    expect(fixture(id), `${id}: no fixture`).toBeDefined();
  });

  it('the four headings sit in one section, in draft order: dispatch, receipt, receipt-bill, shortage (kills: scattered or reordered)', () => {
    const lines = IDS.map(headingLine);
    expect(lines.every((n) => n >= 0), `RED today: headings missing: ${JSON.stringify(lines)}`).toBe(true);
    expect([...lines].sort((a, b) => a - b), 'headings out of draft order').toEqual(lines);
  });

  it('the section is placed after "Customer return" and before "Cash request" (draft placement; kills: pasted at the end)', () => {
    const at = (re: RegExp) => DOC.split(/\r?\n/).findIndex((l) => re.test(l));
    const customerReturn = at(/^##\s+Customer return\b/);
    const cashRequest = at(/^##\s+Cash request release and return\b/);
    const franchise = at(/^##\s+Franchise dispatch\b/);
    expect(franchise, 'RED today: no "## Franchise dispatch" section').toBeGreaterThanOrEqual(0);
    expect(franchise).toBeGreaterThan(customerReturn);
    expect(franchise).toBeLessThan(cashRequest);
  });

  it('the section states v1-vs-v2 truths a reader needs: another company, nothing eliminates, ADR-008 s4, no entry spans two organisations', () => {
    const start = DOC.search(/^##\s+Franchise dispatch\b/m);
    expect(start, 'RED today: no Franchise dispatch section').toBeGreaterThanOrEqual(0);
    const section = DOC.slice(start, DOC.indexOf('\n## ', start + 5) === -1 ? undefined : DOC.indexOf('\n## ', start + 5));
    expect(section).toMatch(/ADR-008/);
    expect(section).toMatch(/nothing eliminates/i);
    expect(section, 'must say no entry has lines in two organisations').toMatch(/two organi[sz]ations/i);
    expect(section, 'the shipment note ties the two sides').toMatch(/inter_entity_shipments/);
  });
});

describe('PP2 -- each new fixture balances to the centavo, has no float, and posts exactly the draft lines', () => {
  it.each(IDS)('%s: debits = credits, exact, in centavos (kills: any one leg changed)', (id) => {
    const f = fixture(id);
    expect(f, `${id}: no fixture`).toBeDefined();
    expect(sum(f!.expect, 'debit')).toBe(sum(f!.expect, 'credit'));
    expect(sum(f!.expect, 'debit') > 0n).toBe(true);
  });

  it.each(IDS)('%s: every amount is a clean 2-decimal string and exactly one side is set per line', (id) => {
    const f = fixture(id);
    expect(f, `${id}: no fixture`).toBeDefined();
    for (const l of f!.expect) {
      expect([l.debit !== undefined, l.credit !== undefined].filter(Boolean).length, `${id} ${l.accountCode}: exactly one side`).toBe(1);
      for (const v of [l.debit, l.credit]) if (v !== undefined) expect(v, `${id} ${l.accountCode}`).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('trade_dispatch.franchise: the legs of an external sale -- 1210 (party PG) / 4300, 5100 / 1310; never the 1340/1250/2150 elimination', () => {
    const f = fixture('trade_dispatch.franchise');
    expect(f, 'no fixture').toBeDefined();
    expect(f!.sourceType).toBe('trade_order_dispatch');
    expect(f!.expect.map((l) => `${l.accountCode}${l.debit !== undefined ? ' D ' + l.debit : ' C ' + l.credit}`)).toEqual([
      '1210 D 3100.00',
      '4300 C 3100.00',
      '5100 D 2500.00',
      '1310 C 2500.00',
    ]);
    expect(f!.expect[0]!.party, 'AR names the customer').toEqual({ type: 'customer', id: 'customer:CUST-PG' });
    const codes = f!.expect.map((l) => l.accountCode);
    for (const internal of ['1340', '1250', '2150']) expect(codes, `elimination account ${internal} must not appear`).not.toContain(internal);
  });

  it('trade_dispatch.franchise: revenue = 10.000 x 310.00 and cost = 10.000 x 250.0000, integer arithmetic (kills: wrong rate or cost)', () => {
    const f = fixture('trade_dispatch.franchise');
    expect(f, 'no fixture').toBeDefined();
    const input = f!.input as { quantity: string; rate: string; unitCost: string };
    expect(centavos(f!.expect[1]!.credit!)).toBe(mulQtyRate(input.quantity, input.rate));
    const [whole, frac] = input.unitCost.split('.') as [string, string];
    const unitCostCentavos = BigInt(whole) * 100n + BigInt(frac.slice(0, 2)); // 250.0000 -> 25000 (cost has no sub-centavo here)
    expect(frac.slice(2)).toBe('00');
    const qty = /^(\d+)\.(\d{3})$/.exec(input.quantity)!;
    expect(centavos(f!.expect[2]!.debit!)).toBe(((BigInt(qty[1]!) * 1000n + BigInt(qty[2]!)) * unitCostCentavos + 500n) / 1000n);
  });

  it('trade_receipt.franchise: DR 1310 / CR 2120 at the SHIPMENT rate, no party (kills: valued at dispatched cost, or straight to 2110)', () => {
    const f = fixture('trade_receipt.franchise');
    expect(f, 'no fixture').toBeDefined();
    expect(f!.sourceType).toBe('stock_receipt');
    expect(f!.expect.map((l) => `${l.accountCode}${l.debit !== undefined ? ' D ' + l.debit : ' C ' + l.credit}`)).toEqual(['1310 D 3100.00', '2120 C 3100.00']);
    expect(f!.expect.map((l) => l.accountCode)).not.toContain('2110');
  });

  it('trade_receipt.franchise-bill: DR 2120 / CR 2110, party = the commissary supplier, same value as the receipt to the centavo (kills: a 5450 variance line, or no party)', () => {
    const receipt = fixture('trade_receipt.franchise');
    const bill = fixture('trade_receipt.franchise-bill');
    expect(bill, 'no fixture').toBeDefined();
    expect(receipt, 'no receipt fixture').toBeDefined();
    expect(bill!.sourceType).toBe('stock_receipt_invoice');
    expect(bill!.expect.map((l) => `${l.accountCode}${l.debit !== undefined ? ' D ' + l.debit : ' C ' + l.credit}`)).toEqual(['2120 D 3100.00', '2110 C 3100.00']);
    expect(bill!.expect[1]!.party).toEqual({ type: 'supplier', id: 'supplier:SUP-COMMISSARY' });
    expect(sum(bill!.expect, 'credit'), 'the bill equals the receipt, so the clearing is exact').toBe(sum(receipt!.expect, 'credit'));
    expect(bill!.expect.map((l) => l.accountCode), 'no variance account can arise').not.toContain('5450');
  });

  it('trade_dispatch.franchise_transit_shortage: 4950/1210 for the exact gap and 5300/5100 for the short cost -- NOT 5400 (kills: 5300 -> 5400)', () => {
    const f = fixture('trade_dispatch.franchise_transit_shortage');
    expect(f, 'no fixture').toBeDefined();
    expect(f!.sourceType).toBe('trade_order_credit');
    expect(f!.expect.map((l) => `${l.accountCode}${l.debit !== undefined ? ' D ' + l.debit : ' C ' + l.credit}`)).toEqual([
      '4950 D 620.00',
      '1210 C 620.00',
      '5300 D 500.00',
      '5100 C 500.00',
    ]);
    expect(f!.expect.map((l) => l.accountCode)).not.toContain('5400');
    expect(f!.expect.map((l) => l.accountCode), 'nothing comes back: no 1310 debit').not.toContain('1310');
    expect(f!.expect[1]!.party).toEqual({ type: 'customer', id: 'customer:CUST-PG' });
  });

  it('the credit equals billed line total minus round(received x rate) -- the gap PG actually booked -- in integer centavos (kills: round(short x rate))', () => {
    const f = fixture('trade_dispatch.franchise_transit_shortage');
    expect(f, 'no fixture').toBeDefined();
    const i = f!.input as { shippedQuantity: string; receivedQuantity: string; rate: string };
    const billed = mulQtyRate(i.shippedQuantity, i.rate);
    const pgBooked = mulQtyRate(i.receivedQuantity, i.rate);
    expect(billed - pgBooked).toBe(centavos(f!.expect[0]!.debit!));
    // The rounding trap: 0.500 kg billed at 7.77 = 3.89 (half-up); PG received 0.250 kg = 1.94. The gap PG booked is 1.95,
    // while round(short x rate) = round(0.250 x 7.77) = 1.94 -- a centavo off. The rule must be the first, never the second.
    const gapRight = mulQtyRate('0.500', '7.77') - mulQtyRate('0.250', '7.77');
    const gapWrong = mulQtyRate('0.250', '7.77');
    expect(gapRight).toBe(centavos('1.95'));
    expect(gapWrong, 'the wrong formula really does differ here, so the fixture rule matters').toBe(centavos('1.94'));
  });

  it('cost leg = the dispatch consumption for the short quantity: 2.000 kg x 250.0000 = 500.00, never today\'s layers', () => {
    const f = fixture('trade_dispatch.franchise_transit_shortage');
    expect(f, 'no fixture').toBeDefined();
    const i = f!.input as { shippedQuantity: string; receivedQuantity: string; unitCost: string };
    const shortThousandths = BigInt(i.shippedQuantity.replace('.', '')) - BigInt(i.receivedQuantity.replace('.', ''));
    expect(shortThousandths).toBe(2000n);
    const unitCentavos = BigInt(i.unitCost.replace('.', '')) / 100n; // '250.0000' -> 25000
    expect(centavos(f!.expect[2]!.debit!)).toBe((shortThousandths * unitCentavos + 500n) / 1000n);
  });

  it('the credit note carries the new source type trade_order_credit (no journal CHECK on source_type, so no migration is needed for it)', () => {
    expect(fixture('trade_dispatch.franchise_transit_shortage')?.sourceType).toBe('trade_order_credit');
  });
});

describe('VAT fence (Q5) -- fenced lines are MARKED in the doc; nothing asserts a VAT line is absent', () => {
  const section = (): string => {
    const start = DOC.search(/^##\s+Franchise dispatch\b/m);
    expect(start, 'RED today: no Franchise dispatch section').toBeGreaterThanOrEqual(0);
    const next = DOC.indexOf('\n## ', start + 5);
    return DOC.slice(start, next === -1 ? undefined : next);
  };

  it('the section names Q5 and the 13 Nov date, and says v2 computes no VAT today', () => {
    const s = section();
    expect(s).toMatch(/Q5/);
    expect(s).toMatch(/13 Nov/);
    expect(s).toMatch(/no VAT|computes no VAT/i);
  });

  it('FENCED marks the lines that move under Q5 (a): revenue 4300, receipt inventory 1310, 4950 -- at least four marks (kills: markers removed)', () => {
    const marks = section().match(/FENCED/g) ?? [];
    expect(marks.length, 'draft marks 4300, the VAT row, the receipt 1310, the input-VAT row and 4950').toBeGreaterThanOrEqual(4);
  });

  it('the section carries the rule that no test may assert a VAT line is absent (so a later VAT slice is not a rewrite)', () => {
    expect(section()).toMatch(/No test may assert that a VAT line is absent/);
  });
});

describe('PP3 -- the old "do not use this for a franchise" warning is gone and points at the new section', () => {
  const commissaryBlock = (): string => {
    const start = DOC.search(/^##\s+Commissary dispatch\b/m);
    expect(start, 'Commissary dispatch section missing').toBeGreaterThanOrEqual(0);
    const next = DOC.indexOf('\n## ', start + 5);
    return DOC.slice(start, next === -1 ? undefined : next);
  };

  it('the head of "Commissary dispatch" no longer says "Do not use this one for a franchise" / "not yet written here"', () => {
    const head = commissaryBlock().slice(0, 1500);
    expect(head, 'RED today: the warning is still there').not.toMatch(/Do not use this one for a franchise/);
    expect(head).not.toMatch(/is not yet written here/);
    expect(DOC, 'no copy of the old warning may survive anywhere').not.toMatch(/is not yet written here/);
  });

  it('it carries a one-line pointer to the Franchise dispatch section: a real sale on both sides, never this elimination', () => {
    const head = commissaryBlock().slice(0, 1500);
    expect(head, 'RED today: no pointer').toMatch(/Franchise dispatch/);
    expect(head).toMatch(/real sale/i);
    expect(head).toMatch(/never this elimination|not this elimination/i);
  });

  it('the pointer is a single blockquote line, not a second multi-line warning (kills: a paragraph re-added)', () => {
    const lines = commissaryBlock().split(/\r?\n/).slice(0, 12);
    const quoted = lines.filter((l) => l.startsWith('>'));
    expect(quoted.length, 'expected exactly one pointer line in the head').toBe(1);
  });
});

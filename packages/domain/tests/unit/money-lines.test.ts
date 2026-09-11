import { describe, expect, it } from 'vitest';
import { money, ZERO } from '@shareat/core/money';
import {
  accountAsSource,
  bandFor,
  drawnPerSource,
  floatAsSource,
  groupSourcesByCoverage,
  keyOfSource,
  labelOf,
  methodsForDirection,
  sourceKey,
  totalOf,
  tryMoney,
  validateMoneyLines,
  type MoneyAccountOption,
  type FloatOption,
  type MoneyLine,
  type SourceOption,
} from '../../src/shared/money-lines';

/**
 * T-266 — `docs/tasks/266-money-lines.md`. The pure rules behind the money form, proven without a
 * database or a browser, because the server action calls these same functions.
 */

const account = (over: Partial<MoneyAccountOption> = {}): MoneyAccountOption => ({
  id: 'acct-office-cash',
  name: 'Office cash',
  storeId: 'store-lipa',
  custodian: 'office',
  instrument: 'cash',
  glAccountCode: '1130',
  balance: '42180.00',
  overdraftLimit: '0.00',
  floatTarget: null,
  ...over,
});

const float = (over: Partial<FloatOption> = {}): FloatOption => ({
  cashRequestId: 'cr-ana-447',
  holderName: 'Ana Cruz',
  outstanding: '1240.00',
  moneyAccountId: 'acct-staff-float',
  storeId: 'store-lipa',
  ...over,
});

const line = (over: Partial<MoneyLine> = {}): MoneyLine => ({
  method: 'cash',
  amount: '1000.00',
  moneyAccountId: 'acct-office-cash',
  ...over,
});

describe('methodsForDirection', () => {
  it('offers credit and reimbursable going OUT, store credit and offset coming IN', () => {
    expect(methodsForDirection('out')).toContain('credit');
    expect(methodsForDirection('out')).toContain('reimbursable');
    expect(methodsForDirection('in')).toContain('store_credit');
    expect(methodsForDirection('in')).toContain('offset');
  });

  it('⛔ never offers "other" or "ar_collection" in either direction — they cannot post (DEF-054)', () => {
    // They stay in `expense_payments.method` for ETL'd history and `routeExpense` blocks them.
    // A method guaranteed to fail is not a method a form offers (Ian's ruling 4).
    for (const direction of ['out', 'in'] as const) {
      expect(methodsForDirection(direction)).not.toContain('other');
      expect(methodsForDirection(direction)).not.toContain('ar_collection');
    }
  });
});

describe('tryMoney — runs on every keystroke, so it never throws', () => {
  it('returns null for blank, whitespace and garbage rather than throwing', () => {
    expect(tryMoney('')).toBeNull();
    expect(tryMoney('   ')).toBeNull();
    expect(tryMoney('abc')).toBeNull();
    expect(tryMoney(null)).toBeNull();
    expect(tryMoney(undefined)).toBeNull();
  });

  it('⛔ refuses sub-centavo precision — DEF-272, the guard that "0.004 > 0" defeated', () => {
    expect(tryMoney('0.004')).toBeNull();
    expect(tryMoney('1.234')).toBeNull();
    expect(tryMoney('1.23')).toBe(money('1.23'));
  });
});

describe('drawnPerSource — §6.3, summed per SOURCE not per line', () => {
  it('⭐ two lines against one drawer sum together — individually affordable, together not', () => {
    const drawn = drawnPerSource([
      line({ amount: '600.00' }),
      line({ amount: '600.00' }),
    ]);
    expect(drawn.get('account:acct-office-cash')).toBe(money('1200.00'));
  });

  it('⭐ two floats on the SAME staff-float account do NOT sum — each has its own balance', () => {
    // This is the case that makes 1120 a control account rather than a place. Keying by
    // moneyAccountId would merge Ana's ₱1,240 and Ben's ₱380 into one ₱1,620 pot that
    // belongs to nobody.
    const drawn = drawnPerSource([
      line({ moneyAccountId: 'acct-staff-float', cashRequestId: 'cr-ana-447', amount: '500.00' }),
      line({ moneyAccountId: 'acct-staff-float', cashRequestId: 'cr-ben-448', amount: '300.00' }),
    ]);
    expect(drawn.get('float:cr-ana-447')).toBe(money('500.00'));
    expect(drawn.get('float:cr-ben-448')).toBe(money('300.00'));
    expect(drawn.has('account:acct-staff-float')).toBe(false);
  });

  it('ignores half-typed rows — a blank amount is not a claim about money', () => {
    const drawn = drawnPerSource([line({ amount: '' }), line({ amount: '250.00' })]);
    expect(drawn.get('account:acct-office-cash')).toBe(money('250.00'));
  });

  it('ignores a line that names no source at all', () => {
    expect(sourceKey({ moneyAccountId: null, cashRequestId: null })).toBeNull();
    expect(drawnPerSource([line({ moneyAccountId: null })]).size).toBe(0);
  });
});

describe('bandFor — the picker groups', () => {
  it('covers when the balance is enough, short when it is not, empty at zero', () => {
    expect(bandFor(money('42180.00'), money('3500.00'))).toBe('covers');
    expect(bandFor(money('1200.00'), money('3500.00'))).toBe('short');
    expect(bandFor(ZERO, money('3500.00'))).toBe('empty');
  });

  it('⭐ judges the SECOND line on what the first already claimed', () => {
    // ₱1,000 drawer, ₱600 already taken by another line — a second ₱600 is short, not covered.
    expect(bandFor(money('1000.00'), money('600.00'))).toBe('covers');
    expect(bandFor(money('1000.00'), money('600.00'), money('600.00'))).toBe('short');
  });

  it('a negative balance reads as empty, not as some band below empty', () => {
    expect(bandFor(money('-500.00'), money('100.00'))).toBe('empty');
  });
});

describe('groupSourcesByCoverage — §6.1, §7.3', () => {
  const sources: SourceOption[] = [
    accountAsSource(account()),
    accountAsSource(account({ id: 'acct-gcash', name: 'Cashier GCash', custodian: 'cashier', instrument: 'ewallet', glAccountCode: '1140', balance: '9050.00' })),
    accountAsSource(account({ id: 'acct-drawer', name: 'Cashier cash', custodian: 'cashier', glAccountCode: '1110', balance: '1200.00' })),
    accountAsSource(account({ id: 'acct-bpi', name: 'Office BPI', instrument: 'bank', glAccountCode: '1140', balance: '0.00' })),
    floatAsSource(float()),
    floatAsSource(float({ cashRequestId: 'cr-ben-448', holderName: 'Ben Reyes', outstanding: '380.00' })),
  ];

  it('⛔ hides nothing — every source appears in exactly one band', () => {
    const groups = groupSourcesByCoverage(sources, money('3500.00'));
    expect(groups.flatMap((g) => g.sources)).toHaveLength(sources.length);
  });

  it('⭐ floats sit FLAT among the accounts, labelled by person (§7.3)', () => {
    const groups = groupSourcesByCoverage(sources, money('3500.00'));
    const short = groups.find((g) => g.band === 'short')!;
    // Ana and Ben are in the same list as Cashier cash — not behind a "pick Staff float" step.
    expect(short.sources.map(labelOf)).toEqual(['Cashier cash', 'Ana Cruz', 'Ben Reyes']);
  });

  it('bands a ₱3,500 expense the way the spec draws it', () => {
    const groups = groupSourcesByCoverage(sources, money('3500.00'));
    expect(groups.map((g) => g.band)).toEqual(['covers', 'short', 'empty']);
    expect(groups[0]!.sources.map(labelOf)).toEqual(['Office cash', 'Cashier GCash']);
    expect(groups[2]!.sources.map(labelOf)).toEqual(['Office BPI']);
  });

  it('omits a band with nothing in it rather than rendering an empty heading', () => {
    const groups = groupSourcesByCoverage([accountAsSource(account())], money('10.00'));
    expect(groups.map((g) => g.band)).toEqual(['covers']);
  });

  it('re-bands as the amount grows — the list is live, not computed once', () => {
    const cheap = groupSourcesByCoverage(sources, money('100.00'));
    expect(cheap.find((g) => g.band === 'covers')!.sources.map(labelOf)).toContain('Ana Cruz');
    const dear = groupSourcesByCoverage(sources, money('100000.00'));
    expect(dear.find((g) => g.band === 'covers')).toBeUndefined();
  });

  it('keys a float by its request and an account by its id', () => {
    expect(keyOfSource(floatAsSource(float()))).toBe('float:cr-ana-447');
    expect(keyOfSource(accountAsSource(account()))).toBe('account:acct-office-cash');
  });
});

describe('validateMoneyLines', () => {
  const sources: SourceOption[] = [
    accountAsSource(account()),
    accountAsSource(account({ id: 'acct-staff-float', name: 'Staff float', custodian: 'staff', glAccountCode: '1120', balance: '1620.00' })),
    floatAsSource(float()),
  ];
  const base = { direction: 'out' as const, sources, supplierId: 'sup-1', supplierCreditTermsDays: 30 };

  const fieldsOf = (issues: ReturnType<typeof validateMoneyLines>) => issues.map((i) => i.field);

  it('accepts a plain, coherent cash line', () => {
    expect(validateMoneyLines({ ...base, lines: [line()] })).toEqual([]);
  });

  it('refuses a document with no lines at all', () => {
    expect(fieldsOf(validateMoneyLines({ ...base, lines: [] }))).toEqual(['document']);
  });

  it('⛔ refuses a staff-float account with no float named — T-266 §4, before Postgres sees it', () => {
    const issues = validateMoneyLines({
      ...base,
      lines: [line({ moneyAccountId: 'acct-staff-float' })],
    });
    expect(fieldsOf(issues)).toContain('cashRequestId');
    expect(issues[0]!.message).toMatch(/belongs to a specific person/);
  });

  it('accepts the same line once the float is named', () => {
    const issues = validateMoneyLines({
      ...base,
      lines: [line({ moneyAccountId: 'acct-staff-float', cashRequestId: 'cr-ana-447', amount: '500.00' })],
    });
    expect(issues).toEqual([]);
  });

  it('⛔ refuses a line asking a float for more than it holds — v1 does this too', () => {
    const issues = validateMoneyLines({
      ...base,
      lines: [line({ moneyAccountId: 'acct-staff-float', cashRequestId: 'cr-ana-447', amount: '2000.00' })],
    });
    expect(fieldsOf(issues)).toContain('amount');
    expect(issues[0]!.message).toMatch(/Ana Cruz's float holds/);
  });

  it('refuses a cash line naming no source', () => {
    const issues = validateMoneyLines({ ...base, lines: [line({ moneyAccountId: null })] });
    expect(fieldsOf(issues)).toContain('moneyAccountId');
  });

  it('refuses a reimbursable with nobody named', () => {
    const issues = validateMoneyLines({ ...base, lines: [{ method: 'reimbursable', amount: '650.00' }] });
    expect(fieldsOf(issues)).toContain('staffId');
  });

  it('⭐ refuses credit when the supplier has no terms set — T-266 §5', () => {
    const issues = validateMoneyLines({
      ...base,
      supplierCreditTermsDays: null,
      supplierName: 'San Miguel',
      lines: [{ method: 'credit', amount: '8000.00' }],
    });
    expect(issues[0]!.message).toBe(
      'San Miguel is cash-on-delivery. Set payment terms on the supplier to pay on credit.',
    );
  });

  it('allows credit when terms are set', () => {
    expect(validateMoneyLines({ ...base, lines: [{ method: 'credit', amount: '8000.00' }] })).toEqual([]);
  });

  it('refuses credit with no supplier at all', () => {
    const issues = validateMoneyLines({
      ...base,
      supplierId: null,
      lines: [{ method: 'credit', amount: '8000.00' }],
    });
    expect(issues[0]!.message).toMatch(/needs a supplier/);
  });

  it('⚠️ refuses a SECOND credit line — two payables the subledger cannot tell apart', () => {
    const issues = validateMoneyLines({
      ...base,
      lines: [
        { method: 'credit', amount: '4000.00' },
        { method: 'credit', amount: '4000.00' },
      ],
    });
    expect(issues.some((i) => i.message === 'Only one credit line per document.')).toBe(true);
  });

  it('⛔ refuses a method from the other direction', () => {
    const issues = validateMoneyLines({
      ...base,
      direction: 'in',
      lines: [{ method: 'reimbursable', amount: '100.00', staffId: 's1' }],
    });
    expect(fieldsOf(issues)).toContain('method');
  });

  it('refuses an unparseable and a non-positive amount', () => {
    expect(fieldsOf(validateMoneyLines({ ...base, lines: [line({ amount: '0.004' })] }))).toContain('amount');
    expect(fieldsOf(validateMoneyLines({ ...base, lines: [line({ amount: '0.00' })] }))).toContain('amount');
  });

  it('checks the lines add up to the document when a total is given', () => {
    const issues = validateMoneyLines({
      ...base,
      mustTotal: '3500.00',
      lines: [line({ amount: '2000.00' })],
    });
    expect(issues[0]!.message).toMatch(/total 2000.00 but this document is for 3500.00/);
    expect(validateMoneyLines({
      ...base,
      mustTotal: '3500.00',
      lines: [line({ amount: '2000.00' }), line({ amount: '1500.00' })],
    })).toEqual([]);
  });

  it('totalOf sums a split, skipping half-typed rows', () => {
    expect(totalOf([line({ amount: '2000.00' }), line({ amount: '' }), line({ amount: '1500.00' })]))
      .toBe(money('3500.00'));
  });
});

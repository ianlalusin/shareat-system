import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  UNSUPPORTED_CLASSES,
  convertExpense,
  convertSalesDay,
  convertSpecimen,
  type ExpenseDoc,
  type RawSpecimen,
  type SalesDayDoc,
} from '../src/convert';

function baseSalesDay(overrides: Partial<SalesDayDoc> = {}): SalesDayDoc {
  return {
    id: '2026-01-05',
    storeId: 'STORE-A',
    status: 'verified',
    totalSales: 0,
    dineInSales: 0,
    takeOutSales: 0,
    cashPayments: 0,
    onlineBreakdown: {},
    seniorDiscount: 0,
    pwdDiscount: 0,
    otherDiscount: 0,
    totalDiscounts: 0,
    comps: 0,
    ...overrides,
  };
}

function baseExpense(overrides: Partial<ExpenseDoc> = {}): ExpenseDoc {
  return {
    id: 'exp-0001',
    dayKey: '2026-01-06',
    storeId: 'STORE-A',
    totalAmount: 0,
    payments: [],
    ...overrides,
  };
}

describe('convertSalesDay — plain dine-in unlimited', () => {
  it('produces a balanced 2-line entry: Dr cash, Cr 4100', () => {
    const doc = baseSalesDay({ totalSales: 50000, dineInSales: 50000, cashPayments: 45000, onlineBreakdown: { gcash: 5000 } });
    const result = convertSalesDay('spec-1', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('converted');
    expect(result.entries).toHaveLength(1);
    const lines = result.entries[0]!.lines;
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(50000, 2);
    expect(totalCredit).toBeCloseTo(50000, 2);
    expect(lines.some((l) => l.accountCode === ACCOUNTS.CASH_CASHIER && l.debit === '45000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode === ACCOUNTS.ONLINE && l.debit === '5000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode === ACCOUNTS.FOOD_UNLI && l.credit === '50000.00')).toBe(true);
  });
});

describe('convertSalesDay — plain à la carte', () => {
  it('credits 4150, not 4100', () => {
    const doc = baseSalesDay({ totalSales: 32000, takeOutSales: 32000, cashPayments: 20000, onlineBreakdown: { gcash: 12000 } });
    const result = convertSalesDay('spec-2', 'sale.a_la_carte.plain', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.FOOD_A_LA_CARTE && l.credit === '32000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode === ACCOUNTS.FOOD_UNLI)).toBe(false);
  });
});

describe('convertSalesDay — with discount', () => {
  it('debits 4900 for the discount amount and still balances', () => {
    const doc = baseSalesDay({
      totalSales: 51000,
      dineInSales: 45000,
      takeOutSales: 6000,
      cashPayments: 40000,
      onlineBreakdown: { gcash: 10000 },
      seniorDiscount: 800,
      pwdDiscount: 200,
      totalDiscounts: 1000,
    });
    const result = convertSalesDay('spec-3', 'sale.discount', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.SALES_DISCOUNTS && l.debit === '1000.00')).toBe(true);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });
});

describe('convertSalesDay — with comps', () => {
  it('debits 4950 for the comps amount', () => {
    const doc = baseSalesDay({
      totalSales: 25000,
      dineInSales: 20000,
      takeOutSales: 5000,
      cashPayments: 22000,
      onlineBreakdown: { gcash: 2500 },
      comps: 500,
    });
    const result = convertSalesDay('spec-4', 'sale.comps', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.SALES_RETURNS_AND_VOIDS && l.debit === '500.00')).toBe(true);
  });
});

describe('convertSalesDay — voided', () => {
  it('skips with a reason instead of posting a reversing entry (void != reversal, glossary)', () => {
    const doc = baseSalesDay({ status: 'voided', totalSales: 8000, dineInSales: 8000, cashPayments: 8000 });
    const result = convertSalesDay('spec-5', 'sale.voided', doc);
    expect(result.status).toBe('skipped');
    expect(result.entries).toHaveLength(0);
    expect(result.reason).toMatch(/voided/i);
  });
});

describe('convertSalesDay — imbalance detection (T-113 §3, "never silently balance")', () => {
  it('quarantines when tender + discounts + comps != totalSales', () => {
    const doc = baseSalesDay({ totalSales: 50000, dineInSales: 50000, cashPayments: 40000 }); // 10,000 short
    const result = convertSalesDay('spec-6', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('quarantined');
    expect(result.reason).toMatch(/does not balance/);
  });

  it('quarantines when dineInSales + takeOutSales != totalSales', () => {
    const doc = baseSalesDay({ totalSales: 50000, dineInSales: 40000, takeOutSales: 5000, cashPayments: 45000 });
    const result = convertSalesDay('spec-7', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('quarantined');
  });
});

describe('convertExpense — cash (OPEX)', () => {
  it('credits cash and debits the mapped category account', () => {
    const doc = baseExpense({
      totalAmount: 15000,
      expenseEntryGroup: 'OPEX',
      category: 'Rent',
      payments: [{ method: 'cash', amount: 15000 }],
    });
    const result = convertExpense('spec-8', 'expense.cash', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.CASH_CASHIER && l.credit === '15000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode === '6200' && l.debit === '15000.00')).toBe(true);
  });
});

describe('convertExpense — AP (OPEX)', () => {
  it('credits 2110 AP instead of cash', () => {
    const doc = baseExpense({
      totalAmount: 8500,
      expenseEntryGroup: 'OPEX',
      category: 'Utilities',
      payments: [{ method: 'credit', amount: 8500 }],
    });
    const result = convertExpense('spec-9', 'expense.ap', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.AP && l.credit === '8500.00')).toBe(true);
    expect(lines.some((l) => l.accountCode === '6300' && l.debit === '8500.00')).toBe(true);
  });
});

describe('convertExpense — CAPEX produces NO P&L leg (T-113 §2.1, the naive-mapping trap)', () => {
  it('debits the asset account, never a 6xxx expense account', () => {
    const doc = baseExpense({
      totalAmount: 60000,
      expenseEntryGroup: 'CAPEX',
      category: 'Equipment',
      assetId: 'AST-001',
      payments: [{ method: 'cash', amount: 60000 }],
    });
    const result = convertExpense('spec-10', 'expense.capex', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.PROPERTY_AND_EQUIPMENT && l.debit === '60000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode.startsWith('6'))).toBe(false);
  });

  it('quarantines a CAPEX expense with no assetId rather than guessing which asset', () => {
    const doc = baseExpense({
      totalAmount: 60000,
      expenseEntryGroup: 'CAPEX',
      payments: [{ method: 'cash', amount: 60000 }],
    });
    const result = convertExpense('spec-10b', 'expense.capex', doc);
    expect(result.status).toBe('quarantined');
  });
});

describe('convertExpense — PERSONAL routes to owner\'s drawings, never an expense account', () => {
  it('debits 3200, not a 6xxx account', () => {
    const doc = baseExpense({
      totalAmount: 5000,
      expenseEntryGroup: 'PERSONAL',
      payments: [{ method: 'cash', amount: 5000 }],
    });
    const result = convertExpense('spec-11', 'expense.personal', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.OWNERS_DRAWINGS && l.debit === '5000.00')).toBe(true);
    expect(lines.some((l) => l.accountCode.startsWith('6'))).toBe(false);
  });
});

describe('convertExpense — never guesses an unmapped category', () => {
  it('quarantines rather than falling back to 6900', () => {
    const doc = baseExpense({
      totalAmount: 1000,
      expenseEntryGroup: 'OPEX',
      category: 'Some Category Not In The Map',
      payments: [{ method: 'cash', amount: 1000 }],
    });
    const result = convertExpense('spec-12', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
    // No line was ever produced at all (the entry never got built past classification) —
    // this is the actual guarantee. The reason text is free to NAME "6900" while
    // explaining the rule ("never falls back to 6900"); that is not the same as posting
    // to it, so asserting on entries (not on the prose) is the correct check here.
    expect(result.entries).toHaveLength(0);
  });

  it('quarantines an unmapped payment method rather than guessing', () => {
    const doc = baseExpense({
      totalAmount: 1000,
      expenseEntryGroup: 'OPEX',
      category: 'Rent',
      payments: [{ method: 'other', amount: 1000, otherType: 'voucher' }],
    });
    const result = convertExpense('spec-13', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
  });

  it('quarantines when sum(payments) != totalAmount — an inconsistent source document', () => {
    const doc = baseExpense({
      totalAmount: 1000,
      expenseEntryGroup: 'OPEX',
      category: 'Rent',
      payments: [{ method: 'cash', amount: 900 }],
    });
    const result = convertExpense('spec-14', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
  });

  it('quarantines COGS — the two-stage inventory posting is not implemented here', () => {
    const doc = baseExpense({
      totalAmount: 1000,
      expenseEntryGroup: 'COGS',
      category: 'Meat',
      payments: [{ method: 'cash', amount: 1000 }],
    });
    const result = convertExpense('spec-15', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
  });
});

describe('convertSpecimen — dispatch and the unsupported-class gate', () => {
  it('quarantines any case class in UNSUPPORTED_CLASSES by name, regardless of kind', () => {
    expect(UNSUPPORTED_CLASSES.has('ticket.cancelled')).toBe(true);
    const raw: RawSpecimen = {
      specimenId: 'spec-16',
      caseClass: 'ticket.cancelled',
      kind: 'salesDay',
      storeCode: 'STORE-A',
      doc: baseSalesDay(),
    };
    const result = convertSpecimen(raw);
    expect(result.status).toBe('quarantined');
    expect(result.reason).toMatch(/no defined conversion rule/);
  });

  it('dispatches a supported salesDay specimen to convertSalesDay', () => {
    const raw: RawSpecimen = {
      specimenId: 'spec-17',
      caseClass: 'sale.dine_in_unli.plain',
      kind: 'salesDay',
      storeCode: 'STORE-A',
      doc: baseSalesDay({ totalSales: 100, dineInSales: 100, cashPayments: 100 }),
    };
    expect(convertSpecimen(raw).status).toBe('converted');
  });

  it('dispatches a supported expense specimen to convertExpense', () => {
    const raw: RawSpecimen = {
      specimenId: 'spec-18',
      caseClass: 'expense.cash',
      kind: 'expense',
      storeCode: 'STORE-A',
      doc: baseExpense({ totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Rent', payments: [{ method: 'cash', amount: 100 }] }),
    };
    expect(convertSpecimen(raw).status).toBe('converted');
  });
});

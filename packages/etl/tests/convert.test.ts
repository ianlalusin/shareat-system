import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  REASON_CODES,
  UNSUPPORTED_CLASSES,
  convertExpense,
  convertSalesDay,
  convertSpecimen,
  type ExpenseDoc,
  type RawSpecimen,
  type ReasonCode,
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
  it('credits 2110 AP instead of cash, and carries the supplier as the subledger party', () => {
    const doc = baseExpense({
      totalAmount: 8500,
      expenseEntryGroup: 'OPEX',
      category: 'Utilities',
      supplierId: 'SUP-0450',
      payments: [{ method: 'credit', amount: 8500 }],
    });
    const result = convertExpense('spec-9', 'expense.ap', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    const ap = lines.find((l) => l.accountCode === ACCOUNTS.AP);
    expect(ap?.credit).toBe('8500.00');
    // T-118: 2110 is a control account. Without the party the subledger cannot be
    // reconstructed and the database rejects the line outright.
    expect(ap?.partyType).toBe('supplier');
    expect(ap?.partyId).toBe('SUP-0450');
    expect(lines.some((l) => l.accountCode === '6300' && l.debit === '8500.00')).toBe(true);
  });

  it('QUARANTINES an AP expense with no supplierId rather than posting an unattributable control line', () => {
    // The alternative — posting to 2110 with a null party — is what the database now
    // refuses, and refusing here gives the ETL a named reason instead of a constraint error.
    const doc = baseExpense({
      totalAmount: 8500,
      expenseEntryGroup: 'OPEX',
      category: 'Utilities',
      payments: [{ method: 'credit', amount: 8500 }],
    });
    const result = convertExpense('spec-9b', 'expense.ap', doc);
    expect(result.status).toBe('quarantined');
    expect(JSON.stringify(result)).toMatch(/supplierId/);
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

// =============================================================================================
// T-113 "Scope — implementation" — widening OPEX_CATEGORY_ACCOUNTS to the full COA-ALIGNMENT
// §4.2 crosswalk (leg-mapping.ts), plus the additional Tests 7–9 and invariants named there.
// =============================================================================================

describe('convertExpense — widened OPEX map (leg-mapping.ts, COA-ALIGNMENT §4.2 in full)', () => {
  it('converts a category T-117\'s original 2-entry map did not have (Insurance -> 6880)', () => {
    const doc = baseExpense({
      totalAmount: 3000,
      expenseEntryGroup: 'OPEX',
      category: 'Insurance',
      payments: [{ method: 'cash', amount: 3000 }],
    });
    const result = convertExpense('spec-19', 'expense.cash', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === '6880' && l.debit === '3000.00')).toBe(true);
  });

  it('"Uncategorized Expenses" converts to 6900 — an EXPLICIT, named mapping, not the forbidden fallback', () => {
    // T-113 §3 rule 1 forbids defaulting an UNMAPPED category to 6900. "Uncategorized
    // Expenses" is itself a real v1 category name that COA-ALIGNMENT §4.2 explicitly maps
    // to 6900 — a deliberate entry in the map, not a category falling through to one.
    const doc = baseExpense({
      totalAmount: 750,
      expenseEntryGroup: 'OPEX',
      category: 'Uncategorized Expenses',
      payments: [{ method: 'cash', amount: 750 }],
    });
    const result = convertExpense('spec-20', 'expense.cash', doc);
    expect(result.status).toBe('converted');
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === '6900' && l.debit === '750.00')).toBe(true);
  });

  it('a category genuinely absent from the map still quarantines — widening the map did not loosen the rule', () => {
    const doc = baseExpense({
      totalAmount: 1000,
      expenseEntryGroup: 'OPEX',
      category: 'Definitely Not A Real Category',
      payments: [{ method: 'cash', amount: 1000 }],
    });
    const result = convertExpense('spec-21', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
    expect(result.entries).toHaveLength(0);
  });

  it('the Maintenance / Repairs and Maintenance merge (§4.5) both land on 6600', () => {
    const a = convertExpense('spec-22a', 'expense.cash', baseExpense({
      totalAmount: 500, expenseEntryGroup: 'OPEX', category: 'Maintenance', payments: [{ method: 'cash', amount: 500 }],
    }));
    const b = convertExpense('spec-22b', 'expense.cash', baseExpense({
      totalAmount: 500, expenseEntryGroup: 'OPEX', category: 'Repairs and Maintenance', payments: [{ method: 'cash', amount: 500 }],
    }));
    expect(a.entries[0]!.lines.some((l) => l.accountCode === '6600')).toBe(true);
    expect(b.entries[0]!.lines.some((l) => l.accountCode === '6600')).toBe(true);
  });
});

describe('Test 7 (corrected) — a sale day with dineInSales > 0 converts cleanly, it does NOT quarantine', () => {
  // T-113 §4 Test 7, as literally written, says the opposite: "A sale day with
  // dineInSales > 0 quarantines under the §6.1 rule until Ian decides." That instruction
  // was written before §6 (Ian's review, same document) resolved §6.1 — "dineInSales
  // already IS the unli figure... 4100 needs no reconstruction at all." Implementing Test 7
  // literally would make every dine-in-unli sales day permanently unconvertible, which
  // directly contradicts §6.1 and the very first test in this file ("plain dine-in
  // unlimited"). This is a SPEC DEFECT (Test 7 is stale, superseded by §6.1) reported here
  // rather than silently worked around — see convert.ts's comment above convertSalesDay.
  it('is the corrected behaviour, locked in as a regression guard', () => {
    const doc = baseSalesDay({ totalSales: 12000, dineInSales: 12000, cashPayments: 12000 });
    const result = convertSalesDay('spec-23', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('converted');
    expect(result.reason).toBeNull();
    const lines = result.entries[0]!.lines;
    expect(lines.some((l) => l.accountCode === ACCOUNTS.FOOD_UNLI && l.credit === '12000.00')).toBe(true);
  });
});

describe('Test 8 — re-running Stage 1 twice produces byte-identical output', () => {
  it('convertSalesDay is idempotent', () => {
    const doc = baseSalesDay({
      totalSales: 40000,
      dineInSales: 30000,
      takeOutSales: 10000,
      cashPayments: 35000,
      onlineBreakdown: { gcash: 4000 },
      seniorDiscount: 1000,
      totalDiscounts: 1000,
    });
    const first = convertSalesDay('spec-24', 'sale.discount', doc);
    const second = convertSalesDay('spec-24', 'sale.discount', doc);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('convertExpense is idempotent', () => {
    const doc = baseExpense({
      totalAmount: 2200,
      expenseEntryGroup: 'OPEX',
      category: 'Bank Fees',
      payments: [{ method: 'cash', amount: 2200 }],
    });
    const first = convertExpense('spec-25', 'expense.cash', doc);
    const second = convertExpense('spec-25', 'expense.cash', doc);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('Test 9 — a synthetic unbalanced group is classified quarantined (❌), never silently balanced', () => {
  it('a sales day with an arbitrary, made-up imbalance quarantines with a residual, not a fabricated balance', () => {
    const doc = baseSalesDay({
      totalSales: 77777,
      dineInSales: 77777,
      cashPayments: 11111, // nowhere near totalSales — synthetic, deliberately unbalanced
    });
    const result = convertSalesDay('spec-26', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('quarantined');
    expect(result.entries).toHaveLength(0);
    expect(result.reason).toMatch(/does not balance/);
    expect(result.reason).toMatch(/residual/);
  });

  it('an expense with a synthetic payments/totalAmount mismatch quarantines, not balances', () => {
    const doc = baseExpense({
      totalAmount: 99999,
      expenseEntryGroup: 'OPEX',
      category: 'Rent',
      payments: [{ method: 'cash', amount: 1 }], // synthetic, deliberately unbalanced
    });
    const result = convertExpense('spec-27', 'expense.cash', doc);
    expect(result.status).toBe('quarantined');
    expect(result.entries).toHaveLength(0);
  });
});

// =============================================================================================
// DEF-042 — every quarantine carries a `reasonCode` from the closed union (T-114b Contract §1).
// Invariants 14/15: GROUP BY reason_code returns usable counts; no code is ever derived by
// pattern-matching `reason`'s free text. Proved here by asserting each ACTUAL branch produces
// the reasonCode assigned to it explicitly in convert.ts, not by inspecting the prose.
// =============================================================================================

describe('DEF-042 — reasonCode on every quarantined result', () => {
  it('a converted result carries NO reasonCode key at all (not even null) — replay.test.ts relies on this', () => {
    const doc = baseSalesDay({ totalSales: 100, dineInSales: 100, cashPayments: 100 });
    const result = convertSalesDay('spec-rc-0a', 'sale.dine_in_unli.plain', doc);
    expect(result.status).toBe('converted');
    expect('reasonCode' in result).toBe(false);
  });

  it('a skipped result (voided sales day) carries NO reasonCode key either', () => {
    const doc = baseSalesDay({ status: 'voided', totalSales: 1, dineInSales: 1, cashPayments: 1 });
    const result = convertSalesDay('spec-rc-0b', 'sale.voided', doc);
    expect(result.status).toBe('skipped');
    expect('reasonCode' in result).toBe(false);
  });

  const cases: Array<{ label: string; expected: ReasonCode; run: () => { status: string; reasonCode?: ReasonCode } }> = [
    {
      label: 'sales day tender != totalSales',
      expected: 'unbalanced_source_group',
      run: () => convertSalesDay('rc-1', 'sale.dine_in_unli.plain', baseSalesDay({ totalSales: 100, dineInSales: 100, cashPayments: 1 })),
    },
    {
      label: 'sales day dineInSales + takeOutSales != totalSales',
      expected: 'unbalanced_source_group',
      run: () => convertSalesDay('rc-2', 'sale.dine_in_unli.plain', baseSalesDay({ totalSales: 100, dineInSales: 1, cashPayments: 100 })),
    },
    {
      label: 'expense with zero payment splits',
      expected: 'unbalanced_source_group',
      run: () => convertExpense('rc-3', 'expense.cash', baseExpense({ totalAmount: 0, payments: [] })),
    },
    {
      label: 'expense sum(payments) != totalAmount',
      expected: 'unbalanced_source_group',
      run: () => convertExpense('rc-4', 'expense.cash', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Rent', payments: [{ method: 'cash', amount: 1 }],
      })),
    },
    {
      label: 'AP payment missing supplierId',
      expected: 'missing_supplier_party',
      run: () => convertExpense('rc-5', 'expense.ap', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Utilities', payments: [{ method: 'credit', amount: 100 }],
      })),
    },
    {
      label: 'reimbursable payment missing staffId',
      expected: 'missing_supplier_party',
      run: () => convertExpense('rc-6', 'expense.cash', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Rent', payments: [{ method: 'reimbursable', amount: 100 }],
      })),
    },
    {
      label: 'unimplemented payment method',
      expected: 'unimplemented_payment_method',
      run: () => convertExpense('rc-7', 'expense.cash', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Rent', payments: [{ method: 'other', amount: 100 }],
      })),
    },
    {
      label: 'CAPEX missing assetId',
      expected: 'missing_source_document',
      run: () => convertExpense('rc-8', 'expense.capex', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'CAPEX', payments: [{ method: 'cash', amount: 100 }],
      })),
    },
    {
      label: 'unmapped OPEX category',
      expected: 'unmapped_expense_category',
      run: () => convertExpense('rc-9', 'expense.cash', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'OPEX', category: 'Not A Real Category', payments: [{ method: 'cash', amount: 100 }],
      })),
    },
    {
      label: 'COGS group has no converter rule',
      expected: 'unsupported_case_class',
      run: () => convertExpense('rc-10', 'expense.cash', baseExpense({
        totalAmount: 100, expenseEntryGroup: 'COGS', category: 'Meat', payments: [{ method: 'cash', amount: 100 }],
      })),
    },
    {
      label: 'a case class in UNSUPPORTED_CLASSES',
      expected: 'unsupported_case_class',
      run: () => convertSpecimen({
        specimenId: 'rc-11', caseClass: 'ticket.cancelled', kind: 'salesDay', storeCode: 'STORE-A', doc: baseSalesDay(),
      }),
    },
  ];

  for (const { label, expected, run } of cases) {
    it(`${label} -> reasonCode '${expected}'`, () => {
      const result = run();
      expect(result.status).toBe('quarantined');
      expect(result.reasonCode).toBe(expected);
      // Invariant 14 — the code is a member of the closed union, always.
      expect(REASON_CODES).toContain(result.reasonCode);
    });
  }

  it('invariant 14 — GROUP BY reason_code (a plain reduce, no database) returns usable counts', () => {
    const results = cases.map((c) => c.run());
    const counts = new Map<string, number>();
    for (const r of results) {
      const code = (r as { reasonCode?: ReasonCode }).reasonCode!;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    expect(counts.get('unbalanced_source_group')).toBe(4);
    expect(counts.get('missing_supplier_party')).toBe(2);
    expect(counts.get('unimplemented_payment_method')).toBe(1);
    expect(counts.get('missing_source_document')).toBe(1);
    expect(counts.get('unmapped_expense_category')).toBe(1);
    expect(counts.get('unsupported_case_class')).toBe(2);
  });
});

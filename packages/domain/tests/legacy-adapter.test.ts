import { describe, expect, it } from 'vitest';

/**
 * Proves invariants 1-17 of docs/tasks/107-legacy-leg-adapter.md — pure unit tests, NO
 * database (Contract §1: "No SQL, no imports from @shareat/db"). Invariants 18-19 (does
 * the output actually post, and does a single-leg group get rejected at COMMIT) live in
 * tests/integration/legacy-adapter.test.ts against a real Postgres.
 *
 * `resolve` is always a synthetic in-memory function here — the real account lookup
 * (T-113's mapping) is explicitly out of scope for this task; adaptLegacyLegs takes it
 * injected so this file never needs a database or a real chart of accounts.
 */
import { adaptLegacyLegs, type Finding, type ResolvedAccount } from '../src/ledger/legacy-adapter';

// ---------------------------------------------------------------------------------------
// Fixtures — a small in-memory "resolver" standing in for T-113's real mapping.
// ---------------------------------------------------------------------------------------

const ACCOUNTS: Record<string, ResolvedAccount> = {
  // Debit-normal cash account. v1 prefix `cash__` falls into "everything else" ⇒ debit.
  // Agrees with v2's declared normal_balance ⇒ invariant 12 (no finding).
  cash__cashier: { code: '1110', normalBalance: 'debit', isPostable: true, status: 'active' },
  // Credit-normal AP account. v1 prefix `ap__` ⇒ credit. Agrees with v2 ⇒ invariant 13.
  ap__SUP1: { code: '2110', normalBalance: 'credit', isPostable: true, status: 'active' },
  // A non-postable HEADER account — invariant 8.
  header__assets: { code: '1000', normalBalance: 'debit', isPostable: false, status: 'active' },
  // A RESERVED leaf account that still resolves and adapts fine — invariant 11.
  liability__reserved_thing: {
    code: '2145',
    normalBalance: 'credit',
    isPostable: true,
    status: 'reserved',
  },
  // An ARCHIVED leaf account — also invariant 11.
  cash__old_drawer: { code: '1199', normalBalance: 'debit', isPostable: true, status: 'archived' },
  // The disagreement case — invariant 14/15. Owner's drawings (v2 account 3200) is
  // DEBIT-normal (contra-equity, bible §13 row 39 / T-102's corrected exception). A v1
  // account for the same concept would naturally have carried the `equity__` prefix
  // (equity is its literal domain), and account-defs.ts:19-43 buckets EVERY `equity__*`
  // prefix as credit with no drawings-specific carve-out. Reproducing that table exactly
  // (Contract §4) therefore disagrees with v2's declared (correct) polarity here — this
  // is precisely the kind of silent-for-years mismatch §4 exists to surface.
  equity__owner_drawings: { code: '3200', normalBalance: 'debit', isPostable: true, status: 'active' },
};

function resolve(accountId: string): ResolvedAccount | null {
  return ACCOUNTS[accountId] ?? null;
}

function findingsOfType(findings: Finding[], type: Finding['type']): Finding[] {
  return findings.filter((f) => f.type === type);
}

// =========================================================================================
// Translation (1-6)
// =========================================================================================

describe('invariant 1 — in + debit-normal -> debit; credit side zero', () => {
  it('writes the amount on the debit side', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'in', amount: 100 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.debit).toBe('100.00');
    expect(result.lines[0]!.credit).toBe('0.00');
  });
});

describe('invariant 2 — in + credit-normal -> credit', () => {
  it('writes the amount on the credit side', () => {
    const result = adaptLegacyLegs([{ accountId: 'ap__SUP1', direction: 'in', amount: 50 }], resolve);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines[0]!.credit).toBe('50.00');
    expect(result.lines[0]!.debit).toBe('0.00');
  });
});

describe('invariant 3 — out + debit-normal -> credit', () => {
  it('flips a debit-normal decrease onto the credit side', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'out', amount: 30 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines[0]!.credit).toBe('30.00');
    expect(result.lines[0]!.debit).toBe('0.00');
  });
});

describe('invariant 4 — out + credit-normal -> debit', () => {
  it('flips a credit-normal decrease onto the debit side', () => {
    const result = adaptLegacyLegs([{ accountId: 'ap__SUP1', direction: 'out', amount: 20 }], resolve);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines[0]!.debit).toBe('20.00');
    expect(result.lines[0]!.credit).toBe('0.00');
  });
});

describe('invariant 5 — a multi-leg group translates every leg independently, preserving order and legKey', () => {
  it('keeps legs in input order with their legKey attached', () => {
    const result = adaptLegacyLegs(
      [
        { accountId: 'cash__cashier', direction: 'in', amount: 10, legKey: 'leg-a' },
        { accountId: 'ap__SUP1', direction: 'in', amount: 10, legKey: 'leg-b' },
      ],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.legKey).toBe('leg-a');
    expect(result.lines[0]!.accountCode).toBe('1110');
    expect(result.lines[1]!.legKey).toBe('leg-b');
    expect(result.lines[1]!.accountCode).toBe('2110');
  });
});

describe('invariant 6 — amounts emerge as strings, exact to the centavo', () => {
  it('the debit/credit fields are strings, not numbers', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'in', amount: 12.3 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(typeof result.lines[0]!.debit).toBe('string');
    expect(result.lines[0]!.debit).toBe('12.30');
  });
});

// =========================================================================================
// Classification, not exceptions (7-11)
// =========================================================================================

describe('invariant 7 — an unresolvable accountId -> ok:false naming the id, never throws', () => {
  it('reports the bad id instead of throwing', () => {
    let result;
    expect(() => {
      result = adaptLegacyLegs([{ accountId: 'nope__does_not_exist', direction: 'in', amount: 10 }], resolve);
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (result!.ok) throw new Error('expected ok:false');
    expect(result!.reason).toContain('nope__does_not_exist');
  });
});

describe('invariant 8 — a non-postable (header) target -> ok:false, never throws', () => {
  it('rejects posting to a header account', () => {
    let result;
    expect(() => {
      result = adaptLegacyLegs([{ accountId: 'header__assets', direction: 'in', amount: 10 }], resolve);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
  });
});

describe('invariant 9 — a zero or negative amount -> ok:false, never throws', () => {
  it.each([0, -5, -0.01])('rejects amount %s', (amount) => {
    let result;
    expect(() => {
      result = adaptLegacyLegs([{ accountId: 'cash__cashier', direction: 'in', amount }], resolve);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
  });
});

describe('invariant 10 — an empty leg array -> ok:false, never throws', () => {
  it('rejects with no legs to classify', () => {
    let result;
    expect(() => {
      result = adaptLegacyLegs([], resolve);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
  });
});

describe('invariant 11 — a reserved or archived account resolves and adapts fine', () => {
  it('does not police status for a reserved account', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'liability__reserved_thing', direction: 'in', amount: 10 }],
      resolve,
    );
    expect(result.ok).toBe(true);
  });

  it('does not police status for an archived account', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__old_drawer', direction: 'in', amount: 10 }],
      resolve,
    );
    expect(result.ok).toBe(true);
  });
});

// =========================================================================================
// The disagreement check — §4 (12-15)
// =========================================================================================

describe('invariant 12 — cash__cashier: v1 prefix debit, v2 1110 debit-normal -> no finding', () => {
  it('emits zero polarity_disagreement findings', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'in', amount: 10 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    expect(findingsOfType(result.findings, 'polarity_disagreement')).toHaveLength(0);
  });
});

describe('invariant 13 — ap__SUP1: v1 prefix credit, v2 2110 credit-normal -> no finding', () => {
  it('emits zero polarity_disagreement findings', () => {
    const result = adaptLegacyLegs([{ accountId: 'ap__SUP1', direction: 'in', amount: 10 }], resolve);
    expect(result.ok).toBe(true);
    expect(findingsOfType(result.findings, 'polarity_disagreement')).toHaveLength(0);
  });
});

describe('invariant 14 — a disagreeing account emits a finding naming both polarities, and the line is written using v2\'s', () => {
  it('equity__owner_drawings: v1 prefix says credit, v2 3200 says debit', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'equity__owner_drawings', direction: 'in', amount: 500 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');

    const disagreements = findingsOfType(result.findings, 'polarity_disagreement');
    expect(disagreements).toHaveLength(1);
    const finding = disagreements[0]!;
    if (finding.type !== 'polarity_disagreement') throw new Error('wrong finding type');
    expect(finding.accountId).toBe('equity__owner_drawings');
    expect(finding.v1Polarity).toBe('credit');
    expect(finding.v2Polarity).toBe('debit');

    // Always written using v2's polarity — debit here, never credit.
    expect(result.lines[0]!.debit).toBe('500.00');
    expect(result.lines[0]!.credit).toBe('0.00');
  });
});

describe('invariant 15 — findings never prevent ok:true', () => {
  it('a group with a polarity disagreement still adapts as ok:true', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'equity__owner_drawings', direction: 'in', amount: 500 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

// =========================================================================================
// Money (16-17)
// =========================================================================================

describe('invariant 16 — a float carrying more than two decimals emits a finding and is not silently rounded', () => {
  it('records a precision_loss finding and still emits a rounded 2dp amount', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'in', amount: 1.129 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');

    const precisionFindings = findingsOfType(result.findings, 'precision_loss');
    expect(precisionFindings).toHaveLength(1);
    const finding = precisionFindings[0]!;
    if (finding.type !== 'precision_loss') throw new Error('wrong finding type');
    expect(finding.accountId).toBe('cash__cashier');
    expect(finding.roundedAmount).toBe('1.13');

    expect(result.lines[0]!.debit).toBe('1.13');
  });
});

describe('invariant 17 — 0.1 + 0.2 style legacy values round-trip to exactly 0.30', () => {
  it('no precision_loss finding for float noise below the centavo', () => {
    const result = adaptLegacyLegs(
      [{ accountId: 'cash__cashier', direction: 'in', amount: 0.1 + 0.2 }],
      resolve,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.lines[0]!.debit).toBe('0.30');
    expect(findingsOfType(result.findings, 'precision_loss')).toHaveLength(0);
  });
});

// =========================================================================================
// Extra coverage beyond the 19 named invariants — "never throw" robustness for genuinely
// unparseable legacy data (not itself one of the 19, but the same "classify, don't crash"
// rule the spec states applies to "bad legacy data" generally).
// =========================================================================================

describe('extra — an unparseable amount string is classified, not thrown', () => {
  it('ok:false, naming the bad value', () => {
    let result;
    expect(() => {
      result = adaptLegacyLegs(
        [{ accountId: 'cash__cashier', direction: 'in', amount: 'not-a-number' }],
        resolve,
      );
    }).not.toThrow();
    expect(result!.ok).toBe(false);
  });
});

describe('extra — no balance pre-check: an unbalanced multi-leg group still adapts as ok:true', () => {
  it('adaptLegacyLegs does not judge whether the group balances', () => {
    const result = adaptLegacyLegs(
      [
        { accountId: 'cash__cashier', direction: 'in', amount: 100 },
        { accountId: 'ap__SUP1', direction: 'in', amount: 1 }, // deliberately does not balance
      ],
      resolve,
    );
    expect(result.ok).toBe(true);
  });
});

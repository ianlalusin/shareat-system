import { describe, expect, it } from 'vitest';
import {
  pseudonymAddress,
  pseudonymEmail,
  pseudonymId,
  pseudonymName,
  pseudonymPhone,
  redactDocument,
} from '../src/pseudonymise';

const SALT = 'test-salt-do-not-reuse-in-any-real-corpus';
const OTHER_SALT = 'a-different-salt';

describe('invariant 3 — pseudonymisation is deterministic', () => {
  it('the same phone yields the same pseudonym on repeated calls', () => {
    const a = pseudonymPhone('0917-123-4567', SALT);
    const b = pseudonymPhone('0917-123-4567', SALT);
    expect(a).toBe(b);
  });

  it('the same name/email/address are each deterministic', () => {
    expect(pseudonymName('Juan Dela Cruz', SALT)).toBe(pseudonymName('Juan Dela Cruz', SALT));
    expect(pseudonymEmail('juan@example.com', SALT)).toBe(pseudonymEmail('juan@example.com', SALT));
    expect(pseudonymAddress('123 Rizal St, Batangas', SALT)).toBe(
      pseudonymAddress('123 Rizal St, Batangas', SALT),
    );
  });

  it('the same (rawId, kind) pair yields the same synthetic id', () => {
    expect(pseudonymId('staff-042', 'staffId', SALT)).toBe(pseudonymId('staff-042', 'staffId', SALT));
  });
});

describe('invariant 4 — pseudonymisation preserves collisions', () => {
  it('two records with the identical raw phone value share one pseudonym', () => {
    const receiptA = pseudonymPhone('09171234567', SALT);
    const receiptB = pseudonymPhone('09171234567', SALT);
    expect(receiptA).toBe(receiptB);
  });

  it('cosmetic formatting differences on the same digits still collide (dashes/spaces are not signal)', () => {
    const dashed = pseudonymPhone('0917-123-4567', SALT);
    const spaced = pseudonymPhone('0917 123 4567', SALT);
    const plain = pseudonymPhone('09171234567', SALT);
    expect(dashed).toBe(spaced);
    expect(dashed).toBe(plain);
  });

  it('two DIFFERENT phones do not collide (sanity check against a degenerate always-equal implementation)', () => {
    expect(pseudonymPhone('09171234567', SALT)).not.toBe(pseudonymPhone('09179876543', SALT));
  });

  it('the same raw id used for the SAME entity kind collides across two documents', () => {
    const inExpenseA = pseudonymId('SUP-001', 'supplierId', SALT);
    const inExpenseB = pseudonymId('SUP-001', 'supplierId', SALT);
    expect(inExpenseA).toBe(inExpenseB);
  });

  it('the same raw string used for DIFFERENT entity kinds does NOT collapse onto one identity (relationships preserved, not merged)', () => {
    const asSupplier = pseudonymId('X-001', 'supplierId', SALT);
    const asStaff = pseudonymId('X-001', 'staffId', SALT);
    expect(asSupplier).not.toBe(asStaff);
  });

  it('redactDocument gives two expense docs sharing a raw staffId the same synthetic staffId', () => {
    const docA = { id: 'exp-1', payments: [{ staffId: 'STF-777', staffName: 'Ana Reyes', amount: 100 }] };
    const docB = { id: 'exp-2', payments: [{ staffId: 'STF-777', staffName: 'Ana Reyes', amount: 250 }] };
    const outA = redactDocument('expense', docA as never, SALT) as typeof docA;
    const outB = redactDocument('expense', docB as never, SALT) as typeof docB;
    expect(outA.payments[0]!.staffId).toBe(outB.payments[0]!.staffId);
    expect(outA.payments[0]!.staffName).toBe(outB.payments[0]!.staffName);
  });
});

describe('invariant 5 — amounts, quantities, timestamps and statuses survive byte-identical', () => {
  it('redactDocument(salesDay) leaves every non-PII field exactly as given', () => {
    const raw = {
      id: '2026-01-15',
      storeId: 'STORE-A',
      status: 'verified',
      totalSales: 51000.0,
      dineInSales: 45000,
      takeOutSales: 6000,
      cashPayments: 40000,
      seniorDiscount: 800,
      pwdDiscount: 200,
      otherDiscount: 0,
      totalDiscounts: 1000,
      comps: 0,
      submittedByName: 'Maria Santos',
    };
    const out = redactDocument('salesDay', raw, SALT) as typeof raw;
    expect(out.id).toBe(raw.id);
    expect(out.storeId).toBe(raw.storeId);
    expect(out.status).toBe(raw.status);
    expect(out.totalSales).toBe(raw.totalSales);
    expect(out.dineInSales).toBe(raw.dineInSales);
    expect(out.takeOutSales).toBe(raw.takeOutSales);
    expect(out.cashPayments).toBe(raw.cashPayments);
    expect(out.seniorDiscount).toBe(raw.seniorDiscount);
    expect(out.pwdDiscount).toBe(raw.pwdDiscount);
    expect(out.otherDiscount).toBe(raw.otherDiscount);
    expect(out.totalDiscounts).toBe(raw.totalDiscounts);
    expect(out.comps).toBe(raw.comps);
  });

  it('does not mutate the input object', () => {
    const raw = { id: '2026-01-15', totalSales: 100, submittedByName: 'Pedro Cruz' };
    const clone = JSON.parse(JSON.stringify(raw));
    redactDocument('salesDay', raw, SALT);
    expect(raw).toEqual(clone);
  });
});

describe('invariant 6 — no raw PII survives into the redacted output', () => {
  it('a raw name is not present anywhere in the redacted salesDay doc', () => {
    const raw = { id: '2026-01-15', totalSales: 100, submittedByName: 'Pedro Cruz', submittedByUid: 'uid-abc-123' };
    const out = redactDocument('salesDay', raw, SALT) as typeof raw;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Pedro Cruz');
    expect(serialized).not.toContain('uid-abc-123');
  });

  it('a raw supplier/staff name and id are not present anywhere in the redacted expense doc', () => {
    const raw = {
      id: 'exp-1',
      totalAmount: 100,
      supplierId: 'SUP-999',
      supplierName: 'Golden Grocers Inc.',
      staffName: 'Liza Fernandez',
      createdByUid: 'uid-real-000',
      payments: [{ method: 'cash', amount: 100, staffId: 'STF-1', staffName: 'Liza Fernandez' }],
    };
    const out = redactDocument('expense', raw, SALT) as typeof raw;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Golden Grocers Inc.');
    expect(serialized).not.toContain('Liza Fernandez');
    expect(serialized).not.toContain('uid-real-000');
    expect(serialized).not.toContain('SUP-999');
    expect(serialized).not.toContain('STF-1');
  });

  it('throws for an unregistered doc kind rather than passing it through unredacted', () => {
    expect(() => redactDocument('unknown-kind' as never, { name: 'Real Name' }, SALT)).toThrow(
      /No redaction rules registered/,
    );
  });
});

describe('the salt actually matters', () => {
  it('a different salt produces a different pseudonym for the same raw value', () => {
    expect(pseudonymPhone('09171234567', SALT)).not.toBe(pseudonymPhone('09171234567', OTHER_SALT));
    expect(pseudonymName('Juan Dela Cruz', SALT)).not.toBe(pseudonymName('Juan Dela Cruz', OTHER_SALT));
  });
});

describe('synthetic values do not look like the raw input', () => {
  it('pseudonymName never returns the raw name back', () => {
    expect(pseudonymName('Juan Dela Cruz', SALT)).not.toBe('Juan Dela Cruz');
  });

  it('pseudonymEmail always lands on the .invalid TLD (RFC 2606 — can never resolve)', () => {
    expect(pseudonymEmail('real@customer.com', SALT)).toMatch(/@example\.invalid$/);
  });
});

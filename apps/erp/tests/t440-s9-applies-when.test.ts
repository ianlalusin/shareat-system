/**
 * T-440 S9e part B (TESTER) - a rule that applies only when a sibling field has a given value ("Days to pay" only when
 * Payment terms = On credit). Spec: docs/tasks/440-live-field-checks.md, section "B. Smoke". Node, no database, no jsdom.
 *
 * Contract pinned (read from the spec): `FieldRule.when?: { field; equals: readonly string[]; says }`; `checkAll` skips a rule
 * that does not apply (value null); an ABSENT controlling field means the rule applies (fail closed); `defineFieldRules` refuses
 * `when.field === rule name` and an empty `equals`; `nativeAttrs` never emits `required` for a `when` rule.
 *
 * MUTANTS: `when` ignored (B1); `equals` inverted (B2); rule left optional (B2); absent controlling field read as "skip" (B3);
 * self-reference / empty equals accepted (B4); `required` emitted for a `when` rule (B5); the add form marks the days box
 * required, or the edit form disables it for a credit supplier (B6).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SUPPLIER_ADD_RULES, checkAll, checkField, defineFieldRules, nativeAttrs } from '../../../packages/domain/src/field-rules';
import type { FieldRule } from '../../../packages/domain/src/field-rules';

type When = { field: string; equals: readonly string[]; says: string };
const days = SUPPLIER_ADD_RULES.creditTermsDays as FieldRule & { when?: When };
/** The same rule with the "applies when" and optional switches removed: what it says when it DOES apply. */
const whenApplies = { ...days, optional: undefined, when: undefined } as unknown as FieldRule;
const sentence = (raw: string): string => {
  const c = checkField(whenApplies, raw);
  if (c.ok) throw new Error(`rule accepted ${JSON.stringify(raw)}`);
  return c.requirement;
};
const base = { name: 'Acme Meats' };

describe('B0 - the rule carries a `when` on termsMode = credit (mutant: rule not given a `when`)', () => {
  it('when is { field: termsMode, equals: [credit] } and the rule is no longer optional', () => {
    expect(days.when, 'creditTermsDays has no `when`').toBeDefined();
    expect(days.when!.field).toBe('termsMode');
    expect([...days.when!.equals]).toEqual(['credit']);
    expect(days.when!.says).toBe('Not needed for Cash on delivery');
    expect(days.optional).toBeUndefined();
  });
});

describe('B1 - COD + "abc" is ok with a null value (mutant: `when` ignored)', () => {
  it('termsMode=cod, creditTermsDays=abc -> ok, creditTermsDays null', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, termsMode: 'cod', creditTermsDays: 'abc' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.values.creditTermsDays).toBeNull();
  });
  it('an absent days key under COD is also ok/null', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, termsMode: 'cod' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.values.creditTermsDays).toBeNull();
  });
});

describe('B2 - On credit judges the days (mutants: equals inverted; rule left optional)', () => {
  it('credit + blank -> refused with the rule\'s blank sentence', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, termsMode: 'credit', creditTermsDays: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule.name).toBe('creditTermsDays');
      expect(r.requirement).toBe(sentence(''));
      expect(r.progress).toBe('Required');
    }
  });
  it('credit + 400 -> refused with the max sentence (365)', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, termsMode: 'credit', creditTermsDays: '400' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.requirement).toBe(sentence('400'));
      expect(r.requirement).toContain('365');
      expect(r.requirement).not.toContain('400');
    }
  });
  it('credit + 30 -> ok, value "30"', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, termsMode: 'credit', creditTermsDays: '30' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.values.creditTermsDays).toBe('30');
  });
});

describe('B3 - termsMode ABSENT fails closed (mutant: absent = skip)', () => {
  it('no termsMode + "abc" -> refused', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base, creditTermsDays: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule.name).toBe('creditTermsDays');
  });
  it('no termsMode + blank -> refused (judged, not skipped)', () => {
    const r = checkAll(SUPPLIER_ADD_RULES, { ...base });
    expect(r.ok).toBe(false);
  });
});

describe('B4 - defineFieldRules refuses a nonsense `when` (mutants: self-reference accepted; empty equals accepted)', () => {
  const define = (def: Record<string, unknown>) =>
    (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => unknown)('t440.when', {
      mode: { label: 'The mode', kind: 'text' },
      x: def,
    });
  it('when.field === the rule\'s own name throws', () => {
    expect(() => define({ label: 'X', kind: 'text', when: { field: 'x', equals: ['a'], says: 's' } })).toThrow();
  });
  it('an empty equals throws', () => {
    expect(() => define({ label: 'X', kind: 'text', when: { field: 'mode', equals: [], says: 's' } })).toThrow();
  });
  it('a sane when does not throw', () => {
    expect(() => define({ label: 'X', kind: 'text', when: { field: 'mode', equals: ['a'], says: 's' } })).not.toThrow();
  });
});

describe('B5 - nativeAttrs of a `when` rule has no `required` (mutant: required emitted)', () => {
  it('a required-kind rule with a when has no required attribute', () => {
    const set = (defineFieldRules as unknown as (f: string, r: Record<string, unknown>) => Record<string, FieldRule>)('t440.when', {
      mode: { label: 'The mode', kind: 'text' },
      n: { label: 'N', kind: 'number', integer: true, when: { field: 'mode', equals: ['a'], says: 'Not needed' } },
    });
    expect((set.n as unknown as { when?: unknown }).when, '`when` was dropped by defineFieldRules').toBeDefined();
    expect(nativeAttrs(set.n!).required).toBeUndefined();
    expect(nativeAttrs(set.mode!).required).toBe(true);
  });
  it('the real days rule has no required attribute', () => {
    expect(days.when, 'the rule has no `when` yet').toBeDefined();
    expect(nativeAttrs(days).required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------- B6 server renders
const SUPPLIER = {
  id: 's-1', orgId: 'org-1', name: 'Acme Meats', creditTermsDays: 30, representativeName: null, contactNo: null, email: null,
  address: null, tin: null, bankName: null, bankAccountName: null, bankAccountNumber: null, notes: null, classification: null,
  vatStatus: null, status: 'active', isActive: true,
};
vi.mock('../src/lib/session', () => ({
  requireSession: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'p-1' }, sessionId: 'x', credentialKind: 'pin', storeId: null })),
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'p-1' })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('../src/app/ap/actions', () => ({
  createSupplierAction: vi.fn(), recordInvoiceAction: vi.fn(), editSupplierAction: vi.fn(),
  recordPaymentAction: vi.fn(), autoAllocatePaymentAction: vi.fn(),
}));
vi.mock('../src/app/ap/lib', async (orig) => {
  const actual = await orig<typeof import('../src/app/ap/lib')>();
  return {
    ...actual,
    listSuppliersWithPosition: vi.fn(async () => []),
    listInvoices: vi.fn(async () => []),
    listStores: vi.fn(async () => []),
    getSupplier: vi.fn(async () => SUPPLIER),
    getPosition: vi.fn(async () => '0.00'),
    listOpenItems: vi.fn(async () => []),
    moneyAccountsFor: vi.fn(async () => []),
    storesWithOpenItems: vi.fn(async () => []),
  };
});
vi.mock('@/lib/money-lines/load', () => ({ payableFloatsForStore: vi.fn(async () => ({ floats: [], unrouted: false })) }));

const inputTag = (html: string, name: string): string => {
  const m = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`));
  if (!m) throw new Error(`no <input name="${name}"> in: ${html.slice(0, 1500)}`);
  return m[0];
};
const hasAttr = (tag: string, attr: string) => new RegExp(`\\s${attr}(\\s|=|/|>)`).test(tag);

describe('B6 - server renders', () => {
  it('the add form (COD default) renders the days input without required, enabled', async () => {
    expect(days.when, 'the rule has no `when` yet').toBeDefined();
    // T-448 merge: the add-supplier form moved from /ap into a modal on /ap/suppliers.
    const Page = (await import('../src/app/ap/suppliers/page')).default;
    const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never);
    const tag = inputTag(html, 'creditTermsDays');
    expect(hasAttr(tag, 'required'), tag).toBe(false);
    expect(hasAttr(tag, 'disabled'), tag).toBe(false);
  }, 60_000);
  it('the edit form of a credit supplier renders the days input enabled with its value', async () => {
    expect(days.when, 'the rule has no `when` yet').toBeDefined();
    const Page = (await import('../src/app/ap/suppliers/[id]/page')).default;
    const html = renderToStaticMarkup((await Page({ params: Promise.resolve({ id: 's-1' }), searchParams: Promise.resolve({}) })) as never);
    const tag = inputTag(html, 'creditTermsDays');
    expect(tag).toMatch(/value="30"/);
    expect(hasAttr(tag, 'disabled'), tag).toBe(false);
    expect(hasAttr(tag, 'required'), tag).toBe(false);
  }, 60_000);
});

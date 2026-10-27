import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { AuthorizationError } from '@shareat/auth';
import { closeDb, customersRepo } from '@shareat/db';
import { createCustomer } from '@shareat/domain';
import { CUSTOMER_ADD_RULES, SUPPLIER_ADD_RULES, checkField } from '@shareat/domain/field-rules';
import { asOrg, dispatch, fixture, orderWorth, sayOf, uid } from './_fixtures/t433-b2b';

/**
 * T-398 S5c (TESTER) - customers.credit_terms_days, MIRRORING suppliers.credit_terms_days (T-362 legs D1/D2/D8/D9/D10/D14).
 * Orchestrator ruling 4b: same field name pattern (creditTermsDays), same bounds (whole number 0..365), blank = NULL, same refusal style
 * (the ONE field rule's own sentence, never quoting the typed value). Displayed and kept for ageing; NEVER used by the credit gate.
 * Customers have no edit function in the domain (createCustomer / setCustomerStatus / reconcileCustomer only), so the legs are on createCustomer.
 * Rule: CUSTOMER_ADD_RULES.creditTermsDays must exist and equal the supplier rule's shape.
 * Mutants: ignore the key (D1); 0 stored as NULL (D8); bounds off by one (D9/D10); gate relaxes a limit when terms are long (G1).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: database name must contain "_test".');
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Fx = Awaited<ReturnType<typeof fixture>>;
const make = (f: Fx, who: 'admin' | 'staff', creditTermsDays?: unknown) =>
  asOrg(f.orgId, (tx) =>
    createCustomer(tx, f[who], { name: `Terms ${uid('c')}`, priceListId: null, ...(creditTermsDays === undefined ? {} : { creditTermsDays }) } as never),
  );
const termsOf = async (id: string) => (await sql<{ t: number | null }[]>`select credit_terms_days as t from customers where id = ${id}`)[0]!.t;
const customerCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from customers where org_id = ${orgId}`)[0]!.n;

describe('R the field rule is the supplier rule', () => {
  it('CUSTOMER_ADD_RULES.creditTermsDays exists with the supplier rule kind and bounds (whole number, 0..365)', () => {
    const rule = (CUSTOMER_ADD_RULES as unknown as Record<string, Record<string, unknown> | undefined>).creditTermsDays;
    expect(rule, 'CUSTOMER_ADD_RULES.creditTermsDays is missing').toBeDefined();
    const sup = SUPPLIER_ADD_RULES.creditTermsDays as unknown as Record<string, unknown>;
    expect(rule).toMatchObject({ kind: sup.kind, integer: sup.integer, min: sup.min, max: sup.max });
  });
});

describe('D1/D2/D8/D9 stored values', () => {
  it('D1. 30 stores 30 and the customer row reads it back (displayed)', async () => {
    const f = await fixture(sql, 'ct1');
    const c = await make(f, 'admin', 30);
    expect(await termsOf(c.id)).toBe(30);
    const row = await asOrg(f.orgId, (tx) => customersRepo.getById(tx, f.orgId, c.id));
    expect((row as unknown as { creditTermsDays: number | null }).creditTermsDays).toBe(30);
  });

  it('D2 (empty = NULL). key absent, null and an empty box all store NULL, no refusal', async () => {
    const f = await fixture(sql, 'ct2');
    expect(await termsOf((await make(f, 'admin')).id)).toBeNull();
    expect(await termsOf((await make(f, 'admin', null)).id)).toBeNull();
    expect(await termsOf((await make(f, 'admin', '')).id)).toBeNull(); // an empty box is NULL
  });

  it('D11. a whitespace-only box is REFUSED with the supplier sentence (T-362 D11); nothing written', async () => {
    const f = await fixture(sql, 'ct11');
    const before = await customerCount(f.orgId);
    const r = await sayOf(make(f, 'admin', '   '));
    expect(r.said).toBe('Days to pay is required.');
    expect(await customerCount(f.orgId)).toBe(before);
  });

  it('D7/D8/D9. " 45 " stores 45; 0 stores 0 (not NULL); 365 stores 365', async () => {
    const f = await fixture(sql, 'ct8');
    expect(await termsOf((await make(f, 'admin', ' 45 ')).id)).toBe(45);
    expect(await termsOf((await make(f, 'admin', 0)).id)).toBe(0);
    expect(await termsOf((await make(f, 'admin', 365)).id)).toBe(365);
  });
});

describe('D10 refusals: the rule sentence, never the typed value; nothing written', () => {
  const cases: [string, unknown][] = [['366', 366], ['-1', -1], ['30.5', 30.5], ['NaN', Number.NaN], ["'abc'", 'abc'], ["'-5'", '-5'], ["'1e2'", '1e2'], ["'366'", '366']];
  for (const [label, value] of cases) {
    it(`creditTermsDays ${label}`, async () => {
      const f = await fixture(sql, `ct10${label.replace(/[^a-z0-9]/gi, '')}`);
      const before = await customerCount(f.orgId);
      const r = await sayOf(make(f, 'admin', value));
      const rule = (CUSTOMER_ADD_RULES as unknown as Record<string, Parameters<typeof checkField>[0]>).creditTermsDays!;
      expect(rule, 'CUSTOMER_ADD_RULES.creditTermsDays is missing').toBeDefined();
      const expected = checkField(rule, 'x');
      if (expected.ok) throw new Error('the rule accepted x');
      expect(r.said).toBe(expected.requirement);
      expect(r.said ?? '').not.toContain(String(value));
      expect(await customerCount(f.orgId)).toBe(before);
    });
  }
});

describe('D14 the gate: staff may not create a customer, with or without terms', () => {
  it('AuthorizationError; no row', async () => {
    const f = await fixture(sql, 'ct14');
    const before = await customerCount(f.orgId);
    await expect(make(f, 'staff', 30)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await customerCount(f.orgId)).toBe(before);
  });
});

describe('G1 the credit gate ignores the terms', () => {
  it('365 days to pay and a 1,000.00 limit is still refused at the limit; 0 days and no limit dispatches with no override', async () => {
    const f = await fixture(sql, 'ctg1');
    const long = await make(f, 'admin', 365);
    expect(await termsOf(long.id)).toBe(365); // the key is honoured at all (red until built)
    await sql`update customers set credit_limit = '1000.00' where id = ${long.id}`;
    const o1 = await orderWorth(sql, f, long.id, '5000.00');
    const r = await sayOf(dispatch(f, f.manager, o1.orderId));
    expect(r.message).toMatch(/limit of ₱1000\.00/);
    const none = await make(f, 'admin', 0);
    expect(await termsOf(none.id)).toBe(0);
    const o2 = await orderWorth(sql, f, none.id, '5000.00');
    const ok = await dispatch(f, f.manager, o2.orderId);
    expect(ok.creditOverridden).toBe(false);
  });
});

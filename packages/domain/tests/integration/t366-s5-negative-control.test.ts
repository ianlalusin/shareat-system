import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S5 (DEF-406) — the `controlAccountNegative` detector over 2160 (per store), 2130 (per
 * employee party) and 2120 (per store). `docs/tasks/366-remittance-floats.md` §S5, legs N1-N3
 * (R10: a NEW finding, the three existing ageing guards untouched).
 *
 * ⛔ TESTER, not BUILDER. `controlAccountNegative` does not exist yet — not even as an unwired
 * function — so importing it directly would make a missing export the red, not the detector's
 * absence. This calls through the EXISTING surface (`listFindings`/`closeReadiness`) instead: the
 * red is "no finding of that kind", which stays true whether the function is missing, unwired, or
 * wired but wrong, and needs no import that does not exist today (typecheck stays 0).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { closeReadiness, listFindings } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const code = uid(`t366s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Employee') returning id`;
  return { orgId, storeId: store!.id, employeeId: person!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function post(
  f: Fixture,
  accountCode: string,
  debit: string,
  credit: string,
  opts: { storeId?: string | null; partyType?: string; partyId?: string } = {},
) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: '2026-01-10',
      sourceType: 'test',
      sourceId: uid('src'),
      idempotencyKey: uid('key'),
      lines: [
        { accountCode, storeId: opts.storeId ?? f.storeId, debit, credit, partyType: opts.partyType ?? null, partyId: opts.partyId ?? null },
        { accountCode: '1110', storeId: opts.storeId ?? f.storeId, debit: credit, credit: debit },
      ],
    }),
  );
}

function controlNegativeFindings(feed: Awaited<ReturnType<typeof listFindings>>) {
  return feed.findings.filter((fd) => fd.kind === 'controlAccountNegative');
}

describe('N1 — 2160 driven negative at one store', () => {
  it('exactly one hard finding, storeId = the store, detail names ₱200.00; closeReadiness is blocked by it — Mutant: the <0.005 idiom or balance>0, red (no such finding today)', async () => {
    const f = await fixture('n1');
    await post(f, '2160', '200.00', '0'); // Dr 2160 200 / Cr 1110 200 -> credit-debit = -200.00
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    const found = controlNegativeFindings(feed);
    expect(found, 'today: controlAccountNegative does not exist — no such finding').toHaveLength(1);
    expect(found[0]?.severity).toBe('hard');
    expect(found[0]?.storeId).toBe(f.storeId);
    expect(found[0]?.detail).toContain('₱200.00');

    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.some((b) => b.kind === 'controlAccountNegative')).toBe(true);
  });

  // N3 — pins R10: the detector is ADDED, the existing ageing guard is NOT edited.
  it('N3: at -200.00, serviceChargeFloatAgeing is still silent', async () => {
    const f = await fixture('n1-n3');
    await post(f, '2160', '200.00', '0');
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    expect(feed.findings.filter((fd) => fd.kind === 'serviceChargeFloatAgeing')).toHaveLength(0);
  });
});

describe('N2 — 2130 (per employee) and 2120 (per store) driven negative', () => {
  it('2130: soft, storeId null, key/detail identify the employee; 2120: soft, storeId set — Mutant: same idiom, red today', async () => {
    const f = await fixture('n2');
    await post(f, '2130', '150.00', '0', { partyType: 'employee', partyId: f.employeeId }); // -150.00
    await post(f, '2120', '75.00', '0'); // -75.00
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    const found = controlNegativeFindings(feed);
    expect(found, 'today: no such finding').toHaveLength(2);

    const emp = found.find((fd) => fd.key.includes(f.employeeId));
    expect(emp, 'the 2130 finding must identify the employee in its key').toBeDefined();
    expect(emp?.severity).toBe('soft');
    expect(emp?.storeId, '2130 groups by employee, not store').toBeNull();
    expect(emp?.detail).toContain('₱150.00');

    const store = found.find((fd) => fd.storeId === f.storeId);
    expect(store, 'the 2120 finding must identify the store').toBeDefined();
    expect(store?.severity).toBe('soft');
    expect(store?.detail).toContain('₱75.00');
  });
});

describe('Positive controls', () => {
  it('exactly 0.00 (debit equals credit over the account): no finding — Mutant: <= 0, red today (both would be silent, so this control is what tells them apart once the detector exists)', async () => {
    const f = await fixture('pc-zero');
    await post(f, '2160', '100.00', '0');
    await post(f, '2160', '0', '100.00');
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    expect(controlNegativeFindings(feed)).toHaveLength(0);
  });

  it('a positive balance: no finding', async () => {
    const f = await fixture('pc-positive');
    await post(f, '2160', '0', '100.00');
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    expect(controlNegativeFindings(feed)).toHaveLength(0);
  });

  it('two stores, only one negative: exactly one finding, for the right store', async () => {
    const f = await fixture('pc-twostore');
    const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('pc-twostore-2')}, 'Store two') returning id`;
    await post(f, '2160', '200.00', '0'); // f.storeId -> -200.00
    await post(f, '2160', '0', '300.00', { storeId: store2!.id }); // store2 -> +300.00
    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    const found = controlNegativeFindings(feed);
    expect(found).toHaveLength(1);
    expect(found[0]?.storeId).toBe(f.storeId);
  });
});

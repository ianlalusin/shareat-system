import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-486 (DEF-776) - the payroll money-account picker never offers the staff float (GL 1120): payroll cannot be paid
 * from it, so the screen must not list it. The server refusal (packages/domain t486 test) stays the real guard.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { cashAccountsFor } from '../../src/app/payroll/lib';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-486 - cashAccountsFor', () => {
  it('omits every 1120 account but keeps office cash and e-wallets', async () => {
    const code = uid('t486-pick');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s!.id})`;

    const rows = await cashAccountsFor({ orgId, personId: p!.id }, s!.id);
    const codes = rows.map((r) => r.glAccountCode);
    expect(codes).not.toContain('1120');
    expect(codes).toContain('1130');
    expect(codes).toContain('1140');
  });
});

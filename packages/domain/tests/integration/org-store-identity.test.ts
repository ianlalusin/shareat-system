import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-229 slice 4 — organisation and store identity. **DEF-208.**
 * `docs/tasks/229-reference-data-administration.md` §4.1-4.8.
 *
 * ⛔ **This closes a REPLATFORM LOSS, not a missing screen.** v1 records `legalName`, `tin`,
 * `taxType` and an address on every store; v2 carried none of them across, so a statutory
 * identifier that exists in the live system today had nowhere to land.
 *
 * ⭐ Test 8 is the one that keeps T-228 safe: every new column is nullable, so `createOrganization`
 * still works with `{code, name}` alone. It fails loudly the day anyone makes one `NOT NULL`.
 *
 * ⛔ Run through `it.mjs` against a LANE database, never `npm run test:integration`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, systemTransaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createOrganization, organizationIdentity, setOrganizationIdentity } from '../../src/organizations';
import { storeReadiness, updateStoreDetails } from '../../src/stores/service';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`ident-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store A') returning id`;
  const storeId = store!.id;

  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };

  return {
    orgId,
    storeId,
    admin: actorOf(orgId, await person('Admin', 'admin')),
    manager: actorOf(orgId, await person('Manager', 'manager')),
    staff: actorOf(orgId, await person('Line staff', 'staff')),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function orgRow(orgId: string) {
  const [row] = await sql<Record<string, unknown>[]>`select * from organizations where id = ${orgId}`;
  return row!;
}
async function storeRowOf(storeId: string) {
  const [row] = await sql<Record<string, unknown>[]>`select * from stores where id = ${storeId}`;
  return row!;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-229 slice 4 — organisation identity (DEF-208)', () => {
  it('1 ⭐ an admin sets the legal name, TIN and tax type; a re-read returns all three', async () => {
    const f = await fixture('happy');
    await asOrg(f.orgId, (tx) =>
      setOrganizationIdentity(tx, f.admin, {
        legalName: 'Shareat Food Corporation',
        tin: '123456789',
        taxType: 'vat',
      }),
    );
    const read = await asOrg(f.orgId, (tx) => organizationIdentity(tx, f.admin));
    expect(read.legalName).toBe('Shareat Food Corporation');
    expect(read.tin).toBe('123456789');
    expect(read.taxType).toBe('vat');
    // ⚠️ The everyday trading name is a DIFFERENT field and must be untouched.
    expect(read.name).toBe((await orgRow(f.orgId)).name);
  });

  it('2 a manager and a staff member are both refused', async () => {
    const f = await fixture('gate');
    for (const who of [f.manager, f.staff]) {
      await expect(
        asOrg(f.orgId, (tx) => setOrganizationIdentity(tx, who, { legalName: 'X', tin: null, taxType: null })),
      ).rejects.toThrow(/may not 'manage_chart_of_accounts'/);
    }
    expect((await orgRow(f.orgId)).legal_name).toBeNull();
  });

  it('3 ⭐ clearing to null is allowed — a wrong TIN must be removable', async () => {
    const f = await fixture('clear');
    await asOrg(f.orgId, (tx) =>
      setOrganizationIdentity(tx, f.admin, { legalName: 'A', tin: '123456789', taxType: 'vat' }),
    );
    await asOrg(f.orgId, (tx) =>
      setOrganizationIdentity(tx, f.admin, { legalName: null, tin: null, taxType: null }),
    );
    const row = await orgRow(f.orgId);
    expect(row.legal_name).toBeNull();
    expect(row.tin).toBeNull();
    expect(row.tax_type).toBeNull();
  });

  it('4 a bad tax type is refused by the domain AND by the database', async () => {
    const f = await fixture('taxtype');
    await expect(
      asOrg(f.orgId, (tx) =>
        setOrganizationIdentity(tx, f.admin, {
          legalName: null,
          tin: null,
          taxType: 'sales' as unknown as 'vat',
        }),
      ),
    ).rejects.toThrow(/vat|non_vat/i);

    // ⭐ Straight past the domain — the CHECK is the authority (RULES §6 item 3, bible §15.11).
    await expect(
      sql`update organizations set tax_type = 'VAT' where id = ${f.orgId}`,
    ).rejects.toThrow(/organizations_tax_type_check/);
  });

  it('4b ⭐ R1 — a dashed TIN is normalised; a malformed one is refused by both layers', async () => {
    const f = await fixture('format');

    // Accepted and STORED AS DIGITS, so the column holds one canonical shape.
    await asOrg(f.orgId, (tx) =>
      setOrganizationIdentity(tx, f.admin, { legalName: null, tin: '123-456-789', taxType: null }),
    );
    expect((await orgRow(f.orgId)).tin).toBe('123456789');

    for (const bad of ['12345678', '12A456789', '1234567890123']) {
      await expect(
        asOrg(f.orgId, (tx) =>
          setOrganizationIdentity(tx, f.admin, { legalName: null, tin: bad, taxType: null }),
        ),
      ).rejects.toThrow(/digits/i);
    }

    // ⭐ And the database refuses it when the domain is bypassed.
    await expect(
      sql`update organizations set tin = '12A456789' where id = ${f.orgId}`,
    ).rejects.toThrow(/organizations_tin_format_check/);
  });

  it('5 ⭐ the identity is the ACTOR’s org — there is no orgId parameter to abuse', async () => {
    const a = await fixture('orgA');
    const b = await fixture('orgB');
    await asOrg(a.orgId, (tx) =>
      setOrganizationIdentity(tx, a.admin, { legalName: 'A Corp', tin: null, taxType: null }),
    );
    await asOrg(b.orgId, (tx) =>
      setOrganizationIdentity(tx, b.admin, { legalName: 'B Corp', tin: null, taxType: null }),
    );
    // ⛔ B's admin reads B, never A — the function takes the org from the Actor (DEF-210's shape).
    const read = await asOrg(b.orgId, (tx) => organizationIdentity(tx, b.admin));
    expect(read.legalName).toBe('B Corp');
    expect((await orgRow(a.orgId)).legal_name).toBe('A Corp');
  });
});

describe('T-229 slice 4 — store identity', () => {
  it('6 an admin sets address, contact and branch code; name and timezone are untouched', async () => {
    const f = await fixture('store');
    const before = await storeRowOf(f.storeId);
    await asOrg(f.orgId, (tx) =>
      updateStoreDetails(tx, f.admin, f.storeId, {
        address: '123 Real St, Lipa City',
        contactNumber: '09171234567',
        tinBranchCode: '00001',
      }),
    );
    const after = await storeRowOf(f.storeId);
    expect(after.address).toBe('123 Real St, Lipa City');
    expect(after.contact_number).toBe('09171234567');
    expect(after.tin_branch_code).toBe('00001');
    // ⚠️ Partial semantics: a key absent from the patch means "leave alone".
    expect(after.name).toBe(before.name);
    expect(after.timezone).toBe(before.timezone);
  });

  it('6b R1 — the branch code is normalised and format-checked, both layers', async () => {
    const f = await fixture('branch');
    await asOrg(f.orgId, (tx) => updateStoreDetails(tx, f.admin, f.storeId, { tinBranchCode: ' 00001 ' }));
    expect((await storeRowOf(f.storeId)).tin_branch_code).toBe('00001');

    for (const bad of ['12', 'abcde', '123456']) {
      await expect(
        asOrg(f.orgId, (tx) => updateStoreDetails(tx, f.admin, f.storeId, { tinBranchCode: bad })),
      ).rejects.toThrow(/digits/i);
    }
    await expect(
      sql`update stores set tin_branch_code = 'abcde' where id = ${f.storeId}`,
    ).rejects.toThrow(/stores_tin_branch_code_format_check/);
  });

  it('7 a manager is refused — store identity is `manage_stores`, not `manage_store_settings`', async () => {
    const f = await fixture('storegate');
    await expect(
      asOrg(f.orgId, (tx) => updateStoreDetails(tx, f.manager, f.storeId, { address: 'Nope' })),
    ).rejects.toThrow(/may not 'manage_stores'/);
    expect((await storeRowOf(f.storeId)).address).toBeNull();
  });

  it('8 ⭐⭐ createOrganization still works with {code, name} alone — T-228 is untouched', async () => {
    // ⛔ THE GUARD ON THE NULLABLE DECISION. Every identity column is nullable with no default, so
    //    `bootstrap-org.ts`'s first step needs no new flag and no new argument. The day someone
    //    makes one NOT NULL, this test fails and says why.
    const code = uid('boot');
    // ⭐ systemTransaction, not asOrg — same reason as packages/domain/tests/integration/
    // organizations.test.ts: createOrganization is only ever reached in production from inside
    // bootstrapOrganization via systemTransaction(); there is no org yet to scope a principal to.
    const result = await systemTransaction((tx) => createOrganization(tx, { code, name: `Org ${code}` }));
    expect(result.orgId).toBeTruthy();
    const row = await orgRow(result.orgId);
    expect(row.legal_name).toBeNull();
    expect(row.tin).toBeNull();
    expect(row.tax_type).toBeNull();
  });

  it('9 ⛔ store readiness does NOT block on organisation identity', async () => {
    // ⭐ Readiness gates TRADING AT A BRANCH. A missing org TIN does not stop a sales day being
    //    recorded correctly, and a blocking check here would make every store un-ready for a field
    //    that belongs to the entity, not the branch.
    const f = await fixture('ready');
    const [row] = await sql<Record<string, unknown>[]>`select * from stores where id = ${f.storeId}`;
    const checks = await asOrg(f.orgId, (tx) => storeReadiness(tx, f.admin, row as never));
    expect(checks.some((c) => /tin|identity|legal/i.test(c.key) || /tin|legal name/i.test(c.label))).toBe(false);
  });
});

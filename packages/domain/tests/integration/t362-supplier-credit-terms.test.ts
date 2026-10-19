import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-362 (DEF-495) — domain-direct legs D1-D16 + the database backstop + the compile pin.
 * `docs/tasks/362-def-495-supplier-credit-terms.md` §Legs, "Domain-direct".
 *
 * ⛔ TESTER, not BUILDER. `createSupplier`/`editSupplier` parse `creditTermsDays` after `authorize`
 * (R2, the DEF-478/T-352/T-360 shape) and — on `editSupplier`, only on a real change — append an
 * `audit_log` row (R3). Every "was red today" note records the PRE-FIX result: the key is accepted
 * on the input type but silently ignored, because neither `insertSupplier` nor `updateSupplier`
 * names the column yet. Harness/fixture copied from `supplier-master.test.ts:15-80` (manager +
 * staff), with an admin person added per the task doc's own note for the R5 ✅ leg (Q1: managers
 * and admins both hold `approve_supplier`, row 250).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createSupplier, editSupplier } from '@shareat/domain';
import { SUPPLIER_ADD_RULES, checkField } from '@shareat/domain/field-rules';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t362-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
    `;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  const adminId = await mk('Admin', 'admin');
  return {
    orgId,
    storeId: store!.id,
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
    admin: actor(orgId, adminId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

async function creditTermsOf(id: string): Promise<number | null> {
  const [row] = await sql<{ credit_terms_days: number | null }[]>`
    select credit_terms_days from suppliers where id = ${id}`;
  return row!.credit_terms_days;
}

interface AuditRow {
  action: string;
  entity: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  source: string;
  actor_person_id: string;
}
async function auditRowsFor(id: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select action, entity, entity_id, before, after, source, actor_person_id
    from audit_log where entity = 'suppliers' and entity_id = ${id} order by occurred_at`;
}

async function codSupplier(f: Fixture, hint: string): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `COD ${uid(hint)}` }));
  return id;
}
/** A supplier already at 30 days — set by SQL, since no domain writer exists before this task
 * (the same fixture shortcut `t358-ap-invoice-expense-form.test.ts:166-170` used). */
async function thirtyDaySupplier(f: Fixture, hint: string): Promise<string> {
  const id = await codSupplier(f, hint);
  await sql`update suppliers set credit_terms_days = 30 where id = ${id}`;
  return id;
}

const TERMS_BLANK = 'Enter how many days of credit this supplier gives (0 to 365), or choose Cash on delivery.';
// T-440 (row 363): ONE rule; the server refuses with the rule's own sentence, which never quotes the typed value.
const RULE_SENTENCE = (() => {
  const c = checkField(SUPPLIER_ADD_RULES.creditTermsDays, 'x');
  if (c.ok) throw new Error('rule accepted x');
  return c.requirement;
})();
const M = (_typed: string) => RULE_SENTENCE;

describe('D1 — createSupplier, creditTermsDays: 30', () => {
  it('row has 30 — was red today: stored null (the key is ignored)', async () => {
    const f = await fixture('d1');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: `D1 ${uid('s')}`, creditTermsDays: 30 } as Parameters<typeof createSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(30);
  });
});

describe('D2 (green, guard) — createSupplier, no key; and creditTermsDays: null', () => {
  it('both rows null', async () => {
    const f = await fixture('d2');
    const { id: id1 } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `D2a ${uid('s')}` }));
    expect(await creditTermsOf(id1)).toBeNull();
    const { id: id2 } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: `D2b ${uid('s')}`, creditTermsDays: null } as Parameters<typeof createSupplier>[2]),
    );
    expect(await creditTermsOf(id2)).toBeNull();
  });
});

describe('D3 — editSupplier on a COD supplier, creditTermsDays: 30', () => {
  it('row 30; exactly 1 AUD row (before null, after 30, actor manager, source web) — was red today: stays null; 0 audit rows', async () => {
    const f = await fixture('d3');
    const id = await codSupplier(f, 'd3');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: 30 } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(30);
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'set_supplier_credit_terms',
      entity: 'suppliers',
      entity_id: id,
      before: { creditTermsDays: null },
      after: { creditTermsDays: 30 },
      source: 'web',
      actor_person_id: f.manager.personId,
    });
  });
});

describe('D4 — editSupplier on a 30-day supplier (set by SQL), creditTermsDays: null', () => {
  it('row null; 1 AUD row, before 30, after null — was red today: stays 30', async () => {
    const f = await fixture('d4');
    const id = await thirtyDaySupplier(f, 'd4');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: null } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBeNull();
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: { creditTermsDays: 30 }, after: { creditTermsDays: null } });
  });
});

describe('D5 (green, guard; positive control for "audit only on change")', () => {
  it('30-day supplier, creditTermsDays: 30 — row 30; 0 AUD rows', async () => {
    const f = await fixture('d5');
    const id = await thirtyDaySupplier(f, 'd5');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: 30 } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(30);
    expect(await auditRowsFor(id)).toHaveLength(0);
  });
});

describe('D6 (green, guard; positive control for "absent means untouched"; Amendment A1 mutant 5)', () => {
  it('30-day supplier, { name: "Renamed" } only — row 30; name changed; 0 AUD rows', async () => {
    const f = await fixture('d6');
    const id = await thirtyDaySupplier(f, 'd6');
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, name: 'Renamed' }));
    expect(await creditTermsOf(id)).toBe(30);
    const [row] = await sql<{ name: string }[]>`select name from suppliers where id = ${id}`;
    expect(row!.name).toBe('Renamed');
    expect(await auditRowsFor(id)).toHaveLength(0);
  });
});

describe('D7 — creditTermsDays: " 45 " (raw string)', () => {
  it('row 45 — was red today: stays null', async () => {
    const f = await fixture('d7');
    const id = await codSupplier(f, 'd7');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: ' 45 ' } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(45);
  });
});

describe('D8 — creditTermsDays: 0', () => {
  it('row 0, not null (R1: 0 is credit) — was red today: stays null', async () => {
    const f = await fixture('d8');
    const id = await codSupplier(f, 'd8');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: 0 } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(0);
  });
});

describe('D9 — creditTermsDays: 365', () => {
  it('row 365 — was red today: stays null', async () => {
    const f = await fixture('d9');
    const id = await codSupplier(f, 'd9');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: 365 } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(365);
  });
});

describe('D10 — refusals, each on a fresh COD supplier', () => {
  const cases: [string, unknown, string][] = [
    ['366', 366, M('366')],
    ['-1', -1, M('-1')],
    ['30.5', 30.5, M('30.5')],
    ['NaN', Number.NaN, M('NaN')],
    ["'abc'", 'abc', M('abc')],
    ["'-5'", '-5', M('-5')],
    ["'1e2'", '1e2', M('1e2')],
    ["'366'", '366', M('366')],
    ["'-0'", '-0', M('-0')],
  ];
  for (const [label, value, sentence] of cases) {
    it(`creditTermsDays: ${label} rejects with userMessage ${JSON.stringify(sentence)}; nothing written — was red today: resolves`, async () => {
      const f = await fixture(`d10-${label.replace(/[^a-z0-9]/gi, '')}`);
      const id = await codSupplier(f, 'd10');
      await expect(
        asOrg(f.orgId, (tx) =>
          editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: value } as Parameters<typeof editSupplier>[2]),
        ),
      ).rejects.toMatchObject({ userMessage: sentence });
      const refusal = await asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: value } as Parameters<typeof editSupplier>[2]),
      ).catch((e) => e);
      expect((refusal as { userMessage?: string }).userMessage ?? '', 'the refusal never quotes the typed value').not.toContain(`"${String(value)}"`);
      expect(await creditTermsOf(id)).toBeNull();
      expect(await auditRowsFor(id)).toHaveLength(0);
    });
  }
});

describe('D11 — creditTermsDays: "   " (whitespace only)', () => {
  it(`rejects with userMessage ${JSON.stringify(TERMS_BLANK)}; nothing written — was red today: resolves`, async () => {
    const f = await fixture('d11');
    const id = await codSupplier(f, 'd11');
    await expect(
      asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.manager, { supplierId: id, creditTermsDays: '   ' } as Parameters<typeof editSupplier>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: TERMS_BLANK });
    expect(await creditTermsOf(id)).toBeNull();
  });
});

describe('D12 (green, guard; ordering) — a STAFF non-holder, editSupplier, creditTermsDays: "abc"', () => {
  it('message equals the same staff member\'s message for creditTermsDays: 30; ⛔ no "Payment terms"; nothing written', async () => {
    const f = await fixture('d12');
    const id = await codSupplier(f, 'd12');
    const call = (creditTermsDays: unknown) =>
      asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.staff, { supplierId: id, creditTermsDays } as Parameters<typeof editSupplier>[2]),
      );
    const baseline = await call(30).catch((e) => e);
    const malformed = await call('abc').catch((e) => e);
    expect(baseline, 'expected the valid-value call to be refused too').toBeInstanceOf(Error);
    expect((malformed as { userMessage?: string }).userMessage).toBe((baseline as { userMessage?: string }).userMessage);
    expect((malformed as { userMessage?: string }).userMessage ?? '').not.toContain('Payment terms');
    expect(await creditTermsOf(id)).toBeNull();
  });
});

describe('D13 (green, guard) — ✗ fires (R5): staff, editSupplier, creditTermsDays: 30', () => {
  it('AuthorizationError; nothing written; 0 AUD rows', async () => {
    const f = await fixture('d13');
    const id = await codSupplier(f, 'd13');
    await expect(
      asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.staff, { supplierId: id, creditTermsDays: 30 } as Parameters<typeof editSupplier>[2]),
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(await creditTermsOf(id)).toBeNull();
    expect(await auditRowsFor(id)).toHaveLength(0);
  });
});

describe('D14 (green, guard) — ✗ fires on create: staff, createSupplier, creditTermsDays: 30', () => {
  it('AuthorizationError; no supplier row', async () => {
    const f = await fixture('d14');
    const name = `D14 ${uid('s')}`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createSupplier(tx, f.staff, { name, creditTermsDays: 30 } as Parameters<typeof createSupplier>[2]),
      ),
    ).rejects.toThrow(AuthorizationError);
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from suppliers where name = ${name}`;
    expect(Number(row!.n)).toBe(0);
  });
});

describe('D15 (Q1: row 250) — ✅ for admin: editSupplier, creditTermsDays: 15', () => {
  it('row 15; 1 AUD row with actor = admin — was red today: stays null', async () => {
    const f = await fixture('d15');
    const id = await codSupplier(f, 'd15');
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.admin, { supplierId: id, creditTermsDays: 15 } as Parameters<typeof editSupplier>[2]),
    );
    expect(await creditTermsOf(id)).toBe(15);
    const rows = await auditRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.admin.personId);
  });
});

describe('D16 (green, guard; order guard R2) — manager, { name: "   ", creditTermsDays: "abc" }', () => {
  it('the name sentence, not M(\'abc\'); nothing written', async () => {
    const f = await fixture('d16');
    const id = await codSupplier(f, 'd16');
    await expect(
      asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.manager, { supplierId: id, name: '   ', creditTermsDays: 'abc' } as Parameters<typeof editSupplier>[2]),
      ),
    ).rejects.toMatchObject({ userMessage: 'A supplier needs a name people will recognise.' });
    expect(await creditTermsOf(id)).toBeNull();
  });
});

describe('Database backstop (green today, a guard)', () => {
  it('raw UPDATE suppliers set credit_terms_days = 366 raises SQLSTATE 23514', async () => {
    const f = await fixture('backstop');
    const id = await codSupplier(f, 'backstop');
    await expect(sql`update suppliers set credit_terms_days = 366 where id = ${id}`).rejects.toMatchObject({
      code: '23514',
    });
  });
});

// =================================================================================================
// Compile-time pin (never called) — `CreateSupplierInput.creditTermsDays?: number | string | null`
// must accept a raw string, and refuse a value of the wrong TYPE entirely (not just the wrong
// range) at compile time.
// =================================================================================================
function neverCalled_creditTermsDaysAcceptsRawInput(): void {
  void createSupplier(null, null as never, { name: 'x', creditTermsDays: '30' });

  void createSupplier(null, null as never, {
    name: 'x',
    // @ts-expect-error — creditTermsDays is number | string | null; a boolean is none of those.
    creditTermsDays: true,
  });
}
void neverCalled_creditTermsDaysAcceptsRawInput;

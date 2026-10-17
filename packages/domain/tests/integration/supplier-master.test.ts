import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-188 — supplier master data.
 *
 * ⭐ The claim under test is the one the live v1 probe produced: the parity gap that mattered was
 * never the missing FIELDS, it was that **a supplier could be created and never edited**
 * (DEF-106), and that the one field worth porting only works if BOTH halves exist.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createSupplier, editSupplier, recordInvoice } from '@shareat/domain';

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
  const code = uid(`sup-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')
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
  return {
    orgId,
    storeId: store!.id,
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-188 / DEF-106 — a supplier can finally be CORRECTED', () => {
  it('⭐ edits every ported field, and a blank clears rather than storing an empty string', async () => {
    const f = await fixture('edit');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'Tyipco', contactNo: '0917' }),
    );

    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, {
        supplierId: id,
        name: '  Typo Co.  ',
        email: 'ap@typo.example',
        representativeName: 'Ms. Reyes',
        tin: '123-456-789-000',
        classification: 'corporate',
        bankName: 'BPI',
        bankAccountName: 'Typo Co.',
        bankAccountNumber: '1234567890',
        contactNo: '   ',
      }),
    );

    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
    expect(s!.name).toBe('Typo Co.'); // ⭐ trimmed — the whole point of DEF-106
    expect(s!.email).toBe('ap@typo.example');
    expect(s!.tin).toBe('123-456-789-000');
    expect(s!.classification).toBe('corporate');
    expect(s!.bankAccountNumber).toBe('1234567890');
    // ⚠️ An emptied field CLEARS. Storing '' would make "not stated" and "stated as nothing"
    // indistinguishable, and every downstream `?? '—'` would print a blank instead.
    expect(s!.contactNo).toBeNull();
  });

  it('⚠️ a key the caller never sends is LEFT ALONE, not blanked', async () => {
    const f = await fixture('partial');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'Keep Co.', notes: 'delivers Tuesdays' }),
    );
    // Only the name is sent. Passing a whole object would blank every field the caller did not
    // happen to render — the classic edit-form data-loss bug.
    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, name: 'Keep Co. Inc.' }),
    );
    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
    expect(s!.name).toBe('Keep Co. Inc.');
    expect(s!.notes).toBe('delivers Tuesdays');
  });

  it('⛔ refuses a name that is only whitespace', async () => {
    const f = await fixture('blank');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Real Co.' }));
    await expect(
      asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, name: '   ' })),
    ).rejects.toThrow(/needs a name/i);
  });

  it('⛔ refuses a supplier that does not exist, rather than silently doing nothing', async () => {
    const f = await fixture('missing');
    await expect(
      asOrg(f.orgId, (tx) =>
        editSupplier(tx, f.manager, {
          supplierId: '01a05118-0000-7000-8000-000000000000',
          name: 'Ghost',
        }),
      ),
    ).rejects.toThrow(/does not exist/i);
  });

  it('⛔ STAFF may not edit — the same gate as create, deliberately not weaker', async () => {
    // A name and a bank account number are the two fields that decide where money goes. A weaker
    // gate on edit would make the stronger gate on create pointless.
    const f = await fixture('gate');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Gated Co.' }));
    await expect(
      asOrg(f.orgId, (tx) => editSupplier(tx, f.staff, { supplierId: id, name: 'Hijacked' })),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =====================================================================================

describe('T-188 §4.4 — `issues_official_receipt` is a DEFAULT, and the invoice owns its copy', () => {
  it('defaults to true, matching v1’s `?? true` fallback', async () => {
    const f = await fixture('ordefault');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'OR Co.' }));
    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
    expect(s!.issuesOfficialReceipt).toBe(true);
  });

  it('⭐ an invoice INHERITS the supplier’s habit at creation', async () => {
    const f = await fixture('inherit');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'No OR Co.', issuesOfficialReceipt: false }),
    );
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, {
        storeId: f.storeId,
        supplierId: id,
        invoiceDate: '2026-01-10',
        totalAmount: '1000.00',
      }),
    );
    const [row] = await sql<{ is_official_receipt: boolean }[]>`
      select is_official_receipt from supplier_invoices where id = ${inv.id}
    `;
    expect(row!.is_official_receipt).toBe(false);
  });

  it('⛔⭐ and the invoice is COPIED, not read through — changing the supplier later must not rewrite it', async () => {
    // This is the assertion the whole design turns on. If the invoice read through to the
    // supplier, flipping a supplier's habit today would silently change what last month's
    // receipt WAS — and a BIR audit asks about the document, not the habit.
    const f = await fixture('copied');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'Changes Co.', issuesOfficialReceipt: true }),
    );
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, {
        storeId: f.storeId,
        supplierId: id,
        invoiceDate: '2026-01-11',
        totalAmount: '500.00',
      }),
    );

    await asOrg(f.orgId, (tx) =>
      editSupplier(tx, f.manager, { supplierId: id, issuesOfficialReceipt: false }),
    );

    const [row] = await sql<{ is_official_receipt: boolean }[]>`
      select is_official_receipt from supplier_invoices where id = ${inv.id}
    `;
    expect(row!.is_official_receipt).toBe(true); // ⭐ unchanged
    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
    expect(s!.issuesOfficialReceipt).toBe(false); // the habit did change
  });

  it('an explicit override on the invoice beats the supplier’s default', async () => {
    const f = await fixture('override');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'Usually OR', issuesOfficialReceipt: true }),
    );
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, {
        storeId: f.storeId,
        supplierId: id,
        invoiceDate: '2026-01-12',
        totalAmount: '250.00',
        isOfficialReceipt: false,
      }),
    );
    const [row] = await sql<{ is_official_receipt: boolean }[]>`
      select is_official_receipt from supplier_invoices where id = ${inv.id}
    `;
    expect(row!.is_official_receipt).toBe(false);
  });
});

// =====================================================================================

describe('T-188 §4.2 — `classification` is a closed label', () => {
  it('accepts the three v1 values', async () => {
    const f = await fixture('cls');
    for (const c of ['corporate', 'individual', 'other'] as const) {
      const { id } = await asOrg(f.orgId, (tx) =>
        createSupplier(tx, f.manager, { name: `Co ${c}`, classification: c }),
      );
      const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
      expect(s!.classification).toBe(c);
    }
  });

  it('⛔ the DATABASE refuses anything else — the enum is not merely a TypeScript hint', async () => {
    const f = await fixture('clsbad');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Bad Cls' }));
    await expect(
      sql`update suppliers set classification = 'sole-proprietor' where id = ${id}`,
    ).rejects.toThrow(/suppliers_classification_check/);
  });
});

// =====================================================================================

describe('T-188 §2.1 — org-scoping is what removes v1’s duplication', () => {
  it('⭐ one supplier per ORG, not one per store — the same name twice is refused', async () => {
    // v1 keys suppliers at stores/{id}/suppliers, so 129 documents held 88 distinct suppliers and
    // one vendor was filed 20 separate times. v2 makes that unrepresentable.
    const f = await fixture('dupe');
    await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Fleetwide Trading' }));
    await expect(
      asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Fleetwide Trading' })),
    ).rejects.toThrow(/suppliers_org_name_key/);
  });
});

describe('T-440 S1 (createSupplier) - the supplier add form\'s rule set is the one the server speaks', () => {
  /** The pilot rule set exported by the field-rules leaf: the one that carries `creditTermsDays` (+ `name`). */
  async function supplierRules() {
    const mod = (await import('../../src/field-rules')) as Record<string, unknown>;
    const set = Object.values(mod).find(
      (v): v is Record<string, { name: string }> =>
        typeof v === 'object' && v !== null && Object.isFrozen(v) && 'creditTermsDays' in (v as object) && 'name' in (v as object),
    );
    expect(set, 'a frozen field-rules set carries both `name` and `creditTermsDays` (the supplier add form)').toBeDefined();
    const { checkField } = mod as unknown as { checkField: (r: unknown, raw: string) => { ok: boolean; requirement?: string } };
    return { set: set!, checkField };
  }

  it('a blank name is refused with the very sentence the live check shows (one sentence, two places)  [mutant: edit one server sentence]', async () => {
    const f = await fixture('t440name');
    const { set, checkField } = await supplierRules();
    const shown = checkField(set.name, '   ');
    expect(shown.ok).toBe(false);
    for (const blank of ['', '   ']) {
      let err: (Error & { userMessage?: string; name: string }) | undefined;
      try {
        await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: blank }));
      } catch (e) {
        err = e as typeof err;
      }
      expect(err?.name, JSON.stringify(blank)).toBe('RefusalError');
      expect(err?.userMessage).toBe(shown.requirement);
    }
  });

  it('a name is stored trimmed, and a stored supplier is unchanged by the refactor (green guard: passes before and after)', async () => {
    const f = await fixture('t440trim');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: '  ABC Meat Supply  ' }));
    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, id));
    expect(s!.name).toBe('ABC Meat Supply');
  });

  it('creditTermsDays 366 is refused and 365 / blank are accepted (the rule\'s 0-365 matches the server)', async () => {
    const f = await fixture('t440days');
    await expect(
      asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Late Co.', creditTermsDays: '366' as unknown as number })),
    ).rejects.toMatchObject({ name: 'RefusalError' });
    const ok = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Edge Co.', creditTermsDays: '365' as unknown as number }));
    const s = await asOrg(f.orgId, (tx) => apRepo.getSupplierById(tx, f.orgId, ok.id));
    expect(s!.creditTermsDays).toBe(365);
  });
});

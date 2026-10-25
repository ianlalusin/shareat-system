import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-475 S1 (TESTER) - the one new endpoint, `checkInvoiceNumberAction` (apps/erp/src/app/ap/actions.ts), behind the live
 * "this invoice number is already recorded" warning (A5, Q1 option A). Spec 3.3, 7 S1 "Lookup".
 *
 * CONTRACT PINNED HERE:
 *   checkInvoiceNumberAction({ storeId, supplierId, invoiceNo }) -> Promise<{ matches: Array<{ invoiceDate: string; totalAmount: string }> }>
 *   - authorize(record_supplier_invoice, { storeId }) runs FIRST (DEF-676): a caller without the right gets the authorization
 *     refusal, never a duplicate answer and never an empty "no match" that looks like a real one;
 *   - scoped to the ACTOR'S ORG: a supplier or invoice of another org is indistinguishable from "no such invoice"
 *     (same answer as a random id: no enumeration across orgs);
 *   - the answer is exactly what the after-save warning already reveals: invoice date and total of each match, NOTHING else
 *     (no invoice id, no person, no store, no status: T-343, row 353);
 *   - a blank number matches nothing; the typed number is trimmed (as recordInvoice trims it).
 *   - SPEC DOUBT (reported): "store-scoped" in the brief vs "org" in spec 3.3. This test pins ORG scope for the MATCHES (same
 *     rows recordInvoice's own warning reveals), and STORE scope for the AUTHORIZATION.
 *
 * MUTANTS: the lookup runs before authorize (leaks to an unauthorized caller); the org filter dropped (another org's number
 * answers); a match carries id / createdBy; a blank number returns every invoice of the supplier; an unauthorized caller is
 * answered with an empty list instead of a refusal; a wrong-store actor allowed because the role is held elsewhere.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => null),
}));

import { closeDb } from '@shareat/db';
import { ap475Fixture, uid, type Fixture } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Answer = { matches: Array<Record<string, unknown>> };
async function lookup(as: { orgId: string; personId: string }, input: { storeId: string; supplierId: string; invoiceNo: string }): Promise<Answer> {
  ACTOR_HOLDER.actor = as;
  const actions = (await import('../../src/app/ap/actions')) as unknown as { checkInvoiceNumberAction?: (i: typeof input) => Promise<Answer> };
  expect(typeof actions.checkInvoiceNumberAction, 'checkInvoiceNumberAction is not exported by app/ap/actions.ts').toBe('function');
  return actions.checkInvoiceNumberAction!(input);
}
const UUID0 = '00000000-0000-4000-8000-000000000000';

/** A second org with its own store, person, supplier and an invoice carrying the number INV-7. */
async function otherOrgInvoice(no: string) {
  const code = uid('t475-other');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid('s')}, 'Elsewhere') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Someone') returning id`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${org!.id}, 'Foreign Co', ${p!.id}) returning id`;
  await sql`insert into supplier_invoices (org_id, store_id, supplier_id, invoice_no, invoice_date, total_amount, status, created_by) values (${org!.id}, ${st!.id}, ${sup!.id}, ${no}, '2026-01-03', '777.00', 'pending', ${p!.id})`;
  return { supplierId: sup!.id };
}

describe('T-475 S1 - checkInvoiceNumberAction: authorize first', () => {
  it('source: authorize() runs before any repo read in the function body (mutant: lookup first)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'ap', 'actions.ts'), 'utf8');
    const at = src.indexOf('export async function checkInvoiceNumberAction');
    expect(at, 'checkInvoiceNumberAction missing').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\nexport async function', at + 10) === -1 ? undefined : src.indexOf('\nexport async function', at + 10));
    const gate = body.search(/authorize\(/);
    const read = body.search(/findDuplicateInvoices|apRepo\./);
    expect(gate, 'no authorize( call').toBeGreaterThan(-1);
    expect(body).toContain("'record_supplier_invoice'");
    expect(gate).toBeLessThan(read);
  });
});

describe('T-475 S1 - checkInvoiceNumberAction: behaviour', () => {
  it('an authorized logger gets the date and total of each match, and nothing else', async () => {
    const f = await ap475Fixture(sql, 'lk1');
    const s = await f.supplier();
    await f.invoice({ supplierId: s, invoiceNo: 'INV-7', on: '2026-01-04', total: '1200.00' });
    const a = await lookup(f.admin, { storeId: f.storeId, supplierId: s, invoiceNo: 'INV-7' });
    expect(a.matches).toEqual([{ invoiceDate: '2026-01-04', totalAmount: '1200.00' }]);
    for (const m of a.matches) expect(Object.keys(m).sort()).toEqual(['invoiceDate', 'totalAmount']);
    expect(JSON.stringify(a)).not.toContain(f.adminId);
  });

  it('the typed number is trimmed; another number or a blank one matches nothing (mutant: blank returns every invoice of the supplier)', async () => {
    const f = await ap475Fixture(sql, 'lk2');
    const s = await f.supplier();
    await f.invoice({ supplierId: s, invoiceNo: 'INV-7' });
    await f.invoice({ supplierId: s, invoiceNo: null });
    expect((await lookup(f.admin, { storeId: f.storeId, supplierId: s, invoiceNo: '  INV-7 ' })).matches).toHaveLength(1);
    expect((await lookup(f.admin, { storeId: f.storeId, supplierId: s, invoiceNo: 'INV-8' })).matches).toEqual([]);
    for (const blank of ['', '   ']) expect((await lookup(f.admin, { storeId: f.storeId, supplierId: s, invoiceNo: blank })).matches).toEqual([]);
  });

  it('a match is for THIS supplier only (the same number under another supplier of the org is not a duplicate)', async () => {
    const f = await ap475Fixture(sql, 'lk3');
    const a = await f.supplier();
    const b = await f.supplier();
    await f.invoice({ supplierId: b, invoiceNo: 'INV-7' });
    expect((await lookup(f.admin, { storeId: f.storeId, supplierId: a, invoiceNo: 'INV-7' })).matches).toEqual([]);
  });

  it("another ORG's supplier and invoice never answer, and the reply is indistinguishable from an unknown supplier (no enumeration; mutant: org filter dropped)", async () => {
    const f = await ap475Fixture(sql, 'lk4');
    const foreign = await otherOrgInvoice('INV-7');
    const asked = await lookup(f.admin, { storeId: f.storeId, supplierId: foreign.supplierId, invoiceNo: 'INV-7' });
    const unknown = await lookup(f.admin, { storeId: f.storeId, supplierId: UUID0, invoiceNo: 'INV-7' });
    expect(asked).toEqual({ matches: [] });
    expect(asked).toEqual(unknown);
    expect(JSON.stringify(asked)).not.toContain('777');
  });

  it('the same number logged at another store of the SAME org is revealed exactly as the after-save warning reveals it (pinned org scope; see SPEC DOUBT)', async () => {
    const f = await ap475Fixture(sql, 'lk5');
    const s = await f.supplier();
    await f.invoice({ supplierId: s, invoiceNo: 'INV-7', storeId: f.store2Id, on: '2026-01-06', total: '55.00' });
    const a = await lookup(f.admin, { storeId: f.storeId, supplierId: s, invoiceNo: 'INV-7' });
    expect(a.matches).toEqual([{ invoiceDate: '2026-01-06', totalAmount: '55.00' }]);
  });

  it('a caller who may not log invoices at that store is REFUSED (not answered, not told "no match"): floor staff, and a manager of another store (mutants: lookup first; refusal turned into an empty list)', async () => {
    const f: Fixture = await ap475Fixture(sql, 'lk6');
    const s = await f.supplier();
    await f.invoice({ supplierId: s, invoiceNo: 'INV-7', total: '4321.00' });
    for (const [who, as] of [['floor staff', f.staff], ['staff of another store', f.otherStoreStaff]] as const) {
      let outcome: unknown;
      try {
        outcome = await lookup(as, { storeId: f.storeId, supplierId: s, invoiceNo: 'INV-7' });
      } catch (err) {
        outcome = err;
      }
      expect(outcome instanceof Error, `${who}: expected a refusal, got ${JSON.stringify(outcome)}`).toBe(true);
      const message = (outcome as { userMessage?: string; message: string }).userMessage ?? (outcome as Error).message;
      expect(message, `${who}: the refusal leaked the invoice`).not.toMatch(/4321|INV-7/);
    }
  });

  it('an unknown store id is refused the same way (the store is not an enumeration oracle)', async () => {
    const f = await ap475Fixture(sql, 'lk7');
    const s = await f.supplier();
    await expect(lookup(f.admin, { storeId: UUID0, supplierId: s, invoiceNo: 'INV-7' })).rejects.toThrow();
  });
});

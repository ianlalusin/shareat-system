import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-389 S1 (TESTER) - the supplier edit form keeps what was typed after a refused save (DEF-617).
 * Spec: docs/tasks/389-refused-save-keeps-typing.md - R1-R5, K5 (supplier), Q1, section 9.4 steps 7-8.
 *
 * Real Postgres + real domain; session, navigation, cookie jar and the Page shell doubled (harness: t365/t362).
 * `@/components/forms` is a pass-through that records the props every EditableRecord is rendered with, so the test can
 * see the `typed` the page handed it: the server never draws a typed value (R3), the browser applies it.
 *
 * The refusal: termsMode "credit" with the days box left blank. The server refuses it (TERMS_BLANK) and the browser's
 * own `required` cannot pre-empt it (the days box is not required).
 *
 * CONTRACT PINNED HERE (spec silent or ambiguous; the builder matches):
 *  - form key `supplier.edit` (the spec's own example); allow-list = every user-editable control of the form:
 *    name, representativeName, contactNo, email, address, tin, vatStatus, classification, status,
 *    issuesOfficialReceipt, termsMode, creditTermsDays, bankName, bankAccountName, notes. NOT supplierId and NOT the
 *    hidden marker issuesOfficialReceiptPresent. `bankAccountNumber` is excluded (Q1 = a, SENSITIVE).
 *  - the hint text on a typed reopen: "The account number is not kept after a refused save. Check it before saving."
 *    arrives on the record as `typed.hint` (def.notKeptHint).
 *  - SPEC GAP: the form sits inside a closed <details>. A reopened (or dropped) record must be VISIBLE, so the page opens
 *    the <details> (the `open` attribute) when the record has a typed view; with none it stays closed.
 * Each test names its killing mutant.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const real = await orig<typeof import('@/components/forms')>();
  const { createElement } = await import('react');
  return {
    ...real,
    EditableRecord: (p: Record<string, unknown>) => {
      seen.records.push(p);
      return createElement(real.EditableRecord as never, p as never);
    },
  };
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, editSupplier } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { FLASH_COOKIE, captureRedirect, currentJar, outcomeOf, pageParamsOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t389s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A supplier with every field the form shows, a stored bank account number of 5555 and COD terms. */
async function supplier(f: Fixture, hint: string) {
  const name = `Stored Co ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  await asOrg(f.orgId, (tx) =>
    editSupplier(tx, f.admin, {
      supplierId: id,
      bankName: 'BDO',
      bankAccountName: 'Stored Acct',
      bankAccountNumber: '5555',
      email: 'stored@example.com',
      issuesOfficialReceipt: true,
      vatStatus: 'vat_registered',
      classification: 'corporate',
    }),
  );
  return { id, name };
}

const NOT_KEPT_HINT = 'The account number is not kept after a refused save. Check it before saving.';
const TERMS_BLANK = 'Days to pay is required.';

/** What the browser posts when the user changed the form and got it refused: credit terms with the days box blank. */
function refusedForm(s: { id: string }, over: Record<string, string | null> = {}): FormData {
  const base: Record<string, string> = {
    supplierId: s.id,
    name: 'Typed Supplier Name',
    representativeName: 'Typed Rep',
    contactNo: '0917 000 0000',
    email: 'typed@example.com',
    address: 'Typed Address',
    tin: '123-456-789',
    vatStatus: 'non_vat',
    classification: 'other',
    status: 'inactive',
    issuesOfficialReceiptPresent: '1', // the box is left UNticked: issuesOfficialReceipt is not sent
    termsMode: 'credit',
    creditTermsDays: '',
    bankName: 'Typed Bank',
    bankAccountName: 'Typed Acct Name',
    bankAccountNumber: '0012-3456-7',
    notes: 'Typed notes',
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) fd.set(k, v);
  return fd;
}

async function submit(f: Fixture, fd: FormData) {
  resetJar();
  h.actor = f.admin;
  const { editSupplierAction } = await import('../../src/app/ap/actions');
  const signal = await captureRedirect(() => editSupplierAction(fd));
  return { signal, outcome: outcomeOf(signal) };
}

type TypedCookie = { form: string; record: string; fields: Record<string, string | string[]> };
async function cookiePayload(): Promise<{ msg: Record<string, string>; keep: Record<string, string>; t?: TypedCookie; td?: { form: string; record: string } }> {
  const { decodeFlash } = await import('../../src/lib/flash');
  return decodeFlash(currentJar().get(FLASH_COOKIE)!.value) as never;
}

let SupplierDetailPage: typeof import('../../src/app/ap/suppliers/[id]/page').default;
beforeAll(async () => {
  SupplierDetailPage = (await import('../../src/app/ap/suppliers/[id]/page')).default;
  await import('../../src/app/ap/actions');
}, 120_000);

async function render(f: Fixture, supplierId: string, params: Record<string, string> = {}): Promise<string> {
  h.actor = f.admin;
  seen.records = [];
  const el = await SupplierDetailPage({ params: Promise.resolve({ id: supplierId }), searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(el as never);
}
const supplierRecord = (supplierId: string) =>
  seen.records.find((r) => (r.hidden as Record<string, string> | undefined)?.supplierId === supplierId) as { typed?: { kind?: string; fields?: Record<string, unknown>; hint?: string } | null } | undefined;
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The edit form's own <form>...</form> (the one holding the terms select). */
function editForm(html: string): string {
  const at = html.indexOf('name="termsMode"');
  expect(at, 'the supplier edit form is on the page').toBeGreaterThan(0);
  const start = html.lastIndexOf('<form', at);
  return html.slice(start, html.indexOf('</form>', at));
}
/** Is the <details> that wraps the edit form open? null = the form is not inside a <details> at all. */
function detailsOpen(html: string): boolean | null {
  const at = html.indexOf('name="termsMode"');
  const open = html.lastIndexOf('<details', at);
  if (open < 0 || html.lastIndexOf('</details>', at) > open) return null;
  return /\bopen\b/.test(html.slice(open, html.indexOf('>', open)));
}

describe('S1 supplier - a refused save keeps what was typed (DEF-617)', () => {
  it('W1: a refused save (no JavaScript, no __changed) puts every user-editable field in the typed slot - and NOT the account number, the ids or the hidden marker', async () => {
    const f = await fixture('w1');
    const s = await supplier(f, 'w1');
    const r = await submit(f, refusedForm(s));
    expect(r.outcome.flash.error, 'a refusal, not a save').toBe(TERMS_BLANK);
    const p = await cookiePayload();
    expect(p.t?.form).toBe('supplier.edit');
    expect(p.t?.record).toBe(s.id);
    expect(p.t?.fields).toEqual({
      name: 'Typed Supplier Name',
      representativeName: 'Typed Rep',
      contactNo: '0917 000 0000',
      email: 'typed@example.com',
      address: 'Typed Address',
      tin: '123-456-789',
      vatStatus: 'non_vat',
      classification: 'other',
      status: 'inactive',
      termsMode: 'credit',
      creditTermsDays: '',
      bankName: 'Typed Bank',
      bankAccountName: 'Typed Acct Name',
      notes: 'Typed notes',
    });
    expect(JSON.stringify(p), 'the account number is nowhere in the signed payload (Q1 = a)').not.toContain('0012-3456-7');
    expect(Object.keys(p.keep), 'no keep keys needed').toEqual([]);
    expect(decodeURIComponent(r.signal.url), 'nothing typed in the address').not.toMatch(/Typed|0012/);
    // Red on HEAD: the supplier action keeps nothing. Mutant: allow-list bankAccountNumber -> the payload leg is red.
  });

  it('W2: with the client __changed list only the changed names ride; an UNTICKED box is kept as an empty array so it reopens unticked', async () => {
    const f = await fixture('w2');
    const s = await supplier(f, 'w2');
    const fd = refusedForm(s);
    fd.set('__changed', 'name,vatStatus,issuesOfficialReceipt,termsMode,bankAccountNumber');
    const r = await submit(f, fd);
    expect(r.outcome.flash.error).toBe(TERMS_BLANK);
    const p = await cookiePayload();
    expect(p.t?.fields).toEqual({ name: 'Typed Supplier Name', vatStatus: 'non_vat', issuesOfficialReceipt: [], termsMode: 'credit' });
    expect(JSON.stringify(p)).not.toContain('0012-3456-7');
    expect(JSON.stringify(p), '__changed itself is never stored').not.toContain('__changed');
    // Mutant: ignore __changed -> the whole form rides, red. Skip absent-but-changed names -> issuesOfficialReceipt missing, red.
  });

  it('W3: the page reopens THIS supplier\'s record in edit mode, draws the STORED values, and hands the record the typing and the not-kept hint', async () => {
    const f = await fixture('w3');
    const s = await supplier(f, 'w3');
    const r = await submit(f, refusedForm(s));
    const p = await cookiePayload();
    const html = await render(f, s.id, pageParamsOf(r.signal.url));
    expect(plain(html), 'the refusal banner').toContain(TERMS_BLANK);
    const form = editForm(html);
    expect(form, 'reopened').not.toContain('<fieldset disabled');
    expect(form, 'Save is showing').toMatch(/<button[^>]*type="submit"[^>]*aria-label="Save"[^>]*>/); // T-448: Save is an icon button (words are aria-label + data-tip)
    expect(form, 'stored name drawn').toContain(`value="${s.name}"`);
    expect(form, 'stored account number drawn (the user sees what is on file)').toContain('value="5555"');
    for (const typed of ['Typed Supplier Name', 'Typed Rep', 'Typed Bank', 'Typed notes', '0012-3456-7']) {
      expect(html, `${typed} is never drawn by the server`).not.toContain(typed);
    }
    const rec = supplierRecord(s.id);
    expect(rec?.typed).toEqual({ kind: 'typed', fields: p.t!.fields, hint: NOT_KEPT_HINT });
    expect(plain(form), 'the hint is on the record').toContain(NOT_KEPT_HINT);
    expect(detailsOpen(html), 'the <details> around the form is open so the reopened record can be seen').toBe(true);
    // Red on HEAD: the record is locked, typed is undefined, the details stays closed.
    // Mutant: draw typed values as the defaults -> the "never drawn" loop is red. Drop the hint -> red.
  });

  it('W4: another supplier\'s page, given the same flash, stays locked with nothing typed and its details closed', async () => {
    const f = await fixture('w4');
    const a = await supplier(f, 'w4a');
    const b = await supplier(f, 'w4b');
    const r = await submit(f, refusedForm(a));
    const html = await render(f, b.id, pageParamsOf(r.signal.url));
    expect(editForm(html)).toContain('<fieldset disabled');
    expect(supplierRecord(b.id)?.typed ?? null).toBeNull();
    expect(detailsOpen(html)).toBe(false);
    // Mutant: typedFor ignores the record id -> B reopens with A's typing, red.
  });

  it('W5 (control, green on HEAD): with no flash the record is locked, nothing typed, the details closed', async () => {
    const f = await fixture('w5');
    const s = await supplier(f, 'w5');
    const html = await render(f, s.id);
    expect(editForm(html)).toContain('<fieldset disabled');
    expect(supplierRecord(s.id)?.typed ?? null).toBeNull();
    expect(detailsOpen(html)).toBe(false);
  });

  it('W6: typing too long to keep (a 5,000-character note): td in the cookie, no t; the page shows the sentence, the record stays locked with the stored values, details open', async () => {
    const f = await fixture('w6');
    const s = await supplier(f, 'w6');
    const r = await submit(f, refusedForm(s, { notes: 'LongNote-'.repeat(560) }));
    expect(r.outcome.flash.error).toBe(TERMS_BLANK);
    const p = await cookiePayload();
    expect(p.t).toBeUndefined();
    expect(p.td).toEqual({ form: 'supplier.edit', record: s.id, actor: f.admin.personId });
    const html = await render(f, s.id, pageParamsOf(r.signal.url));
    expect(editForm(html)).toContain('<fieldset disabled');
    expect(editForm(html)).toContain(`value="${s.name}"`);
    expect(plain(html)).toContain('What you typed was too long to keep. This shows what is saved. Press Edit and enter your change again.');
    expect(supplierRecord(s.id)?.typed).toEqual({ kind: 'dropped' });
    expect(detailsOpen(html), 'the sentence must be visible').toBe(true);
    expect(html).not.toContain('LongNote-');
  });

  it('W7 (control): a good save is unchanged - ok banner, nothing typed in the cookie, and the row is written', async () => {
    const f = await fixture('w7');
    const s = await supplier(f, 'w7');
    const r = await submit(f, refusedForm(s, { termsMode: 'cod', creditTermsDays: null, name: 'Renamed Co' }));
    expect(r.outcome.flash.error).toBeUndefined();
    expect(r.outcome.flash.ok).toBe('Supplier updated.');
    const p = await cookiePayload();
    expect(p.t).toBeUndefined();
    expect(p.td).toBeUndefined();
    const [row] = await sql<{ name: string }[]>`select name from suppliers where id = ${s.id}`;
    expect(row!.name).toBe('Renamed Co');
    // Mutant: keepTyping called on the success path -> t present, red.
  });

  it('W8: the refusal changed nothing in the database (the typed values are only in the cookie)', async () => {
    const f = await fixture('w8');
    const s = await supplier(f, 'w8');
    await submit(f, refusedForm(s));
    const [row] = await sql<{ name: string; bank_account_number: string | null }[]>`select name, bank_account_number from suppliers where id = ${s.id}`;
    expect(row).toEqual({ name: s.name, bank_account_number: '5555' });
  });
});

import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S6a (DEF-291) — the money-transfers account lists offer what the person can use.
 * `docs/tasks/369-unwired-money-screens.md` §S6, "BUILDER S6a" and tests T1–T3 (S6b/T4 wait for Q2 and T-367).
 *
 *   `apps/erp/src/app/money-transfers/lib.ts`: listTransferableAccounts(actor) — accounts ONLY at stores where
 *   the actor holds `transfer_funds` (a per-store `authorize` loop, once per distinct store).
 *
 * ⛔ TESTER, not BUILDER. Today the loader is `listTransferableAccounts(orgId: string)` and returns every
 * store's accounts, so a Lipa-only manager is offered Malvar's money and only the domain's submit-time check
 * (`transfer_funds` on BOTH ends) stops the transfer. Called with an ACTOR (the new signature), the old function
 * fails inside its first query — that crash IS the red for the loader legs; the page legs fail on the assertion
 * (Malvar's account ids are in the markup).
 *
 * Not written, and why: the spec's "no store qualifies -> \"You can't move money at any store.\"" leg. The route is
 * gated by `view_financial_reports` (manager+), the same population that holds `transfer_funds`, so a person who
 * reaches the page without it cannot be built without editing grants. Say if you want it via a revoked grant.
 *
 * Harness from `t369-s1-reimbursement-web.test.ts` (session mock, `Page` stub, real `requirePageAccess`, real domain).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  // T-448 A3: FormModal/Dialog read the address.
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called — fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/** Lipa and Malvar, each with its foundation accounts; manager (Lipa ONLY), admin (both), staff (Lipa). Both office safes funded. */
async function fixture(hint: string) {
  const code = uid(`t369s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const lipaId = await mkStore('Lipa');
  const malvarId = await mkStore('Malvar');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Lipa Manager', 'manager', [lipaId]);
  const adminId = await mk('Admin', 'admin', [lipaId, malvarId]);
  const accountsOf = async (storeId: string) => (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId}`).map((r) => r.id);
  const lipaAccounts = await accountsOf(lipaId);
  const malvarAccounts = await accountsOf(malvarId);
  const [lipaSafe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${lipaId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const [malvarSafe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${malvarId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fund'), idempotencyKey: uid('fund'), memo: 'fixture funding', postedBy: adminId,
      lines: [{ accountCode: '1130', storeId: lipaId, debit: '50000.00' }, { accountCode: '3900', storeId: lipaId, credit: '50000.00' }],
    }),
  );
  return {
    orgId, lipaId, malvarId, manager: actor(orgId, managerId), admin: actor(orgId, adminId),
    lipaAccounts, malvarAccounts, lipaSafeId: lipaSafe!.id, malvarSafeId: malvarSafe!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function load<T>(spec: () => Promise<T>, what: string): Promise<T> {
  try {
    return await spec();
  } catch (err) {
    throw new Error(`${what} does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
const loader = async () =>
  (await load(() => import('../../src/app/money-transfers/lib'), 'money-transfers/lib.ts')) as unknown as {
    listTransferableAccounts: (who: Actor) => Promise<{ id: string; storeId: string }[]>;
  };
async function renderPage(who: Actor): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await load(() => import('../../src/app/money-transfers/page'), 'money-transfers/page.tsx');
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) } as never)) as never);
}
async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
/** renderToStaticMarkup escapes quotes and ampersands (' becomes &#x27;); a sentence assertion must compare the DECODED text. */
const decodeEntities = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const param = (to: string, k: string) => paramsOf(to).get(k);
const transferRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${orgId}`)[0]!.n);

// -----------------------------------------------------------------------------------------------

describe('T1 — a Lipa-only manager is offered only Lipa\'s accounts', () => {
  it("the loader's result contains none of Malvar's accounts (and all of Lipa's) — red on HEAD: it takes an orgId and returns every store", async () => {
    const f = await fixture('t1');
    expect(f.malvarAccounts.length, 'fixture: Malvar has accounts').toBeGreaterThan(0);
    const { listTransferableAccounts } = await loader();

    const rows = await listTransferableAccounts(f.manager);
    const ids = rows.map((r) => r.id);
    for (const id of f.malvarAccounts) expect(ids, "another store's account was offered").not.toContain(id);
    for (const id of f.lipaAccounts) expect(ids, "Lipa's own account is missing").toContain(id);
    for (const r of rows) expect(r.storeId).toBe(f.lipaId);
  });

  it("the page's From/To pickers carry Lipa's account ids and not one of Malvar's", async () => {
    const f = await fixture('t1page');
    const html = await renderPage(f.manager);
    for (const id of f.lipaAccounts) expect(html, "Lipa's own account is missing from the page").toContain(id);
    for (const id of f.malvarAccounts) expect(html, `Malvar's account ${id} is offered to a Lipa-only manager`).not.toContain(id);
  });
});

describe('T2 — an admin (transfer_funds at both stores) is offered both', () => {
  it('the loader returns Lipa\'s AND Malvar\'s accounts; the page carries both sets', async () => {
    const f = await fixture('t2');
    const { listTransferableAccounts } = await loader();
    const ids = (await listTransferableAccounts(f.admin)).map((r) => r.id);
    for (const id of [...f.lipaAccounts, ...f.malvarAccounts]) expect(ids).toContain(id);

    const html = await renderPage(f.admin);
    for (const id of [...f.lipaAccounts, ...f.malvarAccounts]) expect(html).toContain(id);
  });
});

describe('T3 (✗ unchanged) — a forged POST naming Malvar by the Lipa manager is still refused by the domain', () => {
  it('Lipa office safe -> Malvar office safe: refused with a banner (no id), no transfer row — positive control: the admin posts the same transfer', async () => {
    const f = await fixture('t3');
    const { createMoneyTransferAction } = await load(() => import('../../src/app/money-transfers/actions'), 'money-transfers/actions.ts');
    const form = () => {
      const fd = new FormData();
      fd.set('fromMoneyAccountId', f.lipaSafeId);
      fd.set('toMoneyAccountId', f.malvarSafeId);
      fd.set('amountOut', '1000.00');
      fd.set('transferDate', '2026-01-10');
      return fd;
    };

    ACTOR_HOLDER.actor = f.manager;
    const refused = await expectRedirectTo(() => createMoneyTransferAction(form()));
    expect(param(refused, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(refused, 'ok')).toBeNull();
    expect(param(refused, 'error')).not.toMatch(UUID);
    expect(await transferRows(f.orgId)).toBe(0);

    ACTOR_HOLDER.actor = f.admin;
    const ok = await expectRedirectTo(() => createMoneyTransferAction(form()));
    expect(param(ok, 'error'), `the admin was refused: ${param(ok, 'error')}`).toBeNull();
    expect(await transferRows(f.orgId)).toBe(1);
  });
});

describe('no store qualifies — the page says so in words', () => {
  it('a staff member granted view_financial_reports (so the page opens) but holding transfer_funds nowhere: the loader returns [] and the page reads "You can\'t move money at any store." with no account ids', async () => {
    const f = await fixture('nostore');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Reader') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.lipaId})`;
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
              values (${p!.id}, 'view_financial_reports', ${f.admin.personId}, 'grant', ${f.lipaId})`;
    const reader = actor(f.orgId, p!.id);

    const { listTransferableAccounts } = await loader();
    expect(await listTransferableAccounts(reader), 'a person who cannot move money anywhere was offered accounts').toEqual([]);

    const html = await renderPage(reader);
    expect(html, 'the page is gated, not rendered').not.toMatch(/You do not have access to this screen/);
    expect(decodeEntities(html), 'SSR markup escapes the apostrophe; compare the decoded text').toContain("You can't move money at any store.");
    for (const id of [...f.lipaAccounts, ...f.malvarAccounts]) expect(html, `account ${id} is offered to someone who cannot use it`).not.toContain(id);
  });
});

describe('S6a retired and staff accounts — what is OFFERED at an allowed store', () => {
  it('a RETIRED account at an allowed store is not offered in the loader or in the From/To pickers — positive control: its active sibling is', async () => {
    const f = await fixture('retired');
    const [retired] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${f.orgId}, ${f.lipaId}, 'Old GCash', 'ewallet', '1120', 'cashier', false) returning id`;
    const [active] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${f.orgId}, ${f.lipaId}, 'New GCash', 'ewallet', '1120', 'cashier', true) returning id`;
    const { listTransferableAccounts } = await loader();

    const ids = (await listTransferableAccounts(f.manager)).map((r) => r.id);
    expect(ids, 'positive control: the active account is offered').toContain(active!.id);
    expect(ids, 'a retired account was offered (the domain refuses it at either end)').not.toContain(retired!.id);

    const html = await renderPage(f.manager);
    expect(html, 'positive control: the active account is on the page').toContain(active!.id);
    expect(html, 'a retired account is in the From/To pickers').not.toContain(retired!.id);
  });

  it("the store's staff float IS offered to a manager of that store (pin: a staff-custodian account is a valid end of a transfer)", async () => {
    const f = await fixture('stafffloat');
    const [floatAcct] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.lipaId} and custodian = 'staff' and is_foundation`;
    expect(floatAcct, 'fixture: Lipa has a staff float').toBeTruthy();
    const { listTransferableAccounts } = await loader();
    expect((await listTransferableAccounts(f.manager)).map((r) => r.id)).toContain(floatAcct!.id);
    expect(await renderPage(f.manager)).toContain(floatAcct!.id);
  });
});

// -----------------------------------------------------------------------------------------------
// S6b — T4 (Q2 = (a), Ian): another branch's money, offered in a folded group, only to people who may move it.
// docs/tasks/369-unwired-money-screens.md §S6 "BUILDER S6b".
//
// ## The shapes pinned here (the spec says only "the signature gains `actor`" and "`otherStoreSources`")
//   loadMoneyLines(orgId, storeId, actor)  ->  { sources, staff, otherStoreSources }
// `actor` is a THIRD, trailing argument so the existing callers' `loadMoneyLines(orgId, storeId)` in
// t358-ap-invoice-expense-form / t361-cod-credit-web-parity keep compiling and running; WITHOUT an actor
// `otherStoreSources` is `[]` (nobody is named, so nothing at another branch is offered). A different signature
// is a QUESTION to the tester, not a test edit.
//   `otherStoreSources` is a SourceOption[] of the accounts (same filter as `sources`: no aggregate staff-float row)
//   at every OTHER store where the actor holds `transfer_funds`; `sources` is unchanged (own store only, DEF-291).
//   The page copy is "Another branch — needs permission to move that branch's money" (T-266 §6.4).
//   `createExpenseAction` / `recordExpenseForInvoiceAction` re-fetch the sources server-side (`loadMoneyLines(…, actor)`),
//   so a hand-posted payload naming another branch's account is judged against the SAME list the page offered.
// -----------------------------------------------------------------------------------------------

/** s6 `fixture` + Naga (a third store the managers are NOT scoped to), a Lipa+Malvar manager, a funded Malvar safe,
 *  a verified Lipa supplier invoice dated 10 Jan (January open) and a COGS category. */
async function s6bFixture(hint: string) {
  const { seedExpenseCategories } = await import('../../../../packages/db/seed/expense-categories');
  const f = await fixture(hint);
  const [naga] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('Naga')}, 'Naga') returning id`;
  const nagaAccounts = (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${naga!.id}`).map((r) => r.id);
  const [two] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Lipa+Malvar Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${two!.id}, ${f.orgId}, 'manager')`;
  for (const s of [f.lipaId, f.malvarId]) await sql`insert into person_store_scope (person_id, store_id) values (${two!.id}, ${s})`;
  await seedExpenseCategories(sql, f.orgId);
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'manual_journal', sourceId: uid('fundm'), idempotencyKey: uid('fundm'), memo: 'fixture Malvar funding', postedBy: f.admin.personId,
      lines: [{ accountCode: '1130', storeId: f.malvarId, debit: '50000.00' }, { accountCode: '3900', storeId: f.malvarId, credit: '50000.00' }],
    }),
  );
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, 'Pork Co', ${f.admin.personId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.lipaId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.lipaId}/receipt_photo/${uid('r')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.admin.personId})
    returning id`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
                                   attested_supplier, attested_invoice, attested_items, attested_price)
    values (${f.orgId}, ${f.lipaId}, ${supplier!.id}, '2026-01-10', '99999999.00', 'verified', ${file!.id}, ${f.manager.personId}, now(), ${f.admin.personId}, true, true, true, true)
    returning id`;
  const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and category = 'Cost of Goods Sold — General'`;
  // the aggregate staff-float row is never a source (MoneyLines §7.3) - the accounts that ARE offered:
  const offerable = async (storeId: string) => (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and custodian <> 'staff'`).map((r) => r.id);
  return {
    ...f, nagaId: naga!.id, nagaAccounts, twoStore: actor(f.orgId, two!.id), supplierId: supplier!.id, invoiceId: inv!.id, categoryId: cat!.id,
    lipaOffered: await offerable(f.lipaId), malvarOffered: await offerable(f.malvarId),
  };
}
type S6bFixture = Awaited<ReturnType<typeof s6bFixture>>;

type OtherLoader = (orgId: string, storeId: string, who?: Actor) => Promise<{ sources: { id?: string; storeId?: string; kind: string }[]; otherStoreSources?: { id?: string; storeId?: string; kind: string }[] }>;
const moneyLinesLoader = async () =>
  (await load(() => import('../../src/lib/money-lines/load'), 'lib/money-lines/load.ts')).loadMoneyLines as unknown as OtherLoader;
const idsOf = (rows: { id?: string }[] | undefined) => (rows ?? []).map((r) => r.id);

describe('S6b T4 — the loader: the other-branch group holds only stores where the actor holds transfer_funds', () => {
  it("a Lipa+Malvar manager at Lipa: otherStoreSources = Malvar's accounts and nothing of Lipa's or Naga's; `sources` is still Lipa's own only (control) — red on HEAD: no `otherStoreSources`", async () => {
    const f = await s6bFixture('s6b-two');
    const loadMoneyLines = await moneyLinesLoader();
    const r = await loadMoneyLines(f.orgId, f.lipaId, f.twoStore);

    expect(Array.isArray(r.otherStoreSources), 'the loader returned no otherStoreSources').toBe(true);
    const other = idsOf(r.otherStoreSources);
    for (const id of f.malvarOffered) expect(other, "Malvar's account is missing from the other-branch group").toContain(id);
    for (const id of [...f.lipaAccounts, ...f.nagaAccounts]) expect(other, 'an account that does not belong in the group is in it').not.toContain(id);
    for (const s of r.otherStoreSources!) expect(s.storeId).toBe(f.malvarId);

    const own = idsOf(r.sources);
    for (const id of f.lipaOffered) expect(own, "positive control: Lipa's own account is still in `sources`").toContain(id);
    for (const id of [...f.malvarAccounts, ...f.nagaAccounts]) expect(own, "another branch's account leaked into `sources`").not.toContain(id);
  });

  it('a Lipa-ONLY manager (✗: no transfer_funds at Malvar): otherStoreSources is empty — positive control: `sources` still lists Lipa\'s own accounts', async () => {
    const f = await s6bFixture('s6b-one');
    const loadMoneyLines = await moneyLinesLoader();
    const r = await loadMoneyLines(f.orgId, f.lipaId, f.manager);

    expect(r.otherStoreSources, 'the loader returned no otherStoreSources (an empty list is the answer, not undefined)').toEqual([]);
    for (const id of f.lipaOffered) expect(idsOf(r.sources)).toContain(id);
    for (const id of f.malvarAccounts) expect(idsOf(r.sources)).not.toContain(id);
  });

  it("the admin (Lipa + Malvar, not Naga): Malvar's accounts yes, Naga's no (✗: a store without the grant is absent)", async () => {
    const f = await s6bFixture('s6b-admin');
    const loadMoneyLines = await moneyLinesLoader();
    const other = idsOf((await loadMoneyLines(f.orgId, f.lipaId, f.admin)).otherStoreSources);
    for (const id of f.malvarOffered) expect(other).toContain(id);
    for (const id of f.nagaAccounts) expect(other, "Naga's account is offered to someone with no transfer_funds there").not.toContain(id);
  });

  it('no actor passed: the existing two-argument call still works and offers no other-branch accounts', async () => {
    const f = await s6bFixture('s6b-noactor');
    const loadMoneyLines = await moneyLinesLoader();
    const r = await loadMoneyLines(f.orgId, f.lipaId);
    for (const id of f.lipaOffered) expect(idsOf(r.sources)).toContain(id);
    expect(r.otherStoreSources ?? [], 'accounts at another branch were offered to nobody in particular').toEqual([]);
  });
});

const expenseTables = async (orgId: string) => ({
  expenses: Number((await sql<{ n: string }[]>`select count(*)::text as n from expenses where org_id = ${orgId}`)[0]!.n),
  entries: Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n),
});
function recordForm(f: S6bFixture, accountId: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.lipaId);
  fd.set('supplierInvoiceId', f.invoiceId);
  fd.set('categoryId', f.categoryId);
  fd.set('particulars', 'Pork, paid from the other branch');
  fd.set('lineCount', '1');
  fd.set('lineMethod_0', 'cash');
  fd.set('lineAmount_0', '1200.00');
  fd.set('lineAccount_0', accountId);
  return fd;
}

describe("S6b T4 — an approval drawing from another branch's account posts, with transfer_funds checked at that branch", () => {
  it("the Lipa+Malvar manager records a Lipa expense paid from Malvar's office safe -> no error banner; the expense is posted; the safe is credited AT MALVAR — red on HEAD: the server-side sources list refuses the account", async () => {
    const f = await s6bFixture('s6b-post');
    const { recordExpenseForInvoiceAction } = await load(() => import('../../src/app/expenses/actions'), 'expenses/actions.ts');

    ACTOR_HOLDER.actor = f.twoStore;
    const to = await expectRedirectTo(() => recordExpenseForInvoiceAction(recordForm(f, f.malvarSafeId)));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await expenseTables(f.orgId)).toEqual({ expenses: 1, entries: 1 });
    const credits = await sql<{ store_id: string; credit: string }[]>`
      select jl.store_id, jl.credit::text from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.source_type = 'expense_payment' and a.code = '1130' and jl.credit > 0`;
    expect(credits, "Malvar's safe was not credited").toEqual([{ store_id: f.malvarId, credit: '1200.00' }]);
  });

  it("✗ the Lipa-ONLY manager names Malvar's safe in the same form -> refused with a banner (no id); no expense, no entry — positive control: the Lipa+Malvar manager posts the same form (previous test); the Lipa-only manager's OWN safe posts", async () => {
    const f = await s6bFixture('s6b-deny');
    const { recordExpenseForInvoiceAction } = await load(() => import('../../src/app/expenses/actions'), 'expenses/actions.ts');

    ACTOR_HOLDER.actor = f.manager;
    const refused = await expectRedirectTo(() => recordExpenseForInvoiceAction(recordForm(f, f.malvarSafeId)));
    expect(param(refused, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(refused, 'error')).not.toMatch(UUID);
    expect(await expenseTables(f.orgId)).toEqual({ expenses: 0, entries: 0 });

    const own = await expectRedirectTo(() => recordExpenseForInvoiceAction(recordForm(f, f.lipaSafeId)));
    expect(param(own, 'error'), `the own-branch control was refused: ${param(own, 'error')}`).toBeNull();
    expect(await expenseTables(f.orgId)).toEqual({ expenses: 1, entries: 1 });
  });

  it('the draft path judges the same list: createExpenseAction by the Lipa+Malvar manager with a Malvar account makes a draft; by the Lipa-only manager it is refused — red on HEAD (first half)', async () => {
    const f = await s6bFixture('s6b-draft');
    const { createExpenseAction } = await load(() => import('../../src/app/expenses/actions'), 'expenses/actions.ts');

    ACTOR_HOLDER.actor = f.manager;
    const refused = await expectRedirectTo(() => createExpenseAction(recordForm(f, f.malvarSafeId)));
    expect(param(refused, 'error'), 'a refusal banner').toBeTruthy();
    expect((await expenseTables(f.orgId)).expenses).toBe(0);

    ACTOR_HOLDER.actor = f.twoStore;
    const ok = await expectRedirectTo(() => createExpenseAction(recordForm(f, f.malvarSafeId)));
    expect(param(ok, 'error'), `refused: ${param(ok, 'error')}`).toBeNull();
    expect((await expenseTables(f.orgId)).expenses).toBe(1);
  });
});

describe('S6b T4 (render) — the folded "Another branch" group on the two screens that mount <MoneyLines>', () => {
  const NEED = "needs permission to move that branch's money";
  async function newExpenseHtml(who: Actor, f: S6bFixture): Promise<string> {
    ACTOR_HOLDER.actor = who;
    const { default: Page } = await load(() => import('../../src/app/expenses/new/page'), 'expenses/new/page.tsx');
    return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: f.lipaId }) } as never)) as never);
  }
  async function invoiceHtml(who: Actor, f: S6bFixture): Promise<string> {
    ACTOR_HOLDER.actor = who;
    const { default: Page } = await load(() => import('../../src/app/ap/invoices/[id]/page'), 'ap/invoices/[id]/page.tsx');
    return renderToStaticMarkup((await Page({ params: Promise.resolve({ id: f.invoiceId }), searchParams: Promise.resolve({}) } as never)) as never);
  }

  for (const [name, render] of [['/expenses/new', newExpenseHtml], ['/ap/invoices/[id]', invoiceHtml]] as const) {
    it(`${name}: the Lipa+Malvar manager's page carries the group and Malvar's account ids; the Lipa-only manager's carries neither — positive control: both pages carry Lipa's own account ids`, async () => {
      const f = await s6bFixture(`s6b-render-${name.length}`);

      const two = decodeEntities(await render(f.twoStore, f));
      expect(two, 'no "Another branch" group').toContain('Another branch');
      expect(two, 'the group does not say why it is folded').toContain(NEED);
      for (const id of f.malvarOffered) expect(two, `Malvar's account ${id} is not offered`).toContain(id);
      for (const id of f.nagaAccounts) expect(two, "Naga's account is offered with no grant there").not.toContain(id);
      for (const id of f.lipaOffered) expect(two, 'positive control: own-branch account missing').toContain(id);

      const one = decodeEntities(await render(f.manager, f));
      for (const id of f.lipaOffered) expect(one, 'positive control: own-branch account missing').toContain(id);
      expect(one, 'a Lipa-only manager is shown the group').not.toContain('Another branch');
      expect(one).not.toContain(NEED);
      for (const id of f.malvarAccounts) expect(one, `Malvar's account ${id} is offered to a Lipa-only manager`).not.toContain(id);
    });
  }
});

describe("S6b audit — another branch's options say which branch they are at", () => {
  it('two branches each with an account named "Office safe": the options differ by store name ("Office safe — Malvar" for the other branch; the own branch\'s is unsuffixed)', async () => {
    const f = await s6bFixture('s6b-names');
    await sql`update money_accounts set name = 'Office safe' where id in (${f.malvarSafeId}, ${f.lipaSafeId})`;
    ACTOR_HOLDER.actor = f.twoStore;
    const { default: Page } = await load(() => import('../../src/app/expenses/new/page'), 'expenses/new/page.tsx');
    const html = decodeEntities(renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: f.lipaId }) } as never)) as never));
    const option = (id: string) => (html.match(new RegExp(`<option[^>]*value="account:${id}"[^>]*>([^<]*)</option>`)) ?? [])[1];
    const other = option(f.malvarSafeId);
    const own = option(f.lipaSafeId);
    expect(other, "Malvar's option is missing").toBeTruthy();
    expect(own, "Lipa's option is missing").toBeTruthy();
    expect(other).toContain('Office safe — Malvar');
    expect(own).not.toContain('Malvar');
    expect(other).not.toEqual(own);
  });
});

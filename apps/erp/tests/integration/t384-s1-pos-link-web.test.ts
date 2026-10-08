import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-384 S1b (TESTER) - the POS link screen on the lock-and-edit pattern.
 * `docs/tasks/384-pos-link-tenders-and-width.md` Amendment A0 (L1-L7), S1 R2-R9, S1b W1-W8, Invariants I3.
 * Bible rows 288 (full width) and 289 (Edit/Save lock; commands keep their verb). DEF-611, DEF-612, DEF-617.
 *
 * Real Postgres + real domain; session, navigation, cookie jar and the Page shell doubled (harness: t384-s1b-min,
 * t382-s3-unlink-web). Only POS's payment-methods call is stubbed (`h.methods`; null = POS not answering).
 *
 *  W1 add form: "Add a tender", Kind blank + required, ends in "Save", not inside an EditableRecord  (R4, L4)
 *  W2 money-account selects offer only bank / e-wallet accounts, never a cash drawer                  (R6, DEF-611)
 *  W3 refusal / ok render ON the store's card, top banner only when no card matches                   (R7, DEF-612)
 *  W4 ok sentences name the tender                                                                    (R7)
 *  W5 the POS method -> tender -> account mapping table                                               (R9)
 *  W6 every tender is an EditableRecord: locked, one Edit, version outside the fieldset               (A0 L1, L6)
 *  W7 Kind is correctable in place from the form                                                      (R5)
 *  W8 a blank POS name clears the alias and the row then reads "No POS name"                          (R8)
 *  L  layout: no fixed widths, FormGrid used                                                          (rows 288, G3/G4/G7/G8)
 *  X  DEF-617: a refused save keeps the typed values and reopens the record in edit mode, never in the URL
 * Each test names its killing mutant. Several are green on HEAD by design (controls); the red ones say why.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({
  actor: null as null | { personId: string; orgId: string },
  /** POS's payment methods for the linked store; null = POS is not answering. */
  methods: null as string[] | null,
}));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@shareat/domain', async (orig) => {
  const real = await orig<typeof import('@shareat/domain')>();
  return {
    ...real,
    fetchPosV1PaymentMethods: async () => {
      if (h.methods === null) throw new Error('POS is not answering');
      return h.methods;
    },
  };
});

import * as D from '@shareat/domain';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { s6Fixture } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import PosLinkSettingsPage from '../../src/app/settings/pos-link/page';
import { captureRedirect, outcomeOf, pageParamsOf, resetJar, seedSearch } from '../helpers/flash-jar';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const STALE = 'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';
const NEED_KIND = 'Choose whether this tender is cash or a wallet.';
const POS_METHODS = ['Bank Transfer', 'Cash', 'Gcash', 'QRPH'];

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let seq = 0;
const code = (p: string) => `${p}-${Date.now()}-${++seq}`;

/**
 * Org with THREE stores:
 *  - Lipa   (s6Fixture): LINKED. Cash (cash), GCash (wallet -> "GCash - Lipa", alias GCash) + a cash drawer account,
 *           BPI (bank), and two more wallets: Bank Transfer and QRPH, both -> BPI (D4: BPI shared by two).
 *  - Other  : NOT linked, with the same four tenders on its own accounts.
 *  - Bare   : NOT linked, only a cash drawer account (no bank or e-wallet account at all).
 */
async function fixture(hint: string) {
  const base = await s6Fixture(sql, `t384s1w-${hint}`);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${base.orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${base.orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${base.storeId})`;
  const superAdmin = { personId: p!.id, orgId: base.orgId };

  const acct = async (storeId: string, name: string, instrument: 'cash' | 'bank' | 'ewallet', custodian: 'cashier' | 'office' | 'staff', gl: string) =>
    (await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${base.orgId}, ${storeId}, ${name}, ${instrument}, ${gl}, ${custodian}) returning id`)[0]!.id;
  const tender = async (storeId: string, name: string, kind: 'cash' | 'wallet', accountId: string | null, alias: string | null) =>
    (await sql<{ id: string }[]>`
      insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias)
      values (${base.orgId}, ${storeId}, ${name}, ${kind}, ${accountId}, ${alias}) returning id`)[0]!.id;

  const drawer = await acct(base.storeId, 'Cashier drawer', 'cash', 'cashier', '1110');
  const bpi = await acct(base.storeId, 'BPI', 'bank', 'office', '1120');
  const bankTender = await tender(base.storeId, 'Bank Transfer', 'wallet', bpi, 'Bank Transfer');
  const qrTender = await tender(base.storeId, 'QRPH', 'wallet', bpi, 'QRPH');

  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${base.orgId}, ${code('st')}, ${name}) returning id`)[0]!.id;
  const otherId = await mkStore('Other');
  const otherBpi = await acct(otherId, 'BPI Other', 'bank', 'office', '1120');
  const otherGcash = await acct(otherId, 'GCash Other', 'ewallet', 'cashier', '1140');
  await tender(otherId, 'Cash', 'cash', null, 'Cash');
  await tender(otherId, 'Gcash', 'wallet', otherGcash, 'Gcash');
  await tender(otherId, 'Bank Transfer', 'wallet', otherBpi, 'Bank Transfer');
  await tender(otherId, 'QRPH', 'wallet', otherBpi, 'QRPH');
  const bareId = await mkStore('Bare');
  await acct(bareId, 'Bare drawer', 'cash', 'cashier', '1110');
  // Creating a store seeds "Cashier online" / "Office online" (ewallet): retire them (through the domain) so Bare has no
  // bank or e-wallet account and the empty state is reachable.
  const seeded = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${bareId} and instrument <> 'cash' and is_active`;
  // The domain refuses to retire a foundation account while the store trades, so the store is paused around the retire.
  await sql`update stores set is_active = false where id = ${bareId}`;
  for (const a of seeded) await asOrg(base.orgId, (tx) => D.retireMoneyAccount(tx, superAdmin, { moneyAccountId: a.id }));
  await sql`update stores set is_active = true where id = ${bareId}`;

  return { ...base, superAdmin, drawer, bpi, bankTender, qrTender, otherId, bareId };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function repoVersion(tenderId: string): Promise<string> {
  const [r] = await sql<{ v: string }[]>`select (extract(epoch from coalesce(updated_at, created_at)) * 1000000)::bigint::text as v from tenders where id = ${tenderId}`;
  return r!.v;
}
const tenderRow = async (id: string) =>
  (await sql<{ name: string; kind: string; money_account_id: string | null; pos_v1_alias: string | null; is_active: boolean }[]>`
    select name, kind, money_account_id, pos_v1_alias, is_active from tenders where id = ${id}`)[0]!;
const tenderCount = async (storeId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from tenders where store_id = ${storeId}`)[0]!.n);

const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();

async function render(f: F, params: Record<string, string> = {}, methods: string[] | null = null): Promise<string> {
  h.actor = f.superAdmin;
  h.methods = methods;
  const el = await PosLinkSettingsPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(el as never);
}

/** The markup of one store's card: from its <section id="store-ID"> to the next card (or the end). */
function cardOf(html: string, storeId: string): string {
  const start = html.indexOf(`<section id="store-${storeId}"`);
  if (start < 0) return '';
  const next = html.indexOf('<section id="store-', start + 10);
  return html.slice(start, next < 0 ? undefined : next);
}
const hiddenValue = (body: string, n: string): string | undefined => {
  for (const m of body.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    if (!/type="hidden"/.test(tag) || !new RegExp(`name="${n}"`).test(tag)) continue;
    return /value="([^"]*)"/.exec(tag)?.[1];
  }
  return undefined;
};
/** The tender's own record form: the <form> carrying its tenderId and no isActive (not the Retire / Restore form). */
function recordForm(card: string, tenderId: string): string | undefined {
  for (const chunk of card.split('<form').slice(1)) {
    const body = chunk.split('</form>')[0]!;
    if (hiddenValue(body, 'tenderId') === tenderId && hiddenValue(body, 'isActive') === undefined) return body;
  }
  return undefined;
}
/** The "Add a tender" box: everything after its heading, within the card. */
function addBox(card: string): string {
  const i = card.indexOf('Add a tender');
  expect(i, 'the card has an "Add a tender" heading (R3)').toBeGreaterThanOrEqual(0);
  return card.slice(i);
}
const selectOf = (markup: string, name: string): string | null =>
  new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?</select>`).exec(markup)?.[0] ?? null;
const formWith = (card: string, fieldName: string): string | undefined =>
  card.split('<form').slice(1).map((c) => c.split('</form>')[0]!).find((b) => new RegExp(`name="${fieldName}"`).test(b));

type ActionFn = (fd: FormData) => Promise<void>;
type Acts = Record<'createTenderAction' | 'updateTenderAction' | 'setTenderActiveAction', ActionFn>;
async function act(name: keyof Acts, who: F['superAdmin'], fields: Record<string, string>) {
  resetJar();
  h.actor = who;
  const mod = (await import('../../src/app/settings/pos-link/actions')) as unknown as Acts;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const signal = await captureRedirect(() => mod[name](fd));
  return { signal, outcome: outcomeOf(signal) };
}

const PAGE_SRC = readFileSync(resolve(__dirname, '..', '..', 'src', 'app', 'settings', 'pos-link', 'page.tsx'), 'utf8');

beforeAll(async () => {
  await import('../../src/app/settings/pos-link/actions');
}, 120_000);

// ---------------------------------------------------------------------------------------------------------------
describe('W1 - the add form (R4, L4)', () => {
  it('W1a: headed "Add a tender", ends in exactly "Save", and is not inside any EditableRecord', async () => {
    const f = await fixture('w1a');
    const add = addBox(cardOf(await render(f), f.storeId));
    expect(add, 'the submit reads exactly Save (L4)').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(plain(add)).not.toMatch(/Add tender/);
    expect(add, 'an add form is not a locked record').not.toContain('<fieldset disabled');
    // Red on HEAD: no "Add a tender" heading (the form is headed by a label "New tender") and the button reads "Add tender".
    // Mutant: put the add form inside an EditableRecord -> `<fieldset disabled`, red.
  });

  it('W1b: Kind starts blank (no default Cash) and is required', async () => {
    const f = await fixture('w1b');
    const sel = selectOf(addBox(cardOf(await render(f), f.storeId)), 'kind');
    expect(sel, 'the add form has a kind select').not.toBeNull();
    expect(sel!, 'required').toMatch(/<select\b[^>]*\brequired/);
    const first = /<option\b[^>]*>/.exec(sel!)![0];
    expect(first, 'the first option is the blank "Choose" one').toMatch(/value=""/);
    expect(first, 'and it is the selected one').toMatch(/\bselected/);
    expect(plain(sel!)).toMatch(/Choose cash or wallet/);
    expect(sel!, 'Cash is not the pre-selected option').not.toMatch(/<option[^>]*value="cash"[^>]*selected/);
    // Red on HEAD: `defaultValue="cash"` -> option value="cash" selected, no required, no blank option.
    // Mutant: restore defaultValue="cash" -> red.
  });

  it('W1c: its hint tells the user to leave the account blank for cash', async () => {
    const f = await fixture('w1c');
    expect(plain(addBox(cardOf(await render(f), f.storeId)))).toContain('Leave it blank for cash');
  });

  it('W1d (control, green on HEAD): createTenderAction with kind "" is refused with the domain sentence and creates no row', async () => {
    const f = await fixture('w1d');
    const before = await tenderCount(f.storeId);
    const r = await act('createTenderAction', f.superAdmin, { storeId: f.storeId, name: 'Maya', kind: '', moneyAccountId: '', posV1Alias: 'Maya' });
    expect(r.outcome.flash.error).toBe(NEED_KIND);
    expect(r.outcome.flash.ok).toBeUndefined();
    expect(await tenderCount(f.storeId)).toBe(before);
    expect(r.signal.url, 'the refusal lands on the store card (R7)').toMatch(new RegExp(`#store-${f.storeId}$`));
    // Mutant: restore `kind === 'wallet' ? 'wallet' : 'cash'` -> a Cash tender "Maya" is created, red.
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W2 - only accounts a wallet can use (R6, DEF-611)', () => {
  it('W2a: every money-account select on the card lists BPI and never the cash drawer', async () => {
    const f = await fixture('w2a');
    const card = cardOf(await render(f), f.storeId);
    const selects = [...card.matchAll(/<select\b[^>]*\bname="moneyAccountId"[^>]*>[\s\S]*?<\/select>/g)].map((m) => m[0]);
    expect(selects.length, 'the card has money-account selects (add form at least)').toBeGreaterThan(0);
    for (const s of selects) {
      expect(plain(s), 'a cash drawer is not a wallet account').not.toContain('Cashier drawer');
    }
    expect(plain(selectOf(addBox(card), 'moneyAccountId') ?? ''), 'the add form offers the bank account').toContain('BPI');
    // Red on HEAD: `listMoneyAccounts` is unfiltered, so "Cashier drawer" is offered. Mutant: drop the instrument filter -> red.
  });

  it('W2b: the label reads "Money account (wallets only)" with the sharing hint', async () => {
    const f = await fixture('w2b');
    const text = plain(addBox(cardOf(await render(f), f.storeId)));
    expect(text).toContain('Money account (wallets only)');
    expect(text).toContain('Two wallets may pay into the same account');
  });

  it('W2c: a store with no bank or e-wallet account says so and links to /money-accounts', async () => {
    const f = await fixture('w2c');
    const card = cardOf(await render(f), f.bareId);
    expect(plain(card)).toContain('Bare has no bank or e-wallet account yet. Add one under Money accounts first.');
    expect(card).toMatch(/<a\b[^>]*href="\/money-accounts"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W3 - feedback lands on the store card (R7, DEF-612)', () => {
  const head = (html: string) => plain(html.slice(0, html.indexOf('<section id="store-')));

  it("W3a: an error for store A renders inside A's card with role=alert, not at the top and not on another card", async () => {
    const f = await fixture('w3a');
    const sentence = 'A wallet tender needs the money account it pays into.';
    const params = await seedSearch({ store: f.storeId, error: sentence });
    const html = await render(f, params);
    const card = cardOf(html, f.storeId);
    expect(plain(card)).toContain(sentence);
    expect(card).toMatch(/role="alert"/);
    expect(plain(cardOf(html, f.otherId)), "not on another store's card").not.toContain(sentence);
    expect(head(html), 'no top banner when a card matches').not.toContain(sentence);
    // Red on HEAD: the sentence is in the top banner only. Mutant: render it in both places -> the head leg is red.
  });

  it("W3b: an ok for store A renders inside A's card with role=status", async () => {
    const f = await fixture('w3b');
    const params = await seedSearch({ store: f.storeId, ok: 'Gcash saved.' });
    const html = await render(f, params);
    const card = cardOf(html, f.storeId);
    expect(plain(card)).toContain('Gcash saved.');
    expect(card).toMatch(/role="status"/);
    expect(head(html)).not.toContain('Gcash saved.');
  });

  it('W3c (control, green on HEAD): an error with no matching store still shows in the top banner', async () => {
    const f = await fixture('w3c');
    const sentence = 'Something general went wrong.';
    const html = await render(f, await seedSearch({ error: sentence }));
    expect(head(html)).toContain(sentence);
    expect(plain(cardOf(html, f.storeId))).not.toContain(sentence);
  });

  it('W3d (control, green on HEAD): a refused create redirects to #store-<that store>, with no typed value in the URL', async () => {
    const f = await fixture('w3d');
    const r = await act('createTenderAction', f.superAdmin, { storeId: f.otherId, name: 'Maya', kind: '' });
    expect(r.signal.url.endsWith(`#store-${f.otherId}`)).toBe(true);
    expect(r.signal.url, 'I3: no typed value in the URL').not.toContain('Maya');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W4 - every ok sentence names the tender (R7)', () => {
  it('W4: "Maya added.", "<new name> saved.", "<name> retired.", "<name> restored."', async () => {
    const f = await fixture('w4');
    const add = await act('createTenderAction', f.superAdmin, {
      storeId: f.storeId, name: 'Maya', kind: 'wallet', moneyAccountId: f.bpi, posV1Alias: 'Maya',
    });
    expect(add.outcome.flash.error).toBeUndefined();
    expect(add.outcome.flash.ok).toBe('Maya added.');

    const v0 = await repoVersion(f.bankTender);
    const saved = await act('updateTenderAction', f.superAdmin, {
      storeId: f.storeId, tenderId: f.bankTender, version: v0, name: 'Bank Xfer', kind: 'wallet', moneyAccountId: f.bpi, posV1Alias: 'Bank Transfer',
    });
    expect(saved.outcome.flash.ok, 'the name is read back from the saved row, not trusted from the form').toBe('Bank Xfer saved.');

    const v1 = await repoVersion(f.bankTender);
    const ret = await act('setTenderActiveAction', f.superAdmin, { storeId: f.storeId, tenderId: f.bankTender, version: v1, isActive: 'false' });
    expect(ret.outcome.flash.ok).toBe('Bank Xfer retired.');
    const v2 = await repoVersion(f.bankTender);
    const res = await act('setTenderActiveAction', f.superAdmin, { storeId: f.storeId, tenderId: f.bankTender, version: v2, isActive: 'true' });
    expect(res.outcome.flash.ok).toBe('Bank Xfer restored.');
    // Red on HEAD: the sentences are "Tender added." / "Tender saved." / "Tender retired." / "Tender restored.".
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("W5 - how POS's payment methods land (R9)", () => {
  const rowsOf = (card: string): string[][] => {
    const table = /<table\b[\s\S]*?<\/table>/.exec(card)?.[0] ?? '';
    return table
      .split('<tr')
      .slice(1)
      .filter((r) => /<td/.test(r))
      .map((r) => [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => plain(m[1]!)));
  };

  it('W5a: linked, POS lists Bank Transfer, Cash, Gcash, QRPH -> 4 rows, each Mapped, with tender and account (BPI twice)', async () => {
    const f = await fixture('w5a');
    const card = cardOf(await render(f, {}, POS_METHODS), f.storeId);
    expect(plain(card)).toContain('POS method');
    const rows = rowsOf(card).map((r) => r.join(' | '));
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toMatch(/\bMapped\b/);
      expect(r, 'no row is Not mapped').not.toMatch(/Not mapped/);
    }
    expect(rows.find((r) => r.startsWith('Gcash')), 'matched regardless of case: POS "Gcash" -> tender "GCash"').toMatch(/GCash.*GCash - Lipa/);
    expect(rows.filter((r) => r.includes('BPI')), 'BPI shared by Bank Transfer and QRPH').toHaveLength(2);
    // Red on HEAD: no table.
  });

  it("W5b: QRPH's POS name blank -> the QRPH row reads Not mapped and says days cannot be imported", async () => {
    const f = await fixture('w5b');
    await sql`update tenders set pos_v1_alias = null where id = ${f.qrTender}`;
    const rows = rowsOf(cardOf(await render(f, {}, POS_METHODS), f.storeId)).map((r) => r.join(' | '));
    const qr = rows.find((r) => r.startsWith('QRPH'));
    expect(qr, 'POS still lists QRPH, so it still has a row').toBeDefined();
    expect(qr!).toContain('Not mapped');
    expect(qr!).toContain('days that use it cannot be imported');
    expect(rows.filter((r) => /\bMapped\b/.test(r) && !/Not mapped/.test(r))).toHaveLength(3);
  });

  it('W5c: not linked -> one row per active tender, plus the note', async () => {
    const f = await fixture('w5c');
    const card = cardOf(await render(f, {}, POS_METHODS), f.otherId);
    expect(rowsOf(card)).toHaveLength(4);
    expect(plain(card)).toContain(
      "POS's payment methods are listed here once Other is linked. Make each tender's POS name exactly what POS shows.",
    );
  });

  it('W5d: the old amber "POS methods not mapped yet" box is gone (the status column replaces it)', async () => {
    const f = await fixture('w5d');
    await sql`update tenders set pos_v1_alias = null where id = ${f.qrTender}`;
    expect(plain(cardOf(await render(f, {}, POS_METHODS), f.storeId))).not.toContain('POS methods not mapped yet');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W6 - every tender is an EditableRecord (A0 L1, L2, L6)', () => {
  it('W6a: each active tender: fieldset disabled around its fields, one Edit button, no visible Save, no Retire while locked', async () => {
    const f = await fixture('w6a');
    const card = cardOf(await render(f), f.storeId);
    for (const [id, label] of [[f.cashTenderId, 'Cash'], [f.walletTenderId, 'GCash'], [f.bankTender, 'Bank Transfer'], [f.qrTender, 'QRPH']] as const) {
      const form = recordForm(card, id);
      expect(form, `${label} has its own record form`).toBeDefined();
      expect(form!, `${label}: truly disabled, not just styled`).toContain('<fieldset disabled');
      expect(form!.match(/aria-label="Edit [^"]*"/g) ?? [], `${label}: exactly one Edit button`).toHaveLength(1);
      expect(form!).toContain(`aria-label="Edit ${label}"`);
      expect(form!, `${label}: no Save while locked`).not.toMatch(/<button[^>]*type="submit"/);
      expect(plain(form!)).not.toContain('Retire');
    }
    // Red on HEAD: no fieldset, a live Save button, no Edit. Mutant: render the tender form bare -> red.
  });

  it("W6b: the hidden version equals the repo's and sits OUTSIDE the fieldset (a disabled input would not post)", async () => {
    const f = await fixture('w6b');
    const card = cardOf(await render(f), f.storeId);
    for (const id of [f.cashTenderId, f.walletTenderId, f.bankTender, f.qrTender]) {
      const form = recordForm(card, id)!;
      expect(form).toBeDefined();
      const field = form.indexOf('<fieldset');
      const ver = form.search(/<input[^>]*name="version"/);
      expect(field, 'the record is in a fieldset').toBeGreaterThanOrEqual(0);
      expect(ver, 'a version input').toBeGreaterThanOrEqual(0);
      expect(ver, 'the version input comes before the fieldset').toBeLessThan(field);
      expect(form.slice(field), 'and not inside it').not.toMatch(/name="version"/);
      expect(hiddenValue(form, 'version')).toBe(await repoVersion(id));
      expect(hiddenValue(form, 'storeId')).toBe(f.storeId);
    }
  });

  it('W6c: the page wires updateTenderAction through EditableRecord with Retire as its `extra` (source)', () => {
    expect(PAGE_SRC).toMatch(/from ['"]@\/components\/forms['"]|from ['"]@\/components\/forms\/EditableRecord['"]/);
    expect(PAGE_SRC).toMatch(/<EditableRecord[\s\S]{0,600}action=\{updateTenderAction\}/);
    expect(PAGE_SRC, 'Retire is an extra of the record (shown only while editing)').toMatch(/extra=\{[\s\S]{0,900}setTenderActiveAction/);
    expect(PAGE_SRC).toMatch(/Retire/);
    expect(PAGE_SRC, 'the version rides in `hidden` (L6)').toMatch(/hidden=\{\{[^}]*version/);
    expect(PAGE_SRC, 'keyed id:version so a changed row remounts from the database (R2)').toMatch(/key=\{`\$\{[a-zA-Z.]*id\}:\$\{[a-zA-Z.]*version\}`\}/);
  });

  it("W6d: the store's link form is an EditableRecord once linked; an unlinked store's is an add form ending in Save", async () => {
    const f = await fixture('w6d');
    const html = await render(f);
    const linkForm = formWith(cardOf(html, f.storeId), 'posTaxType');
    expect(linkForm, 'the link form is present').toBeDefined();
    expect(linkForm!, 'linked: locked').toContain('<fieldset disabled');
    expect(linkForm!).toMatch(/aria-label="Edit [^"]*"/);
    const addLink = formWith(cardOf(html, f.otherId), 'posTaxType');
    expect(addLink, 'the unlinked store still shows its link form').toBeDefined();
    expect(addLink!).not.toContain('<fieldset disabled');
    expect(addLink!, 'L4: ends in Save').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(plain(addLink!)).not.toMatch(/Link store|Save link/);
  });

  it('W6e: Retired tenders sit in a closed <details>, each with Restore (a command: keeps its verb), version attached', async () => {
    const f = await fixture('w6e');
    await sql`update tenders set is_active = false, updated_at = now() where id = ${f.qrTender}`;
    const card = cardOf(await render(f), f.storeId);
    const det = /<details\b(?![^>]*\bopen\b)[^>]*>[\s\S]*?<\/details>/.exec(card)?.[0];
    expect(det, 'a closed <details> for retired tenders').toBeDefined();
    expect(plain(det!)).toMatch(/Retired tenders \(1\)/);
    expect(plain(det!)).toContain('Restore');
    expect(det!, 'Restore is not a locked field').not.toContain('<fieldset disabled');
    expect(det!).toContain(`value="${await repoVersion(f.qrTender)}"`);
    expect(card.slice(0, card.indexOf('Retired tenders')), 'the retired one is not in the active list').not.toContain('aria-label="Edit QRPH"');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W7 - Kind can be corrected in place (R3, R5)', () => {
  it('W7a: the edit form shows Name, Kind, Money account and POS name, inside the fieldset', async () => {
    const f = await fixture('w7a');
    const form = recordForm(cardOf(await render(f), f.storeId), f.cashTenderId)!;
    expect(form).toBeDefined();
    expect(form.indexOf('<fieldset'), 'the fields are in a fieldset').toBeGreaterThanOrEqual(0);
    const inside = form.slice(form.indexOf('<fieldset'));
    for (const n of ['name', 'kind', 'moneyAccountId', 'posV1Alias']) {
      expect(inside, `${n} is in the fieldset`).toMatch(new RegExp(`name="${n}"`));
    }
    expect(selectOf(inside, 'kind'), "the cash tender's kind reads cash").toMatch(/<option[^>]*value="cash"[^>]*selected/);
    const accts = plain(selectOf(inside, 'moneyAccountId') ?? '');
    expect(accts, 'a cash tender can still be switched to a wallet: accounts offered').toContain('BPI');
    expect(accts).not.toContain('Cashier drawer');
  });

  it('W7b (control, green on HEAD): kind wallet + BPI on a cash tender -> ok and the row is a wallet', async () => {
    const f = await fixture('w7b');
    const r = await act('updateTenderAction', f.superAdmin, {
      storeId: f.storeId, tenderId: f.cashTenderId, version: await repoVersion(f.cashTenderId), name: 'Cash', kind: 'wallet', moneyAccountId: f.bpi, posV1Alias: 'Cash',
    });
    expect(r.outcome.flash.error).toBeUndefined();
    const row = await tenderRow(f.cashTenderId);
    expect(row.kind).toBe('wallet');
    expect(row.money_account_id).toBe(f.bpi);
  });

  it('W7c (control): kind cash on a wallet clears the account even though the form still submits the select', async () => {
    const f = await fixture('w7c');
    const r = await act('updateTenderAction', f.superAdmin, {
      storeId: f.storeId, tenderId: f.bankTender, version: await repoVersion(f.bankTender), name: 'Bank Transfer', kind: 'cash', moneyAccountId: f.bpi, posV1Alias: 'Bank Transfer',
    });
    expect(r.outcome.flash.error).toBeUndefined();
    const row = await tenderRow(f.bankTender);
    expect(row.kind).toBe('cash');
    expect(row.money_account_id).toBeNull();
  });

  it("W7d (control): a stale version is refused in the domain's words and the row is unchanged", async () => {
    const f = await fixture('w7d');
    const v = await repoVersion(f.cashTenderId);
    await act('updateTenderAction', f.superAdmin, { storeId: f.storeId, tenderId: f.cashTenderId, version: v, name: 'Cash A', kind: 'cash', posV1Alias: 'Cash' });
    const stale = await act('updateTenderAction', f.superAdmin, { storeId: f.storeId, tenderId: f.cashTenderId, version: v, name: 'Cash B', kind: 'cash', posV1Alias: 'Cash' });
    expect(stale.outcome.flash.error).toBe(STALE);
    expect((await tenderRow(f.cashTenderId)).name).toBe('Cash A');
    // Mutant: the action omits expectedVersion -> the second save lands, red.
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('W8 - a blank POS name clears the alias (R8)', () => {
  it('W8: Save with a blank POS name clears it, and the mapping row then reads "No POS name"; the field says so', async () => {
    const f = await fixture('w8');
    const r = await act('updateTenderAction', f.superAdmin, {
      storeId: f.storeId, tenderId: f.qrTender, version: await repoVersion(f.qrTender), name: 'QRPH', kind: 'wallet', moneyAccountId: f.bpi, posV1Alias: '',
    });
    expect(r.outcome.flash.error).toBeUndefined();
    expect((await tenderRow(f.qrTender)).pos_v1_alias).toBeNull();
    const card = cardOf(await render(f, {}, ['Bank Transfer', 'Cash', 'Gcash']), f.storeId);
    expect(plain(card)).toContain('No POS name');
    expect(plain(recordForm(card, f.qrTender)!), "the field's hint explains blank").toMatch(/blank/i);
    // Red on HEAD: no mapping table, so "No POS name" is nowhere.
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('L - full width, FormGrid (bible row 288; guards G3 / G4 / G7 / G8)', () => {
  it('L1: no fixed width on a control, no max-w cap, FormGrid and Field used (source)', () => {
    expect(PAGE_SRC, 'fixed widths (w-40, max-w-sm, max-w-md ...)').not.toMatch(/\b(?:w-(?:\d+|\[[^\]]+\])|max-w-(?:xs|sm|md|lg|xl|\d?xl|\[[^\]]+\]))\b/);
    expect(PAGE_SRC).toMatch(/\bFormGrid\b/);
    expect(PAGE_SRC).toMatch(/<Field\b/);
  });
  it('L2: the page asks for no narrow density', () => {
    expect(PAGE_SRC).not.toMatch(/density="form"/);
  });
  it('L3: no submit label G8 flags (Add tender, Link store, Save link, Create)', () => {
    expect(PAGE_SRC).not.toMatch(/>\s*(?:Add tender|Link store|Save link|Create)\s*</);
    expect(PAGE_SRC).not.toMatch(/'Save link'|'Link store'/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('X - DEF-617: a refused save keeps what was typed and reopens in edit mode, never via the URL', () => {
  // SPEC GAP: A0 / R-rules / DEF-617 name the goal ("e.g. in the signed flash, never the URL - T-380; S3b") but not the
  // mechanism: lib/flash.ts KEEP_KEYS has no tender field, and EditableRecord has no initial-mode prop. These tests are
  // BEHAVIOURAL: they say only what the user must see, however it is built.
  async function refused(f: F) {
    const v = await repoVersion(f.cashTenderId);
    await act('updateTenderAction', f.superAdmin, { storeId: f.storeId, tenderId: f.cashTenderId, version: v, name: 'Cash A', kind: 'cash', posV1Alias: 'Cash' });
    return act('updateTenderAction', f.superAdmin, {
      storeId: f.storeId, tenderId: f.cashTenderId, version: v, name: 'Typed Name Zed', kind: 'cash', posV1Alias: 'TypedAliasQ',
    });
  }

  it('X1 (control, green on HEAD): a stale save with typed values -> the redirect URL carries none of them (I3 / T-380)', async () => {
    const f = await fixture('x1');
    const r = await refused(f);
    expect(r.outcome.flash.error).toBe(STALE);
    expect(decodeURIComponent(r.signal.url)).not.toMatch(/Typed|Zed/);
  });

  it('X2: after the refusal the page reopens THAT record unlocked, holding the typed name and POS name', async () => {
    const f = await fixture('x2');
    const r = await refused(f);
    const card = cardOf(await render(f, pageParamsOf(r.signal.url)), f.storeId);
    expect(plain(card), 'the refusal shows on the card').toContain(STALE);
    const form = recordForm(card, f.cashTenderId)!;
    expect(form).toBeDefined();
    expect(form, 'reopened: not disabled').not.toContain('<fieldset disabled');
    expect(form, 'the typed name is still in the box').toContain('value="Typed Name Zed"');
    expect(form, 'and the typed POS name').toContain('value="TypedAliasQ"');
    expect(form, 'Save is showing').toMatch(/<button[^>]*type="submit"[^>]*>\s*Save\s*<\/button>/);
    expect(plain(form)).toContain('Cancel');
    expect(recordForm(card, f.walletTenderId)!, 'the other tenders stay locked').toContain('<fieldset disabled');
    // Red on HEAD / S1b-min: the record comes back with the stored values; the typed ones are gone.
  });

  it('X3 (control; red on HEAD only because nothing is locked yet): with no flash the record renders locked with the stored values', async () => {
    const f = await fixture('x3');
    const form = recordForm(cardOf(await render(f), f.storeId), f.cashTenderId)!;
    expect(form).toContain('<fieldset disabled');
    expect(form).not.toContain('Typed');
  });
});

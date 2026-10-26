import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-384 sweep, audit-fix round (TESTER). Three page findings; the two pos-link ones are in t384-s1-pos-link-web.test.ts (Y).
 *
 *  A1 items page: the super-admin bypass (formAction={createItemAction}) creates an item with NO approval, so it keeps its
 *     verb "Add directly (super-admin)" (a COMMAND), never "Save". Red on HEAD: the button reads "Save".
 *  A4 admin/stores/[id]: the opening-date cascade-reversal confirm step reads "Confirm change" (as fixed-assets/[id]),
 *     not "Save". Red on HEAD: it reads "Save".
 *  A5 sales-days/[id]: Platform sales on a feed day with NO saved channel rows is an ADD (A6): open, "Save", no locked
 *     fieldset. With saved rows it stays a locked EditableRecord (control, green on HEAD). Red on HEAD: always locked.
 * Real Postgres and domain; session, navigation, Page shell and (stores page only) the flash read are doubled.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({
  actor: null as null | { personId: string; orgId: string },
  /** Merged over the page's search params by withFlash (stands in for a signed flash cookie). */
  flash: null as null | Record<string, string>,
}));

vi.mock('next/navigation', () => ({
  // T-448 A3: FormModal/Dialog read the address.
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  redirect: (t: string) => {
    throw new Error(`NEXT_REDIRECT ${t}`);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('../../src/lib/page-access', () => ({
  requirePageAccess: async () => ({ actor: h.actor, refusal: null }),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/lib/flash', async (orig) => {
  const real = await orig<typeof import('../../src/lib/flash')>();
  return { ...real, withFlash: async (sp: Promise<object>) => (h.flash ? { ...(await sp), ...h.flash } : real.withFlash(sp as never)) };
});
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('@/components/shell/DetailLayout', () => ({
  DetailLayout: ({ summary, children }: { summary: unknown; children: unknown }) => [summary, children],
}));

import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { createStore } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
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
const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const formsOf = (html: string) => [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => m[0]);
const submitLabels = (block: string) =>
  // T-448: a known verb is an icon button - its words are the aria-label, there is no visible text. Read the label first.
  [...block.matchAll(/<button\b([^>]*type="submit"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) =>
    text(/\baria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? m[2]!.replace(/<[^>]+>/g, '').trim()),
  );

async function orgWith(hint: string, role: string) {
  const code = uid(`t384af-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'P') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  return { orgId, actor: { orgId, personId: p!.id } };
}

// ------------------------------------------------------------------------------------------------------------------
describe('A1 - items page: the super-admin bypass keeps its verb', () => {
  it('a super-admin sees a submit reading exactly "Add directly (super-admin)" beside "Request item". Mutant: label "Save" -> red', async () => {
    const f = await orgWith('a1', 'super_admin');
    h.actor = f.actor;
    h.flash = null;
    const Items = (await import('../../src/app/items/page')).default;
    const html = renderToStaticMarkup((await Items({ searchParams: Promise.resolve({}) })) as never);
    const labels = formsOf(html).flatMap(submitLabels);
    expect(labels, 'the request button stays').toContain('Request item');
    expect(labels, 'the bypass keeps its verb (a command: no approval)').toContain('Add directly (super-admin)');
  }, 60_000);

  it('source: the label of the button bound to formAction={createItemAction} is "Add directly (super-admin)" (the render shows no action identity)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'app', 'items', 'page.tsx'), 'utf8');
    const m = /formAction=\{createItemAction\}[\s\S]*?>\s*([^<{]+?)\s*<\/(?:button|Button|SubmitButton)>/.exec(src);
    expect(m, 'a button with formAction={createItemAction}').not.toBeNull();
    expect(m![1]).toBe('Add directly (super-admin)');
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe('A4 - admin/stores/[id]: the opening-date confirm step reads "Confirm change"', () => {
  it('with a confirm sentence, an openingDate and a plan, the confirm form carries confirmedPlan and its submit reads exactly "Confirm change". Mutant: "Save" -> red', async () => {
    const f = await orgWith('a4', 'admin');
    await seedChartOfAccounts(sql, f.orgId);
    const { storeId } = await withOrgPrincipal(f.orgId, (tx) =>
      createStore(tx, f.actor, { code: uid('S'), name: 'Store' } as Parameters<typeof createStore>[2]),
    );
    h.actor = f.actor;
    h.flash = { confirm: 'Moving the opening date reverses 2 entries; confirm to proceed', openingDate: '2026-01-01', plan: '0123456789abcdef' };
    try {
      const Page = (await import('../../src/app/admin/stores/[id]/page')).default;
      const html = renderToStaticMarkup(
        (await Page({ params: Promise.resolve({ id: storeId }), searchParams: Promise.resolve({}) })) as never,
      );
      const confirmForm = formsOf(html).find((b) => /name="confirmedPlan"[^>]*value="0123456789abcdef"|value="0123456789abcdef"[^>]*name="confirmedPlan"/.test(b));
      expect(confirmForm, 'the confirm form (hidden confirmedPlan)').toBeDefined();
      expect(submitLabels(confirmForm!)).toEqual(['Confirm change']);
    } finally {
      h.flash = null;
    }
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------------------------
describe('A5 - sales-days/[id]: Platform sales with no saved rows is an add', () => {
  async function dayFixture(hint: string) {
    const f = await orgWith(hint, 'admin');
    await seedChartOfAccounts(sql, f.orgId);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2027-01-01', '2027-01-31', 'open')`;
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('st')}, 'Lipa') returning id`;
    const storeId = st!.id;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.actor.personId}, ${storeId})`;
    const mk = async (name: string, remitted: boolean, rec: string | null) =>
      (await sql<{ id: string }[]>`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
        values (${f.orgId}, ${storeId}, ${name}, ${remitted}, ${rec}) returning id`)[0]!.id;
    const walkIn = await mk('Walk-in', true, null);
    const panda = await mk('Foodpanda', false, '1220');
    const [g] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${f.orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
    await linkTestStore(sql, { orgId: f.orgId, storeId, channelId: walkIn, createdBy: f.actor.personId });
    await seedTestTenders(sql, { orgId: f.orgId, storeId, walletAccountId: g!.id });
    const { id } = await asOrg(f.orgId, (tx) => importTestDay(tx, f.actor, { storeId, businessDate: '2027-01-10' }));
    return { ...f, storeId, dayId: id, panda };
  }
  async function platformForm(f: Awaited<ReturnType<typeof dayFixture>>): Promise<string> {
    return (await platformPage(f)).form;
  }
  async function platformPage(f: Awaited<ReturnType<typeof dayFixture>>): Promise<{ form: string; html: string }> {
    h.actor = f.actor;
    h.flash = null;
    const Page = (await import('../../src/app/sales-days/[id]/page')).default;
    const html = renderToStaticMarkup(
      (await Page({ params: Promise.resolve({ id: f.dayId }), searchParams: Promise.resolve({ store: f.storeId }) })) as never,
    );
    const form = formsOf(html).find((b) => /name="channel_/.test(b));
    expect(form, 'the Platform sales form').toBeDefined();
    return { form: form!, html };
  }

  it('no saved channel rows: the form is open (no disabled fieldset) and its submit reads exactly "Save". Mutant: always EditableRecord -> red', async () => {
    const f = await dayFixture('a5a');
    const form = await platformForm(f);
    expect(form, 'an add form is not locked').not.toContain('<fieldset disabled');
    expect(submitLabels(form)).toEqual(['Save']);
  }, 60_000);

  it('control (green on HEAD): with a saved platform row the form stays a locked EditableRecord with its Edit button', async () => {
    const f = await dayFixture('a5b');
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${f.dayId}, ${f.panda}, '150.00')`;
    const { form, html } = await platformPage(f);
    expect(form).toContain('<fieldset disabled');
    // T-448: the Edit icon button sits beside the form (the form is inside a closed dialog), so look in the whole page.
    expect(html).toContain('aria-label="Edit platform sales"');
  }, 60_000);
});

// ASSUMED API (T-530a): none. The pages are server-side and the device store is browser-only.
// ASSUMED API: apps/erp/src/app/pos/{page.tsx, receipts/page.tsx, till/page.tsx, kitchen/page.tsx, refills/page.tsx}: each default export is
//   `async (props: { searchParams: Promise<{ storeId?: string }> }) => ReactNode`, calls the REAL requirePageAccess('/pos...') first and returns its `refusal`,
//   and when `?storeId` names a store the person does not hold (another store of the org, or another org's) returns <StoreNotAvailable /> (page-access.tsx:
//   "This store is not available to you."), naming no store. The returned node renders with renderToStaticMarkup (no async child components).
// ASSUMED API: apps/erp/src/lib/session.ts is mocked here at its module boundary (requireSession, requireActor, currentSession, readPosTabletToken = no pairing).
/**
 * T-526 R6 integration (real Postgres) - every /pos page refuses a person without its capability, and refuses a person of another store when
 * `?storeId` names a store they do not hold. Every refusal has its positive control. Written BEFORE the code (tester lane).
 * Runs on any `_test` database; names none.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { renderToStaticMarkup } from 'react-dom/server';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/flash-jar-core')).nextNavigationMock(),
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => null),
  };
});
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NO_ACCESS = 'You do not have access to this screen';
const NOT_AVAILABLE = 'This store is not available to you.';

const PAGES: { file: string; route: string; cap: string }[] = [
  { file: 'page', route: '/pos', cap: 'record_sale' },
  { file: 'receipts/page', route: '/pos/receipts', cap: 'record_sale' },
  { file: 'till/page', route: '/pos/till', cap: 'record_sale' },
  { file: 'kitchen/page', route: '/pos/kitchen', cap: 'serve_pos_ticket' },
  { file: 'refills/page', route: '/pos/refills', cap: 'request_pos_refill' },
];
const CAPS = ['record_sale', 'serve_pos_ticket', 'request_pos_refill'] as const;

async function person(orgId: string, name: string, role: 'staff' | 'manager', storeId: string, grantAtA?: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  if (grantAtA) {
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${p!.id}, ${grantAtA}, null, 'grant', ${storeId})`;
  }
  return { orgId, personId: p!.id };
}

async function fixture() {
  const code = uid('t526');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [other] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Other ${code}`}, ${`${code}-x`}) returning id`;
  const mk = async (orgId: string, name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const a = await mk(org!.id, 'Alpha Store');
  const b = await mk(org!.id, 'Hidden Bravo Store');
  const c = await mk(other!.id, 'Foreign Charlie Store');
  return {
    a,
    b,
    c,
    none: await person(org!.id, 'No Caps', 'staff', a),
    holders: {
      record_sale: await person(org!.id, 'Cashier Cara', 'staff', a, 'record_sale'),
      serve_pos_ticket: await person(org!.id, 'Cook Carlo', 'staff', a, 'serve_pos_ticket'),
      request_pos_refill: await person(org!.id, 'Runner Rina', 'staff', a, 'request_pos_refill'),
    },
    mgr: await person(org!.id, 'Manager Mia', 'manager', a),
  };
}

async function render(file: string, who: { orgId: string; personId: string }, storeId?: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  // A computed path with @vite-ignore: Vite's variable-import expansion only reaches one directory deep and would not find kitchen/page.tsx.
  const path = '../../src/app/pos/' + file + '.tsx';
  const mod = await import(/* @vite-ignore */ path);
  const node = await mod.default({ searchParams: Promise.resolve(storeId ? { storeId } : {}) });
  return renderToStaticMarkup(node as never);
}

describe('T-526 R6 - every /pos page refuses a person without its capability', () => {
  for (const page of PAGES) {
    it(
      `${page.route}: a person holding no POS capability sees the refusal naming ${page.cap}`,
      async () => {
        const f = await fixture();
        const html = await render(page.file, f.none);
        expect(html).toContain(NO_ACCESS);
        expect(html).toContain(`>${page.cap}<`);
      },
      60_000,
    );

    for (const held of CAPS) {
      const allowed = held === page.cap;
      it(
        `${page.route}: a person holding ONLY ${held} is ${allowed ? 'let in (positive control)' : 'refused (holding another POS word does not count)'}`,
        async () => {
          const f = await fixture();
          // T-526b: /pos (Orders) sends a kitchen or refill person to their own tab instead of the refusal; every other page still refuses.
          const ordersRedirect = page.route === '/pos' && !allowed && held !== 'record_sale' ? { serve_pos_ticket: '/pos/kitchen', request_pos_refill: '/pos/refills' }[held] : null;
          if (ordersRedirect) {
            await expect(render(page.file, f.holders[held])).rejects.toMatchObject({ url: ordersRedirect });
            return;
          }
          const html = await render(page.file, f.holders[held]);
          if (allowed) {
            expect(html).not.toContain(NO_ACCESS);
            expect(html).not.toContain(NOT_AVAILABLE);
          } else {
            expect(html).toContain(NO_ACCESS);
            expect(html).toContain(`>${page.cap}<`);
          }
        },
        60_000,
      );
    }
  }
});

describe('T-526b - /pos sends a person without record_sale to the first POS tab they hold', () => {
  it('holds both kitchen and refill words -> /pos/kitchen; holds none -> the refusal, no redirect (control)', async () => {
    const f = await fixture();
    const both = await person(f.mgr.orgId, 'Both Bea', 'staff', f.a, 'serve_pos_ticket');
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${both.personId}, 'request_pos_refill', null, 'grant', ${f.a})`;
    await expect(render('page', both)).rejects.toMatchObject({ url: '/pos/kitchen' });
    expect(await render('page', f.none)).toContain(NO_ACCESS);
  }, 60_000);
  it('the redirect cannot reach another store: a kitchen-only person at Alpha opening /pos?storeId=<Bravo> is redirected, and the target page then refuses (one sentence, no store name)', async () => {
    const f = await fixture();
    const who = f.holders.serve_pos_ticket;
    await expect(render('page', who, f.b)).rejects.toMatchObject({ url: `/pos/kitchen?storeId=${f.b}` });
    const refused = await render('kitchen/page', who, f.b);
    expect(refused).toContain(NOT_AVAILABLE);
    expect(refused).not.toContain('Hidden Bravo');
    expect(refused).not.toContain(f.b);
    // control: the same person with their own store goes through to the kitchen page and is let in
    await expect(render('page', who, f.a)).rejects.toMatchObject({ url: `/pos/kitchen?storeId=${f.a}` });
    expect(await render('kitchen/page', who, f.a)).not.toContain(NOT_AVAILABLE);
  }, 60_000);
  it('keeps ?storeId on the way', async () => {
    const f = await fixture();
    await expect(render('page', f.holders.request_pos_refill, f.a)).rejects.toMatchObject({ url: `/pos/refills?storeId=${f.a}` });
  }, 60_000);
});

describe('T-526 R6 - a person of one store is refused another store named in ?storeId', () => {
  for (const page of PAGES) {
    it(
      `${page.route}: the manager of Alpha asking for ?storeId=<Bravo> (same org) gets the one sentence and no store name; Alpha itself and no storeId are fine (control)`,
      async () => {
        const f = await fixture();
        const denied = await render(page.file, f.mgr, f.b);
        expect(denied).toContain(NOT_AVAILABLE);
        expect(denied).not.toContain('Hidden Bravo');
        expect(denied).not.toContain(f.b);

        for (const ok of [f.a, undefined]) {
          const html = await render(page.file, f.mgr, ok);
          expect(html, `storeId=${ok}`).not.toContain(NOT_AVAILABLE);
          expect(html, `storeId=${ok}`).not.toContain(NO_ACCESS);
        }
      },
      60_000,
    );

    it(
      `${page.route}: ?storeId=<another organisation's store> gets the same sentence`,
      async () => {
        const f = await fixture();
        const html = await render(page.file, f.mgr, f.c);
        expect(html).toContain(NOT_AVAILABLE);
        expect(html).not.toContain('Foreign Charlie');
      },
      60_000,
    );
  }

  it(
    '/pos: the capability holder at Alpha is refused Bravo too (holding the word at one store is not scope at another)',
    async () => {
      const f = await fixture();
      expect(await render('page', f.holders.record_sale, f.b)).toContain(NOT_AVAILABLE);
      expect(await render('page', f.holders.record_sale, f.a)).not.toContain(NOT_AVAILABLE);
    },
    60_000,
  );
});

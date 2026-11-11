// ASSUMED API: same page shape as t526-pos-pages-access.test.ts; here readPosTabletToken returns a real pairing token.
/**
 * T-526 audit 5 + 4 (real Postgres) - on a PAIRED tablet the pairing's store wins and a different ?storeId is refused; and the pairing is
 * readable inside an org-principalled transaction (RLS lets an org see its own pairings, and nobody else's). Runs on any `_test` database.
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

const HOLD: { actor: { orgId: string; personId: string } | null; token: string | null } = { actor: null, token: null };
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: HOLD.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { closeDb } from '@shareat/db';
import { posTabletTokenHash, resolvePosTablet } from '@shareat/auth';
import { withOrgPrincipal } from '../../src/app/expenses/lib';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NOT_AVAILABLE = 'This store is not available to you.';
const token = () => Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url');

async function fixture() {
  const code = uid('t526p');
  const org = async (c: string) => (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`)[0]!.id;
  const orgA = await org(code);
  const orgB = await org(`${code}-x`);
  const store = async (orgId: string, name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const a = await store(orgA, 'Alpha Store');
  const b = await store(orgA, 'Bravo Store');
  const foreign = await store(orgB, 'Foreign Store');
  const mgr = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, 'Manager Mia') returning id`)[0]!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${mgr}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${mgr}, ${a})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${mgr}, ${b})`;
  const pair = async (orgId: string, storeId: string, by: string) => {
    const t = token();
    await sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${orgId}, ${storeId}, 'Counter', ${posTabletTokenHash(t)}, ${by})`;
    return t;
  };
  const foreignMgr = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgB}, 'Other Org Manager') returning id`)[0]!.id;
  return { orgA, a, b, foreign, mgr, tokenA: await pair(orgA, a, mgr), tokenForeign: await pair(orgB, foreign, foreignMgr) };
}

async function render(who: { orgId: string; personId: string }, tok: string | null, storeId?: string): Promise<string> {
  HOLD.actor = who;
  HOLD.token = tok;
  const mod = await import('../../src/app/pos/page');
  return renderToStaticMarkup((await mod.default({ searchParams: Promise.resolve(storeId ? { storeId } : {}) })) as never);
}

describe('T-526 audit 5 - a paired tablet cannot be pointed at another store', () => {
  it(
    'paired at Alpha: ?storeId=Bravo (a store the manager DOES hold) is refused; Alpha and no storeId are fine; the same ?storeId unpaired is allowed (control)',
    async () => {
      const f = await fixture();
      const me = { orgId: f.orgA, personId: f.mgr };
      expect(await render(me, f.tokenA, f.b)).toContain(NOT_AVAILABLE);
      for (const ok of [f.a, undefined]) expect(await render(me, f.tokenA, ok), String(ok)).not.toContain(NOT_AVAILABLE);
      expect(await render(me, null, f.b)).not.toContain(NOT_AVAILABLE);
    },
    60_000,
  );
});

describe('T-526 audit 4 - the pairing is read inside the org-principalled transaction', () => {
  it(
    'an org sees its own pairing; another organisation\'s token finds nothing (RLS), so the layout needs no null-transaction lookup',
    async () => {
      const f = await fixture();
      const mine = await withOrgPrincipal(f.orgA, (tx) => resolvePosTablet(tx, f.tokenA));
      expect(mine).toMatchObject({ orgId: f.orgA, storeId: f.a });
      expect(await withOrgPrincipal(f.orgA, (tx) => resolvePosTablet(tx, f.tokenForeign))).toBeNull();
    },
    60_000,
  );
});

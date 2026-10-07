import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-338 - the store page shows the `manager` readiness check as a warning, never a blocker.
 * `docs/tasks/338-store-readiness-manager-warning.md`, W1 and W2.
 *
 * RED on HEAD: W1 and W2 (no "A manager is assigned" row yet). Render harness copied from
 * t380-s2-money-and-refill.test.ts (StorePage + renderToStaticMarkup).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/flash-jar-core')).nextNavigationMock(),
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('../../src/lib/page-access', () => ({
  requirePageAccess: async () => ({ actor: ACTOR_HOLDER.actor!, refusal: null }),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/DetailLayout', () => ({
  DetailLayout: ({ summary, children }: { summary: unknown; children: unknown }) => [summary, children],
}));

import { closeDb, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createStore } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** One org, an admin, a store made by createStore (room + admin scope), a sales channel and a PIN holder
 *  scoped to the store - so every BLOCKING check is green and only the manager check can differ. */
async function readyStoreFixture(hint: string) {
  const code = uid(`t338-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  const a = actor(orgId, admin!.id);
  const { storeId } = await withOrgPrincipal(orgId, (tx) =>
    createStore(tx, a, { code: uid('S'), name: 'Store' } as Parameters<typeof createStore>[2]),
  );
  await sql`insert into sales_channels (org_id, store_id, name, is_active, is_remitted_daily)
            values (${orgId}, ${storeId}, 'Walk-in', true, true)`;
  // The admin is already scoped here by the fan-out; a live PIN makes signIn green.
  await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
            values (${admin!.id}, 'pin', ${storeId}, ${uid('secret')}, ${uid('lookup')})`;
  return { orgId, storeId, admin: a };
}

async function renderStorePage(f: { storeId: string; admin: Actor }): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const StorePage = (await import('../../src/app/admin/stores/[id]/page')).default;
  return renderToStaticMarkup(
    (await StorePage({ params: Promise.resolve({ id: f.storeId }), searchParams: Promise.resolve({}) })) as never,
  );
}

describe('T-338 - store page, manager readiness', () => {
  it(
    'W1: rooms + channel + PIN holder but no manager -> the row, the sentence and the Users link show; the blocking banner does not. ' +
      'Mutant: blocking:true on the check -> "still stop this store working" appears -> red',
    async () => {
      const f = await readyStoreFixture('w1');
      const html = await renderStorePage(f);
      expect(html).toContain('A manager is assigned');
      expect(html).toContain('No manager assigned to this store');
      expect(
        /<a[^>]*href="\/admin\/users"[^>]*>\s*Assign a manager in Users and roles →\s*<\/a>/.test(html),
        'remedy link to /admin/users',
      ).toBe(true);
      expect(html).not.toContain('still stop this store working');
    },
    60_000,
  );

  it(
    'W2: the same store after P is made manager and scoped -> "Managed by P." and no /admin/users remedy link. ' +
      'Mutant: ok hard-coded false -> the sentence and link stay -> red',
    async () => {
      const f = await readyStoreFixture('w2');
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Ana Cruz') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
      const html = await renderStorePage(f);
      expect(html).toContain('Managed by Ana Cruz.');
      expect(html).not.toContain('No manager assigned to this store');
      expect(html).not.toContain('href="/admin/users"');
    },
    60_000,
  );
});

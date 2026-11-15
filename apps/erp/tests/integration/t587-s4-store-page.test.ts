import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-587 S4 - the store page (/admin/stores/[id]) in plain words: saved values printed on the page, no developer
 * wording, readiness folded away when it is all green, Close this store at the very bottom, tap-sized section links.
 * docs/tasks/587-s4-store-page.md. Render harness copied from t338-manager-readiness-page.test.ts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
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

/** One org, an admin and a store made by createStore (room + admin scope). `missing` leaves out what a ready store has. */
async function storeFixture(hint: string, opts: { manager?: boolean; pin?: boolean; opened?: boolean } = {}) {
  const { manager = true, pin = true, opened = true } = opts;
  const code = uid(`t587-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  const a = actor(orgId, admin!.id);
  const { storeId } = await withOrgPrincipal(orgId, (tx) =>
    createStore(tx, a, { code: uid('S'), name: 'Lipa Kitchen' } as Parameters<typeof createStore>[2]),
  );
  await sql`insert into sales_channels (org_id, store_id, name, is_active, is_remitted_daily)
            values (${orgId}, ${storeId}, 'Walk-in', true, true)`;
  if (pin) {
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${admin!.id}, 'pin', ${storeId}, ${uid('secret')}, ${uid('lookup')})`;
  }
  if (manager) {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Ana Cruz') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  }
  await sql`update stores set address = '12 Rizal Avenue, Lipa City', contact_number = '0917 555 0100', tin_branch_code = '00007',
            opening_date = ${opened ? '2022-02-14' : null}::date where id = ${storeId}`;
  return { orgId, storeId, admin: a };
}

async function renderStorePage(f: { storeId: string; admin: Actor }): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const StorePage = (await import('../../src/app/admin/stores/[id]/page')).default;
  return renderToStaticMarkup(
    (await StorePage({ params: Promise.resolve({ id: f.storeId }), searchParams: Promise.resolve({}) })) as never,
  );
}

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('T-587 S4 - store page', () => {
  it(
    'R1: the saved values are printed on the page (name, address, TIN branch code, long opening date, One room). ' +
      'Mutant: delete the Details <dl> -> the address is gone -> red',
    async () => {
      const f = await storeFixture('r1');
      const t = plain(await renderStorePage(f));
      expect(t).toContain('Lipa Kitchen');
      expect(t).toContain('12 Rizal Avenue, Lipa City');
      expect(t).toContain('0917 555 0100');
      expect(t).toMatch(/TIN branch code 00007/);
      expect(t).toContain('Asia/Manila');
      expect(t).toContain('February 14, 2022');
      expect(t).toContain('One room');
      expect(t).not.toContain('single_room');
      expect(t).not.toContain('2022-02-14');
    },
    60_000,
  );

  it(
    'R2: a store with no opening date and no address says Not set, never a blank. Mutant: Row prints "" for empty -> red',
    async () => {
      const f = await storeFixture('r2', { opened: false });
      await sql`update stores set address = null, contact_number = null where id = ${f.storeId}`;
      const t = plain(await renderStorePage(f));
      expect(t).not.toMatch(/Opening date Not set/); // no date saved: the add form below is the read view, so no repeated "Not set" line
      expect(t).toMatch(/Trading address Not set/);
      expect(t).toMatch(/Contact number Not set/);
    },
    60_000,
  );

  it(
    'W1: no developer wording anywhere on the page. Mutant: put the "automatic" tag back -> red',
    async () => {
      const f = await storeFixture('w1', { manager: false, pin: false });
      const html = await renderStorePage(f);
      for (const bad of ['automatic', 'business fact', 'Recomputed', 'queryable', '(s)', 're-fans', 'DEF-0', 'costume', 'screenshot', 'ceiling', 'remittanceCadence']) {
        expect(html, `page must not say "${bad}"`).not.toContain(bad);
      }
    },
    60_000,
  );

  it(
    'W2: the word "branch" is not user text on this page (apart from the legal term TIN branch code)',
    async () => {
      const f = await storeFixture('w2', { manager: false });
      const t = plain(await renderStorePage(f)).replaceAll('TIN branch code', '');
      expect(t.toLowerCase()).not.toContain('branch');
      expect(t).toContain('How this store keeps stock');
      expect(t).toContain('Close this store');
    },
    60_000,
  );

  it(
    'D1: all checks pass -> readiness is closed and reads "Ready ✓". Mutant: details always open -> red',
    async () => {
      const f = await storeFixture('d1');
      const html = await renderStorePage(f);
      expect(html).toMatch(/<details>\s*<summary[^>]*>Ready ✓<\/summary>/);
      expect(html).not.toMatch(/<details[^>]*\sopen/);
    },
    60_000,
  );

  it(
    'D2: checks fail -> readiness is open and counts them, with the right plural (1 and 3). Mutant: count blocking only -> red',
    async () => {
      const one = await renderStorePage(await storeFixture('d2a', { manager: false }));
      expect(one).toMatch(/<details open=""[^>]*>\s*<summary[^>]*>1 thing needs attention<\/summary>/);
      expect(one).toContain('/admin/users'); // the failing check keeps its remedy link
      const three = await renderStorePage(await storeFixture('d2b', { manager: false, pin: false, opened: false }));
      expect(three).toMatch(/<summary[^>]*>3 things need attention<\/summary>/);
      expect(three).toContain('Issue a PIN from Staff');
    },
    60_000,
  );

  it(
    'C1: Close this store sits after the Details section and after both columns, and the summary is a 44px tap target',
    async () => {
      const f = await storeFixture('c1');
      const html = await renderStorePage(f);
      const details = html.indexOf('>Details<');
      const close = html.indexOf('>Close this store<');
      const hours = html.indexOf('>Menu hours<');
      expect(details).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(details);
      expect(close).toBeGreaterThan(hours); // after the last card of the right column
      expect(html).toMatch(/<summary class="[^"]*\bmin-h-11\b[^"]*\bw-full\b/);
    },
    60_000,
  );

  it(
    'L1: the five section links are tap-sized links with the new names. Mutant: drop min-h-11 from SECTION_LINK -> red',
    async () => {
      const f = await storeFixture('l1');
      const html = await renderStorePage(f);
      const links = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)]
        .map((m) => ({ href: /href="([^"]*)"/.exec(m[1]!)?.[1] ?? '', cls: /class="([^"]*)"/.exec(m[1]!)?.[1] ?? '', text: m[2]!.trim() }))
        .filter((l) => l.href.includes(`store=${f.storeId}`));
      const names = links.map((l) => l.text);
      expect(names).toEqual(['Kitchen stations', 'Menu hours', 'Sales channels and settlement wiring', 'Link to POS store', 'Cash settings']);
      for (const l of links) expect(l.cls, l.text).toMatch(/\bmin-h-11\b/);
      expect(html).toContain(`href="/kitchen?store=${f.storeId}"`);
      expect(html).toContain(`href="/settings/pos-link?store=${f.storeId}"`);
    },
    60_000,
  );

  it(
    'M1: the Menu hours help has no made-up example times',
    async () => {
      const f = await storeFixture('m1');
      const html = await renderStorePage(f);
      expect(html).not.toContain('08:00');
      expect(html).not.toContain('17:00');
      expect(html).not.toContain('Lunch from');
      expect(plain(html)).toContain('For hours that run past midnight, end earlier than you start.');
    },
    60_000,
  );
});

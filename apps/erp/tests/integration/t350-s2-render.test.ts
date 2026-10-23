/**
 * T-350 S2 (DEF-477 follow-up) — `docs/tasks/350-def-477-change-channel-payout-account.md` §S2,
 * finding F2, leg S2-R2.
 *
 * ⛔ TESTER, not BUILDER. `page.tsx:54-59` decides the Change control's visibility with
 * `heldCapabilities`, which is deliberately store-blind (`packages/auth/src/authorize.ts`'s own
 * JSDoc: "Store scope is NOT consulted"). The page applies that ONE org-wide boolean to every
 * channel card regardless of the channel's own store, so an admin scoped to a single store sees
 * Change on every OTHER store's channel too — a control the real `authorize()` gate (store-scoped,
 * axis 2) will then refuse the moment it is used.
 *
 * ⛔ **Real Postgres, real `@shareat/auth`, real DB-backed page render — deliberately NOT the
 * `heldCapabilities` mock `t350-channel-payout-change-render.test.ts` uses.** That mock can only
 * ever express an org-wide boolean (the function it stands in for has no store parameter at all),
 * so asserting this leg through it would agree with the bug by construction rather than catch it.
 * Only `requireSession` and the two `@/...` Next.js path aliases (root `vitest.config.mts` never
 * resolves them — s5-5p/s5-5q precedent) are mocked; `heldCapabilities`, `withOrgPrincipal` and
 * every data read are the real thing, against this lane's own database.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

vi.mock('../../src/lib/session', () => ({
  requireSession: vi.fn(),
}));

vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

async function fixture(hint: string) {
  const code = uid(`t350s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const { seedChartOfAccounts } = await import('../../../../packages/db/seed/chart-of-accounts');
  await seedChartOfAccounts(sql, orgId);

  const [storeA] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Store A') returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('b')}, 'Store B') returning id`;
  const storeAId = storeA!.id;
  const storeBId = storeB!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  // Scoped to A ONLY — never B. The whole point of the leg.
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeAId}, 'manual')`;

  const mkAccount = async (storeId: string, label: string) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${label}, 'bank', '1140', 'office') returning id`;
    return a!.id;
  };
  const bankA = await mkAccount(storeAId, `Bank A ${uid('m')}`);
  const bankB = await mkAccount(storeBId, `Bank B ${uid('m')}`);

  const mkChannel = async (storeId: string, name: string, destAccountId: string) => {
    const [c] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                  destination_money_account_id)
      values (${orgId}, ${storeId}, ${name}, false, '1220', ${destAccountId})
      returning id`;
    return c!.id;
  };
  const channelAId = await mkChannel(storeAId, `Foodpanda A ${uid('c')}`, bankA);
  const channelBId = await mkChannel(storeBId, `Foodpanda B ${uid('c')}`, bankB);

  return { orgId, storeAId, storeBId, adminId, channelAId, channelBId };
}

let ChannelSettlementsPage: typeof import('../../src/app/channel-settlements/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ChannelSettlementsPage = (await import('../../src/app/channel-settlements/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 30_000);

describe('S2-R2 — the Change control is decided PER CHANNEL, at that channel\'s own store', () => {
  it(
    'an admin scoped only to store A sees Change on store A\'s channel, but NOT on store B\'s — was red today: heldCapabilities is org-wide, so B\'s card shows Change too',
    async () => {
      const f = await fixture('r2');
      requireSessionMock.mockResolvedValue({
        actor: { orgId: f.orgId, personId: f.adminId },
        sessionId: 'session-1',
        credentialKind: 'pin' as const,
        storeId: null,
        expiresAt: new Date('2099-01-01'),
      });

      const element = await ChannelSettlementsPage({ searchParams: Promise.resolve({}) });
      const html = renderToStaticMarkup(element as never);

      const cardFor = (needle: string) => {
        const idx = html.indexOf(needle);
        expect(idx, `expected to find "${needle}" in the render`).toBeGreaterThanOrEqual(0);
        // Each channel card is a `<div class="rounded-lg border ...">…</div>` — slice the window
        // around the channel's own name rather than parsing full HTML, same idiom the render-mock
        // test file uses.
        return html.slice(Math.max(0, idx - 400), idx + 800);
      };

      const cardA = cardFor('Foodpanda A');
      const cardB = cardFor('Foodpanda B');

      // 2026-10-09, T-384 sweep fallout (A0): "Change" (a <details>/<summary>) is now the EditableRecord's Edit button,
      // labelled "Edit <channel> payout account". Same per-store gate: present on A, absent on B.
      expect(html, 'store A: the admin is scoped here, Edit must show').toMatch(
        /aria-label="Edit Foodpanda A [^"]* payout account"/, // T-448: Edit is an icon button; its words are the aria-label
      );
      expect(
        html,
        'store B: the admin is NOT scoped here — Edit must NOT show, even though the render is org-wide today',
      ).not.toMatch(/aria-label="Edit Foodpanda B [^"]* payout account"/);
      void cardA;
      void cardB;
    },
    30000,
  );
});

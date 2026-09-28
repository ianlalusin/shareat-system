/**
 * T-350 S4 (G2) — `docs/tasks/350-def-477-change-channel-payout-account.md` §S4.
 *
 * ⛔ TESTER, not BUILDER. Today `page.tsx`'s "changed" banner is built entirely from
 * `searchParams` (`sp.changed === '1'`) plus a live lookup of the channel by id — it never reads
 * `audit_log` at all, so a forged URL with `changed=1` and no backing row still renders "Payout
 * account changed." G2 replaces that with: the banner shows ONLY when the channel's latest
 * `set_channel_payout` `audit_log` row (a) exists, (b) was written by the VIEWER, and (c) is under
 * 10 minutes old — and then it names THAT row's `after.moneyAccountName`, not the channel's current
 * live name (which can have moved again since).
 *
 * ⛔ **Real Postgres, real page render — same idiom as `t350-s2-render.test.ts`.** Only
 * `requireSession` and the two `@/...` Next.js path aliases are mocked (root `vitest.config.mts`
 * never resolves bare `@/...` specifiers — s5-5p/s5-5q precedent); `heldCapabilities`,
 * `withOrgPrincipal`, `audit_log` and every other read are the real thing against this lane's own
 * database. Audit rows are inserted directly with the owner connection (bypassing RLS), the same
 * way every other fixture here seeds data — this file tests what the PAGE does with a row that
 * exists, not `auditLogRepo.append` itself (that is S3's own suite).
 *
 * ⚠️ The exact search-param key(s) the banner reads are not yet built (G4 renames `channel` to
 * `changedChannel` to stop the collision with the settlement form's preselect register) — both
 * `channel` and `changedChannel` are set on every request below so this file's reds do not depend
 * on guessing which one the builder lands on.
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
  const code = uid(`t350s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const { seedChartOfAccounts } = await import('../../../../packages/db/seed/chart-of-accounts');
  await seedChartOfAccounts(sql, orgId);

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Store A') returning id`;
  const storeId = store!.id;

  const [viewer] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Viewer Admin') returning id`;
  const viewerId = viewer!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${viewerId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${viewerId}, ${storeId}, 'manual')`;

  const [otherPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Someone Else') returning id`;
  const otherPersonId = otherPerson!.id;

  const mkAccount = async (label: string) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${label}, 'bank', '1140', 'office') returning id`;
    return a!.id;
  };
  const liveAccountId = await mkAccount(`Bank Live ${uid('m')}`);

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${liveAccountId})
    returning id`;
  const channelId = channel!.id;

  return { orgId, storeId, viewerId, otherPersonId, channelId, liveAccountId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Inserts a real `audit_log` row for a `set_channel_payout` change, owner connection (bypasses RLS). */
async function auditRow(
  f: Pick<Fixture, 'orgId' | 'channelId'>,
  input: { actorPersonId: string; afterName: string; occurredAt?: Date },
) {
  await sql`
    insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, occurred_at)
    values (
      ${f.orgId}, ${input.actorPersonId}, 'set_channel_payout', 'sales_channels', ${f.channelId},
      ${sql.json({ moneyAccountId: null, moneyAccountName: null })},
      ${sql.json({ moneyAccountId: uid('acct'), moneyAccountName: input.afterName })},
      'web', ${input.occurredAt ?? new Date()}
    )
  `;
}

let ChannelSettlementsPage: typeof import('../../src/app/channel-settlements/page').default;
let requireSessionMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ChannelSettlementsPage = (await import('../../src/app/channel-settlements/page')).default;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 30_000);

async function renderAsViewer(f: Fixture, searchParams: Record<string, string>) {
  requireSessionMock.mockResolvedValue({
    actor: { orgId: f.orgId, personId: f.viewerId },
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  });
  const element = await ChannelSettlementsPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element as never);
}

function bannerParams(f: Fixture) {
  // Both spellings, so the reds do not depend on which one G4 lands on.
  return { ok: 'destination', changed: '1', channel: f.channelId, changedChannel: f.channelId };
}

/**
 * The emerald "ok" banner's own text, isolated from the rest of the page — same
 * `className`-anchored slice idiom `t350-s2-render.test.ts`'s `cardFor` uses. ⚠️ Needed because the
 * live account name legitimately appears elsewhere on the page (the channel card, the Change
 * select, the settlement form's dropdown), so a whole-page `.not.toMatch(/Bank Live/)` would fail
 * for the WRONG reason — matching the card, not the banner. Returns '' when no banner div renders.
 */
function bannerText(html: string): string {
  const m = /<div class="rounded-lg border border-emerald-300[^"]*">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1]! : '';
}

describe('G2 — a forged URL with NO backing audit_log row shows no "changed" banner', () => {
  it(
    'wanted: no banner at all when nothing in audit_log backs it — was red today: the banner is ' +
      'built entirely from the URL plus the channel\'s CURRENT name, with no audit_log read anywhere',
    async () => {
      const f = await fixture('g2-forged');
      const html = await renderAsViewer(f, bannerParams(f));
      expect(
        bannerText(html),
        'wanted: no "Payout account changed" banner with zero audit_log rows for this channel',
      ).not.toMatch(/Payout account changed/i);
    },
    30000,
  );
});

describe('G2 — a real, recent change BY THE VIEWER shows the banner, naming the audit row\'s own after-account', () => {
  it(
    'wanted: the banner names the CAPTURED after.moneyAccountName from the audit row, not the ' +
      'channel\'s current live name — was red today: the banner (when shown at all) reads the ' +
      'LIVE channel, never audit_log, so it would show "Bank Live ..." instead of the captured name',
    async () => {
      const f = await fixture('g2-real');
      await auditRow(f, { actorPersonId: f.viewerId, afterName: 'Bank At Change Time' });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(banner, 'wanted the captured audit-row account name in the banner').toMatch(
        /Bank At Change Time/,
      );
      expect(
        banner,
        'the banner must not fall back to the channel\'s current LIVE account name instead',
      ).not.toMatch(/Bank Live/);
    },
    30000,
  );
});

describe('G2 — ANOTHER person\'s change shows no banner to this viewer', () => {
  it(
    'wanted: a recent row exists but was written by someone else, so no banner — was red today: the ' +
      'banner shows regardless of who is viewing, since actor is never consulted',
    async () => {
      const f = await fixture('g2-other-person');
      await auditRow(f, { actorPersonId: f.otherPersonId, afterName: 'Bank Someone Else Chose' });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(
        banner,
        'wanted no "changed" banner when the audit row belongs to a different actor',
      ).not.toMatch(/Payout account changed/i);
      expect(banner, 'the other person\'s account name must not leak into this viewer\'s banner').not.toMatch(
        /Bank Someone Else Chose/,
      );
    },
    30000,
  );
});

describe('G2 — a row older than 10 minutes shows no banner', () => {
  it(
    'wanted: a row by the viewer exists but is stale (>10 min), so no banner — was red today: the ' +
      'banner has no time window at all, since it never reads audit_log',
    async () => {
      const f = await fixture('g2-stale');
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      await auditRow(f, {
        actorPersonId: f.viewerId,
        afterName: 'Bank Fifteen Minutes Ago',
        occurredAt: fifteenMinutesAgo,
      });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(banner, 'wanted no "changed" banner once the audit row is stale (>10 minutes old)').not.toMatch(
        /Payout account changed/i,
      );
      expect(banner, 'the stale row\'s account name must not appear either').not.toMatch(
        /Bank Fifteen Minutes Ago/,
      );
    },
    30000,
  );
});

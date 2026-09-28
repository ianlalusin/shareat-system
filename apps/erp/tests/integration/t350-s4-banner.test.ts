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

/**
 * Inserts a real `audit_log` row for a `set_channel_payout` change, owner connection (bypasses
 * RLS). T-350 S5 — `before` is now significant, not filler: `before.moneyAccountId === null`
 * is what the page reads to tell a first SET from a later CHANGE (§S5). Defaults to a first set
 * (`before: null`) unless the caller passes `beforeAccountName` for the "changed" arm.
 */
async function auditRow(
  f: Pick<Fixture, 'orgId' | 'channelId'>,
  input: { actorPersonId: string; afterName: string; occurredAt?: Date; beforeAccountName?: string },
) {
  const before =
    input.beforeAccountName === undefined
      ? { moneyAccountId: null, moneyAccountName: null }
      : { moneyAccountId: uid('acct-before'), moneyAccountName: input.beforeAccountName };
  await sql`
    insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, occurred_at)
    values (
      ${f.orgId}, ${input.actorPersonId}, 'set_channel_payout', 'sales_channels', ${f.channelId},
      ${sql.json(before)},
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
  const raw = m ? m[1]! : '';
  // React escapes every apostrophe/quote/ampersand in a text node — normalise so every leg's
  // exact-sentence comparison can use plain punctuation, same idiom as
  // t343-s6b-admin-users-labels.test.ts and siblings.
  return raw.replace(/&#x27;/gi, "'").replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
}

/**
 * T-350 S5 (APPROVED 2026-09-29) — every negative leg below now asserts the FULL absence of a
 * success banner, not merely the absence of the word "changed": S4's own bug (the reviewed commit
 * abe22f2) was a banner that still rendered, just with the wrong sentence ("No change" instead of
 * nothing). `bannerText(html) === ''` is the assertion that catches that class of regression;
 * `.not.toMatch(/Payout account changed/i)` alone would not.
 */
describe('G2/S5 — a forged URL with NO backing audit_log row shows no banner at all', () => {
  it(
    'wanted: no banner at all when nothing in audit_log backs it — was red today: the banner is ' +
      'built entirely from the URL plus the channel\'s CURRENT name, with no audit_log read anywhere',
    async () => {
      const f = await fixture('g2-forged');
      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);
      expect(banner, 'wanted no banner element at all with zero audit_log rows for this channel').toBe('');
      expect(banner).not.toMatch(/Payout account set/);
      expect(banner).not.toMatch(/Payout account changed/i);
      expect(banner).not.toMatch(/No change/);
    },
    30000,
  );
});

describe('S5 — a real, recent FIRST SET by the viewer shows the "set" sentence', () => {
  it(
    'wanted: "Payout account set. <after name> is where this channel\'s settlements bank." — was ' +
      'red today: the page has no such sentence at all; any banner it shows says "changed" ' +
      'regardless of before.moneyAccountId',
    async () => {
      const f = await fixture('g2-set');
      // auditRow defaults to before: null (a first set) unless beforeAccountName is passed.
      await auditRow(f, { actorPersonId: f.viewerId, afterName: 'Bank At Set Time' });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(banner, 'wanted the exact "set" sentence naming the captured after-account').toBe(
        "Payout account set. Bank At Set Time is where this channel's settlements bank.",
      );
      expect(banner, 'must not read as a "changed" claim').not.toMatch(/Payout account changed/);
    },
    30000,
  );
});

describe('S5 — a real, recent CHANGE by the viewer shows the "changed" sentence, naming the audit row\'s own after-account', () => {
  it(
    'wanted: the banner names the CAPTURED after.moneyAccountName from the audit row, not the ' +
      'channel\'s current live name — was red today: the banner (when shown at all) reads the ' +
      'LIVE channel, never audit_log, so it would show "Bank Live ..." instead of the captured name',
    async () => {
      const f = await fixture('g2-changed');
      await auditRow(f, {
        actorPersonId: f.viewerId,
        afterName: 'Bank At Change Time',
        beforeAccountName: 'Bank Before Change',
      });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(banner, 'wanted the exact "changed" sentence naming the captured after-account').toBe(
        'Payout account changed. New settlements bank into Bank At Change Time.',
      );
      expect(
        banner,
        'the banner must not fall back to the channel\'s current LIVE account name instead',
      ).not.toMatch(/Bank Live/);
      expect(banner, 'must not read as a "set" claim').not.toMatch(/Payout account set\./);
    },
    30000,
  );
});

describe('G2/S5 — ANOTHER person\'s change shows no banner to this viewer', () => {
  it(
    'wanted: a recent row exists but was written by someone else, so no banner at all — was red ' +
      'today: the banner shows regardless of who is viewing, since actor is never consulted',
    async () => {
      const f = await fixture('g2-other-person');
      await auditRow(f, { actorPersonId: f.otherPersonId, afterName: 'Bank Someone Else Chose' });

      const html = await renderAsViewer(f, bannerParams(f));
      const banner = bannerText(html);

      expect(banner, 'wanted NO banner at all when the audit row belongs to a different actor').toBe('');
      expect(banner, 'the other person\'s account name must not leak into this viewer\'s banner').not.toMatch(
        /Bank Someone Else Chose/,
      );
    },
    30000,
  );
});

describe('G2/S5 — a row older than 10 minutes shows no banner at all', () => {
  it(
    'wanted: a row by the viewer exists but is stale (>10 min), so no banner at all — was red today: ' +
      'the banner has no time window at all, since it never reads audit_log',
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

      expect(banner, 'wanted NO banner at all once the audit row is stale (>10 minutes old)').toBe('');
      expect(banner, 'the stale row\'s account name must not appear either').not.toMatch(
        /Bank Fifteen Minutes Ago/,
      );
    },
    30000,
  );
});

describe('S5 — an unknown/unlisted channel id shows no banner, even with a fresh real row elsewhere', () => {
  it(
    'wanted: `changedChannel` pointing at a channel that does not exist in this org shows no banner ' +
      '— was red today (pre-S5): nothing on the page checks that changedChannel actually resolves ' +
      'to a real, listed channel before trusting whatever audit_log read follows',
    async () => {
      const f = await fixture('g2-unknown');
      // A perfectly fresh, viewer-authored row exists — but for the REAL channel, not the bogus id
      // the request names. If the page fails to look up the bogus id (or worse, ignores the id and
      // reads "the latest row for this org" generically), this leg is the one that catches it.
      await auditRow(f, { actorPersonId: f.viewerId, afterName: 'Bank For Real Channel' });

      const bogusChannelId = '00000000-0000-0000-0000-000000000000';
      const html = await renderAsViewer(f, {
        ok: 'destination',
        changed: '1',
        changedChannel: bogusChannelId,
      });
      const banner = bannerText(html);

      expect(banner, 'wanted NO banner at all for an unknown/unlisted channel id').toBe('');
      expect(banner, 'the real channel\'s account name must not leak in via a mismatched id').not.toMatch(
        /Bank For Real Channel/,
      );
    },
    30000,
  );
});

describe('S5 — `?same=1` is ignored: no "No change" sentence ever, with or without a backing row', () => {
  it(
    'wanted: same=1 has no special handling at all — a same-account save writes no audit row, so ' +
      'this renders no banner; the point is that NOTHING reads the same param to synthesize a ' +
      '"No change" sentence from the channel\'s current (non-audit) data — was red today: the page ' +
      'has a dedicated `sameChannel` branch keyed on `sp.same === \'1\'` that does exactly that',
    async () => {
      const f = await fixture('g2-same-ignored');
      // Deliberately NO audit row — this is the real shape of a same-account save (S5 §domain: the
      // no-op writes nothing).
      const html = await renderAsViewer(f, {
        ok: 'destination',
        same: '1',
        changedChannel: f.channelId,
      });
      const banner = bannerText(html);

      expect(banner, 'wanted no "No change" sentence, ever').not.toMatch(/No change/);
      expect(banner, 'wanted no banner at all for a same=1 with nothing in audit_log').toBe('');
    },
    30000,
  );

  it(
    'same=1 alongside a genuine fresh CHANGE row still shows the "changed" sentence, never "No change" ' +
      '— proves same=1 is inert rather than special-cased away, one way or the other',
    async () => {
      const f = await fixture('g2-same-ignored-with-row');
      await auditRow(f, {
        actorPersonId: f.viewerId,
        afterName: 'Bank Despite Same Flag',
        beforeAccountName: 'Bank Before',
      });
      const html = await renderAsViewer(f, {
        ok: 'destination',
        same: '1',
        changedChannel: f.channelId,
      });
      const banner = bannerText(html);

      expect(banner, 'wanted the ordinary "changed" sentence, same=1 must not suppress or alter it').toBe(
        'Payout account changed. New settlements bank into Bank Despite Same Flag.',
      );
      expect(banner).not.toMatch(/No change/);
    },
    30000,
  );
});

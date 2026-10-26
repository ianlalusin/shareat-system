/**
 * T-350 S5 — `docs/tasks/350-def-477-change-channel-payout-account.md` §S5 (APPROVED 2026-09-29).
 *
 * ⛔ TESTER, not BUILDER. S5's rule, in full: after a payout save the action redirects to
 * `?ok=destination&changedChannel=<id>` and NOTHING else about what happened — no `changed=1`,
 * no `same=1`. The page then reads that channel's latest `set_channel_payout` audit_log row
 * (viewer is the actor, < 10 min old, this org) and derives the sentence PURELY from that row's
 * `before`/`after`:
 *   - `before.moneyAccountId` null -> "Payout account set. <after name> is where this channel's
 *     settlements bank."
 *   - otherwise -> "Payout account changed. New settlements bank into <after name>."
 *   - no qualifying row (a same-account save writes none) -> no banner at all.
 *
 * Today (S4, pre-S5): the action still appends `changed=1`/`same=1` to the redirect, and the page
 * still special-cases `same=1` with a "No change" sentence read from the channel's CURRENT data,
 * not from `audit_log`. Both of those are the target this file pins.
 *
 * Three legs, each the REAL thing end to end: real sign-in (`setPin` + `signInWithPin`, same idiom
 * as `t350-channel-payout-change.test.ts`'s G1), the real `setPayoutDestinationAction`, following
 * its thrown `RedirectSignal` into a real render of `ChannelSettlementsPage` against real Postgres
 * — same idiom as `t350-s4-banner.test.ts`. No mocked `auditLogRepo`, no mocked `heldCapabilities`.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { pageParamsOf, paramsOf as flashParamsOf } from '../helpers/flash-jar';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

// Same idiom as t350-channel-payout-change.test.ts's G1: redirect() throws to unwind, a fake
// cookie jar carries a REAL session token so requireActor()/requireSession() both resolve a real
// actor, exactly as the button would.
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
}));

class FakeJar {
  store = new Map<string, string>();
  set(name: string, value: string) {
    this.store.set(name, value);
  }
  get(name: string) {
    const v = this.store.get(name);
    return v === undefined ? undefined : { name, value: v };
  }
  delete(name: string) {
    this.store.delete(name);
  }
}
let jar: FakeJar;
vi.mock('next/headers', () => ({
  cookies: async () => jar,
}));

// ⛔ NOT a stub — forwards to the real module. Both actions.ts and page.tsx import the bare
// `@/...` specifier the root vitest.config.mts never resolves (s5-5p/s5-5q precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

async function fixture(hint: string) {
  const code = uid(`t350s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const { seedChartOfAccounts } = await import('../../../../packages/db/seed/chart-of-accounts');
  await seedChartOfAccounts(sql, orgId);

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Store A') returning id`;
  const storeId = store!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeId}, 'manual')`;

  const mkAccount = async (label: string) => {
    const [a] = await sql<{ id: string; name: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${label}, 'bank', '1140', 'office') returning id, name`;
    return a!;
  };
  const bankA = await mkAccount(`Bank A ${uid('m')}`);
  const bankB = await mkAccount(`Bank B ${uid('m')}`);

  return { orgId, storeId, adminId, bankA, bankB };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function insertChannel(f: Fixture, hint: string, destinationAccountId: string | null) {
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${f.orgId}, ${f.storeId}, ${`Foodpanda ${uid(hint)}`}, false, '1220', ${destinationAccountId})
    returning id`;
  return channel!.id;
}

async function signInAsAdmin(f: Fixture) {
  const { setPin, signInWithPin } = await import('@shareat/auth');
  const { transaction, APP_ROLE } = await import('@shareat/db');
  const { sql: dsql } = await import('drizzle-orm');
  const asOrg = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    transaction(async (tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${f.orgId}, true)`);
      return fn(tx);
    });
  await asOrg((tx) => setPin(tx as never, { orgId: f.orgId, personId: f.adminId, storeId: f.storeId, pin: '117733' }));
  const signIn = await asOrg((tx) => signInWithPin(tx as never, { orgId: f.orgId, storeId: f.storeId, pin: '117733' }));
  jar = new FakeJar();
  jar.set('shareat_session', signIn.token);
}

/** Same slice idiom as t350-s4-banner.test.ts's own bannerText, isolated from the rest of the page. */
function bannerText(html: string): string {
  const m = /<div class="rounded-lg border border-emerald-300[^"]*">([\s\S]*?)<\/div>/.exec(html);
  const raw = m ? m[1]! : '';
  // React escapes every apostrophe/quote/ampersand in a text node — normalise so every leg's
  // exact-sentence comparison can use plain punctuation, same idiom as
  // t343-s6b-admin-users-labels.test.ts and siblings.
  return raw.replace(/&#x27;/gi, "'").replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
}

/** The redirect's banner + navigation keys, read through `outcomeOf` (T-380 S1b) — the jar is this file's own fake. */
const paramsOf = (redirectTo: string): URLSearchParams => flashParamsOf(redirectTo, jar);

async function saveAndRender(
  f: Fixture,
  input: { channelId: string; moneyAccountId: string },
): Promise<{ html: string; redirectTo: string }> {
  const { setPayoutDestinationAction } = await import('../../src/app/channel-settlements/actions');
  const fd = new FormData();
  fd.set('channelId', input.channelId);
  fd.set('moneyAccountId', input.moneyAccountId);

  let caught: unknown;
  try {
    await setPayoutDestinationAction(fd);
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the action to redirect').toBeInstanceOf(RedirectSignal);
  const redirectTo = (caught as RedirectSignal).to;

  const ChannelSettlementsPage = (await import('../../src/app/channel-settlements/page')).default;
  const searchParams = pageParamsOf(redirectTo, jar);
  const element = await ChannelSettlementsPage({ searchParams: Promise.resolve(searchParams) });
  const html = renderToStaticMarkup(element as never);
  return { html, redirectTo };
}

afterAll(async () => {
  await sql.end();
});

describe('S5 round-trip — a first SET, action -> redirect -> render', () => {
  it(
    'wanted: "Payout account set. <account> is where this channel\'s settlements bank." and a ' +
      'redirect carrying ONLY ok=destination&changedChannel=<id> — was red today: the action still ' +
      'appends changed=1/same=1, and the page has no "set" sentence at all (only "changed")',
    async () => {
      const f = await fixture('set');
      const channelId = await insertChannel(f, 'set', null);
      await signInAsAdmin(f);

      const { html, redirectTo } = await saveAndRender(f, { channelId, moneyAccountId: f.bankA.id });

      const params = paramsOf(redirectTo);
      expect([...params.keys()].sort(), `wanted only ok+changedChannel — got ${redirectTo}`).toEqual(
        ['changedChannel', 'ok'].sort(),
      );
      expect(params.get('ok')).toBe('destination');
      expect(params.get('changedChannel')).toBe(channelId);

      expect(bannerText(html), 'wanted the "set" sentence naming the new account').toBe(
        `Payout account set. ${f.bankA.name} is where this channel's settlements bank.`,
      );
    },
    30000,
  );
});

describe('S5 round-trip — a CHANGE, action -> redirect -> render', () => {
  it(
    'wanted: "Payout account changed. New settlements bank into <account>." and the same bare ' +
      'redirect shape — was red today: the page derives "changed" from the URL\'s changed=1 flag, ' +
      'not from audit_log\'s before.moneyAccountId',
    async () => {
      const f = await fixture('changed');
      const channelId = await insertChannel(f, 'chg', f.bankA.id);
      await signInAsAdmin(f);

      const { html, redirectTo } = await saveAndRender(f, { channelId, moneyAccountId: f.bankB.id });

      const params = paramsOf(redirectTo);
      expect([...params.keys()].sort(), `wanted only ok+changedChannel — got ${redirectTo}`).toEqual(
        ['changedChannel', 'ok'].sort(),
      );

      expect(bannerText(html), 'wanted the "changed" sentence naming the NEW account').toBe(
        `Payout account changed. New settlements bank into ${f.bankB.name}.`,
      );
    },
    30000,
  );
});

describe('S5 round-trip — a SAME-ACCOUNT save, action -> redirect -> render', () => {
  it(
    'wanted: no banner at all (no audit row was written) and still the same bare redirect shape — ' +
      'was red today: the page reads ?same=1 and renders a "No change — ..." sentence sourced from ' +
      'the channel\'s CURRENT data, never audit_log',
    async () => {
      const f = await fixture('same');
      const channelId = await insertChannel(f, 'same', f.bankA.id);
      await signInAsAdmin(f);

      const { html, redirectTo } = await saveAndRender(f, { channelId, moneyAccountId: f.bankA.id });

      const params = paramsOf(redirectTo);
      expect([...params.keys()].sort(), `wanted only ok+changedChannel — got ${redirectTo}`).toEqual(
        ['changedChannel', 'ok'].sort(),
      );

      const banner = bannerText(html);
      expect(banner, 'wanted no banner element at all for a same-account no-op').toBe('');
      expect(banner).not.toMatch(/Payout account set/);
      expect(banner).not.toMatch(/Payout account changed/);
      expect(banner).not.toMatch(/No change/);
    },
    30000,
  );
});

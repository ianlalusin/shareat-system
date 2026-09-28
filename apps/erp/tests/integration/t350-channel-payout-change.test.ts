/**
 * T-350 — an admin can change a channel's payout account after it is set (DEF-477).
 * `docs/tasks/350-def-477-change-channel-payout-account.md`.
 *
 * ⛔ TESTER, not BUILDER. `setChannelPayoutDestination` (`packages/domain/src/channel-settlements/
 * index.ts`) still gates on `manage_store_settings` (manager: true), has no same-account no-op
 * check, and its four refusals are still raw `throw new Error(...)` — no `.userMessage`.
 *
 * ⚠️ SPEC MISMATCH, doc-internal: line 20 ("Ian's ruling: ADMIN ONLY", manager ✗) and lines 24-25
 * ("A manager now sees the account but neither the unwired panel's form nor Change") directly
 * contradict line 59 ("R1 (render): a wired channel card for a MANAGER shows 'Change'") and the
 * leg list's own C1 ("an actor with manage_store_settings" — the capability the ruling replaces).
 * Read consistently with the ruling (dated the same day, and the one that names `set_channel_payout`
 * explicitly): C1/R1 use an ADMIN actor below, not a manager — manager is C6/R3's actor, refused.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, signInWithPin, setPin, type Actor } from '@shareat/auth';
import { setChannelPayoutDestination } from '@shareat/domain';

// ============================================================================================
// G1 (S4) — the ACTION's own redirect, not the domain function. `next/navigation`'s `redirect()`
// throws to unwind, exactly like `sign-out-action.test.ts`'s own `RedirectSignal` — same idiom,
// not Next's internal digest format. Real sign-in (`setPin` + `signInWithPin`) puts a real session
// token in a fake cookie jar so `requireActor()` resolves a real actor, exactly as the button would.
// ============================================================================================
class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
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
let g1Jar: FakeJar;
vi.mock('next/headers', () => ({
  cookies: async () => g1Jar,
}));

// ⛔ NOT a stub — forwards to the real module. `actions.ts` imports the bare `@/...` specifier the
// root `vitest.config.mts` never resolves (s5-5p/s5-5q, t343-s5-5r-render precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t350-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Store A') returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('b')}, 'Store B') returning id`;
  const otherStoreId = otherStore!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  const mkAccount = async (label: string, storeIdFor: string, isActive = true) => {
    const [a] = await sql<{ id: string; name: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgId}, ${storeIdFor}, ${label}, 'bank', '1140', 'office', ${isActive}) returning id, name`;
    return a!;
  };
  const bankA = await mkAccount(`Bank A ${uid('m')}`, storeId);
  const bankB = await mkAccount(`Bank B ${uid('m')}`, storeId);
  const otherStoreAccount = await mkAccount(`Other store account ${uid('m')}`, otherStoreId);
  const retiredAccount = await mkAccount(`Retired account ${uid('m')}`, storeId, false);

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bankA.id})
    returning id`;

  return {
    orgId, storeId, otherStoreId,
    admin: actor(orgId, admin!.id),
    manager: actor(orgId, manager!.id),
    channelId: channel!.id,
    bankA, bankB, otherStoreAccount, retiredAccount,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setDestinationCaught(
  f: Pick<Fixture, 'orgId' | 'admin'>,
  input: { channelId: string; moneyAccountId: string },
): Promise<(Error & { userMessage?: string }) | undefined> {
  let caught: unknown;
  try {
    await asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, input));
  } catch (err) {
    caught = err;
  }
  return caught as (Error & { userMessage?: string }) | undefined;
}

// T-350 S2, F4/F8 (orchestrator ruling, 2026-09-28) — C3/C6 must pin the AUTHORIZATION refusal
// specifically (the repo's `AuthorizationError`, capability `set_channel_payout`), not any throw —
// a plain `.rejects.toThrow()` would pass just as happily for a refusal that fired for the WRONG
// reason (a not-found channel, a bad account) as for the right one.
async function expectAuthorizationRefusal(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a refusal at all').toBeInstanceOf(AuthorizationError);
  expect((caught as AuthorizationError).capability).toBe('set_channel_payout');
}

async function channelRow(channelId: string) {
  const [row] = await sql<{ destination_money_account_id: string | null; updated_at: Date }[]>`
    select destination_money_account_id, updated_at from sales_channels where id = ${channelId}`;
  return row!;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('C1 — admin changes a wired channel from A to B (⛔ green, unedited — say so)', () => {
  it('destination reads B afterwards', async () => {
    const f = await fixture('c1');
    await asOrg(f.orgId, (tx) =>
      setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
    );
    const row = await channelRow(f.channelId);
    expect(row.destination_money_account_id).toBe(f.bankB.id);
  });
});

describe('C2 (S5.5x?) — choosing the same account again writes nothing', () => {
  it(
    'wanted: updated_at unchanged (no-op, not yet built) — observed today (measured, not presumed): ' +
      'setDestinationAccount always runs its UPDATE, so updated_at moves even when the value does not',
    async () => {
      const f = await fixture('c2');
      // ⚠️ The fixture's INSERT sets destination_money_account_id directly — it never runs through
      // setDestinationAccount, so updated_at is NULL at this point (column has no default, see
      // packages/db/schema/sales-days.ts:135). A `before` snapshot taken here would be null and
      // `.getTime()` would throw, which is a broken harness, not a red on the assertion that
      // matters. Prime one real stamp first — a REAL change (bankA -> bankB), since the no-op
      // check now built means priming with the account already in place (bankA) would itself be
      // the no-op and leave updated_at NULL forever.
      await asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
      );
      const before = await channelRow(f.channelId);
      await new Promise((r) => setTimeout(r, 20));
      await asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
      );
      const after = await channelRow(f.channelId);
      expect(after.updated_at.getTime(), 'updated_at should not move for a same-account no-op').toBe(
        before.updated_at.getTime(),
      );
    },
  );
});

describe('C3 — an actor without the right at that store is refused (⚠️ doc-internal mismatch, see file header)', () => {
  it(
    'wanted: a manager is refused once set_channel_payout replaces manage_store_settings (Ian, ' +
      'admin only) — observed today (measured, not presumed): manage_store_settings grants manager ' +
      'true, so the manager actor succeeds',
    async () => {
      const f = await fixture('c3');
      await expectAuthorizationRefusal(
        asOrg(f.orgId, (tx) =>
          setChannelPayoutDestination(tx, f.manager, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
        ),
      );
    },
  );
});

describe('C4 — another store\'s account → the human "belongs to another store" sentence', () => {
  it(
    'wanted: refuse(...) carrying .userMessage — observed today (measured, not presumed): a raw ' +
      '`throw new Error(...)`, no .userMessage',
    async () => {
      const f = await fixture('c4');
      const err = await setDestinationCaught(f, { channelId: f.channelId, moneyAccountId: f.otherStoreAccount.id });
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage, 'wanted the named sentence — was red: no userMessage (a raw Error)').toBe(
        `${f.otherStoreAccount.name} belongs to another store. A channel banks into its own store's ` +
          'account — moving money between stores is a transfer, not a setting.',
      );
    },
  );
});

describe('C5 — a retired account → the human "retired" sentence', () => {
  it(
    'wanted: refuse(...) carrying .userMessage — observed today (measured, not presumed): a raw ' +
      '`throw new Error(...)`, no .userMessage',
    async () => {
      const f = await fixture('c5');
      const err = await setDestinationCaught(f, { channelId: f.channelId, moneyAccountId: f.retiredAccount.id });
      expect(err, 'expected a refusal at all').toBeInstanceOf(Error);
      expect(err?.userMessage, 'wanted the named sentence — was red: no userMessage (a raw Error)').toBe(
        `${f.retiredAccount.name} is retired, so nothing can be banked into it.`,
      );
    },
  );
});

describe('C6 (extra, admin only) — a manager is refused BOTH a first set and a change', () => {
  it('first set on an unwired channel: manager refused', async () => {
    const f = await fixture('c6-first');
    const [unwired] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${f.orgId}, ${f.storeId}, ${`GrabFood ${uid('c')}`}, false, '1220') returning id`;
    await expectAuthorizationRefusal(
      asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.manager, { channelId: unwired!.id, moneyAccountId: f.bankA.id }),
      ),
    );
  });

  it('change on an already-wired channel: manager refused', async () => {
    const f = await fixture('c6-change');
    await expectAuthorizationRefusal(
      asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.manager, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
      ),
    );
  });
});

describe('C7 (S2, F3) — a same-account no-op result carries wrote:false', () => {
  it(
    'the domain result says nothing was written, so the action never sets changed=1 for it — was ' +
      'red before this fix landed (see history); tightened here to assert on the RESULT the action reads',
    async () => {
      const f = await fixture('c7');
      // Prime a real stamp first, same reasoning as C2's own fixture note.
      await asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
      );
      const result = await asOrg(f.orgId, (tx) =>
        setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id }),
      );
      expect(result.hadAccountBefore, 'setup: the channel already had an account').toBe(true);
      expect(
        (result as { wrote?: boolean }).wrote,
        'wanted: a same-account no-op reports wrote:false, which is what the action must gate changed=1 on',
      ).toBe(false);
    },
  );
});

describe('C8 (S2, F4/F8) — held at store A only, channel at store B → refused', () => {
  it(
    'an actor holding set_channel_payout ONLY at store A is refused for a channel at store B (cross-store, not role) — ' +
      'the authorization refusal, not any throw',
    async () => {
      const f = await fixture('c8');
      const [otherChannel] = await sql<{ id: string }[]>`
        insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                    destination_money_account_id)
        values (${f.orgId}, ${f.otherStoreId}, ${`Foodpanda B ${uid('c')}`}, false, '1220', ${f.otherStoreAccount.id})
        returning id`;
      // The admin fixture is scoped to storeId (A) only — never otherStoreId (B), so this exercises
      // the cross-store axis (authorize.ts's store-scope check), not a role/capability gap.
      await expectAuthorizationRefusal(
        asOrg(f.orgId, (tx) =>
          setChannelPayoutDestination(tx, f.admin, { channelId: otherChannel!.id, moneyAccountId: f.otherStoreAccount.id }),
        ),
      );
    },
  );
});

describe('G1 (S4) — the ACTION redirect for a same-account save carries no changed=1', () => {
  it(
    'a same-account Save redirects with no changed=1 — this catches a builder reverting ' +
      '`changed = result.wrote && result.hadAccountBefore` back to `changed = result.wrote` alone: ' +
      'C7 above only pins the DOMAIN result (result.wrote === false), never that the ACTION actually ' +
      'reads it — a regression there would leave C7 green while this goes red',
    async () => {
      const f = await fixture('g1');
      g1Jar = new FakeJar();

      await asOrg(f.orgId, (tx) =>
        setPin(tx, { orgId: f.orgId, personId: f.admin.personId, storeId: f.storeId, pin: '117733' }),
      );
      const signIn = await asOrg(f.orgId, (tx) =>
        signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: '117733' }),
      );
      g1Jar.set('shareat_session', signIn.token);

      const { setPayoutDestinationAction } = await import('../../src/app/channel-settlements/actions');

      // f.channelId already banks into f.bankA (the fixture's own INSERT) — choosing it again is
      // the no-op case.
      const fd = new FormData();
      fd.set('channelId', f.channelId);
      fd.set('moneyAccountId', f.bankA.id);

      let caught: unknown;
      try {
        await setPayoutDestinationAction(fd);
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected the action to redirect (success or error)').toBeInstanceOf(RedirectSignal);
      const to = (caught as RedirectSignal).to;
      expect(to, `wanted no changed=1 on a same-account no-op — got ${to}`).not.toMatch(/changed=1/);
    },
  );
});

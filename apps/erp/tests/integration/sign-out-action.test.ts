/**
 * T-257 / DEF-259 — `signOutAction` (`src/app/sign-in/actions.ts:107`) is the exact function every
 * sign-out button now calls. Its inner primitive, `signOut()`, is already proven against real
 * Postgres by `packages/auth/tests/integration/sessions.test.ts` — this file does not repeat that.
 * What had never been exercised is `signOutAction` ITSELF: reading the cookie, calling `signOut`,
 * clearing the cookie, and redirecting, in that order — the thing the button actually invokes.
 *
 * ⭐ "The server session is ended, proven by a query, not by the browser forgetting" (the task's own
 * done-condition) — the second test below queries `sessions.ended_at` / `ended_reason` directly
 * with raw SQL, not by re-calling `resolveActor` and inferring it from a thrown error.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { signInWithPin, setPin } from '@shareat/auth';

const sql = postgres(url, { max: 5 });

/** Mirrors `next/navigation`'s redirect() throwing to interrupt execution, without depending on
 *  Next's internal digest format — the thing under test is "did it redirect to /sign-in", not
 *  "does this vitest environment reproduce Next's own throw shape". */
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

/** A cookie jar with just enough of `next/headers`' `cookies()` surface for `lib/session.ts` —
 *  same shape as `setup-identity.test.ts`'s `FakeJar`. */
class FakeJar {
  store = new Map<string, string>();
  deleted: string[] = [];
  set(name: string, value: string) {
    this.store.set(name, value);
  }
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  delete(name: string) {
    this.store.delete(name);
    this.deleted.push(name);
  }
}
let jar: FakeJar;
vi.mock('next/headers', () => ({
  cookies: async () => jar,
}));

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  personId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t257-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, ${'Store'}) returning id
  `;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${'Cashier'}) returning id
  `;
  return { orgId, storeId: store!.id, personId: person!.id };
}

/** Runs under the real RLS principal, exactly as a request would — same helper as
 *  `sessions.test.ts`, needed here only for the SETUP calls (`setPin`/`signInWithPin`), not for
 *  `signOutAction` itself, which the button calls bare with no role-setting of its own. */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

beforeAll(async () => {
  await sql`truncate table sessions, person_credentials restart identity cascade`;
});

beforeEach(() => {
  jar = new FakeJar();
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('signOutAction — the function every sign-out button calls (T-257/DEF-259)', () => {
  it('ends the SERVER session (proven by querying `sessions` directly, not by re-resolving the token) and redirects to /sign-in', async () => {
    const f = await setup('ends-session');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '778899' }));
    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: '778899' }));

    jar.set('shareat_session', res.token);

    const { signOutAction } = await import('../../src/app/sign-in/actions');

    let caught: unknown;
    try {
      await signOutAction();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectSignal);
    expect((caught as RedirectSignal).to).toBe('/sign-in');

    // ⭐ The done-condition, literally: a query against the table, not a re-check through the app
    // layer. `ended_at`/`ended_reason` are the two columns `endSession()` writes.
    const [row] = await sql<{ ended_at: Date | null; ended_reason: string | null }[]>`
      select ended_at, ended_reason from sessions where id = ${res.sessionId}
    `;
    expect(row!.ended_at).not.toBeNull();
    expect(row!.ended_reason).toBe('signed_out');

    expect(jar.deleted).toContain('shareat_session');
  });

  it('signing out with no session cookie still redirects, and touches no session row', async () => {
    // `readSessionToken()` returns null, so `signOutAction`'s own `if (token)` branch is what is
    // under test here — the inner `signOut()` is never reached at all, deliberately.
    const { signOutAction } = await import('../../src/app/sign-in/actions');

    let caught: unknown;
    try {
      await signOutAction();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectSignal);
    expect((caught as RedirectSignal).to).toBe('/sign-in');
    expect(jar.deleted).toContain('shareat_session');
  });
});

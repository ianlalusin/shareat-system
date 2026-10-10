/**
 * `npm run smoke:pin-throttle` - T-395 S2. Drives the real sign-in path end to end against a TEST
 * database: 50 wrong PINs stop a store (a correct PIN is then refused), a manager reopens it, and the
 * correct PIN works again. Refuses to run unless TEST_DATABASE_URL names a `_test` database.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url || !/shareat_test|_test(\?|$)/.test(url)) {
  console.error('TEST_DATABASE_URL must be set and name a "_test" database. Refusing to run.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

import postgres from 'postgres';

const WRONG = '000000';
const GOOD = '482913';

function check(label: string, pass: boolean): void {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
  if (!pass) process.exitCode = 1;
}

async function main() {
  const { closeDb, withOrgPrincipal } = await import('@shareat/db');
  const { signInWithPin, setPin, reopenPinSignIn, AuthenticationError } = await import('@shareat/auth');
  const sql = postgres(url!, { max: 2 });
  try {
    const code = `smoke-${Date.now()}`;
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${code}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${code}, ${'Smoke Store'}) returning id`;
    const storeId = store!.id;
    const mk = async (name: string, role: string | null) => {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
      if (role) {
        await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
        await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual')`;
      }
      return p!.id;
    };
    const cashier = await mk('Smoke Cashier', null);
    const managerId = await mk('Smoke Manager', 'manager');
    const [dev] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, 'Smoke Till', 'terminal') returning id`;
    await withOrgPrincipal(orgId, (tx) => setPin(tx, { orgId, personId: cashier, storeId, pin: GOOD }));

    const attempt = async (pin: string) => {
      try {
        await signInWithPin(null, { orgId, storeId, pin, deviceId: dev!.id });
        return 'ok';
      } catch (e) {
        return e instanceof AuthenticationError ? e.message : `unexpected: ${String(e)}`;
      }
    };

    let stopped = false;
    for (let i = 0; i < 60 && !stopped; i++) {
      // Tier 1 pauses a store after 10 misses in a minute; back-date it so only tier 2 can bind.
      await sql`update pin_attempt_throttle set window_started_at = now() - interval '2 minutes', locked_until = null, fail_count = 0 where store_id = ${storeId}`;
      stopped = /stopped/.test(await attempt(WRONG));
    }
    const misses = (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId} and kind = 'miss'`)[0]!.n;
    check(`store stopped after exactly 50 misses (saw ${misses})`, stopped && misses === 50);
    check('a correct PIN is refused while stopped', /stopped/.test(await attempt(GOOD)));

    const actor = { personId: managerId, orgId };
    const r = await withOrgPrincipal(orgId, (tx) => reopenPinSignIn(tx, actor, storeId));
    check('manager reopen succeeds', r.reopened);
    check('the correct PIN works after the reopen', (await attempt(GOOD)) === 'ok');
  } finally {
    await sql.end({ timeout: 5 });
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * T-232 slice 1 — what a verified Firebase identity means in this system, against real Postgres.
 * `docs/tasks/232-email-sign-in-and-first-run-setup.md` §Slices, decision 5.
 *
 * ## ⭐ Why these three cases and not a mocked action
 *
 * The sign-in *decision* is three database facts (`apps/erp/src/app/sign-in/lib.ts`), and every one
 * of them is a real query: a credential row that resolves to a person, an `organizations` table that
 * is empty, an `organizations` table that is not. Mocking any of that would assert only that the
 * `if`s are spelled the way the test spells them. So these run the real function inside a real
 * transaction on a real database, and the branch is chosen by rows.
 *
 * The cookies and the redirects stay in `sign-in/actions.ts`, deliberately untested here — they need
 * a request, and testing them against a mocked cookie store proves nothing about the browser.
 *
 * ## ⛔ The case that matters most is the middle one
 *
 * `first-run` is the branch that hands out a token to create the organisation. It must be reachable
 * ONLY on a genuinely empty database, so case 3 and case 4 are its two negative controls: an
 * unknown account on a system that IS set up gets a sentence, whether or not any Firebase account is
 * linked to it. Without those two, case 2 would still pass against a function that always said
 * `first-run` — and that function would let any stranger with a Google account open `/setup`.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, transaction, systemTransaction } from '@shareat/db';
import { resolveActor, BROWSER_SESSION_TTL_MS } from '@shareat/auth';
import { bootstrapOrganization } from '@shareat/domain';
import { NOT_LINKED_MESSAGE, resolveVerifiedSignIn } from '../../apps/erp/src/app/sign-in/lib';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
const sql = postgres(url, { max: 3 });

let seq = 0;
const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** ⚠️ Every case starts from a genuinely empty database, because "zero organizations" is the fact
 *  the whole first-run branch turns on — a fixture that left one behind would test the wrong branch
 *  and still be green. Same table list as `first-run-setup.test.ts`. */
beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_store_scope, person_grants, person_roles,
      stock_locations, location_types, sales_channels, stores, persons,
      expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const countOf = async (table: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int n from ${sql(table)}`;
  return row!.n;
};

/**
 * The first run, exactly as `/setup` will do it — with a verified uid — or as the CLI does it.
 * ⭐ systemTransaction, not withOrgPrincipal — same reason as organizations.test.ts:
 * bootstrapOrganization is only ever reached in production via systemTransaction()
 * (apps/erp/src/app/setup/actions.ts), and there is no org yet to scope a principal to.
 */
async function firstRun(firebaseUid: string | null) {
  return systemTransaction((tx) =>
    bootstrapOrganization(tx, {
      code: unique('ORG').toUpperCase(),
      name: 'Shareat Test Organisation',
      adminDisplayName: 'Ian Lalusin',
      storeCode: 'MAIN01',
      storeName: 'First Store',
      pin: '123456',
      firebaseUid,
    }),
  );
}

describe('T-232 slice 1 — a verified Firebase identity resolves to one of three outcomes', () => {
  it('⭐ case 1: a linked uid is SIGNED IN, and the token it returns resolves to that person', async () => {
    const uid = unique('firebase-uid');
    const bootstrapped = await firstRun(uid);

    const outcome = await resolveVerifiedSignIn(uid);

    expect(outcome.kind).toBe('signed-in');
    if (outcome.kind !== 'signed-in') return; // narrowing; the assertion above is the check
    expect(outcome.personId).toBe(bootstrapped.personId);

    // ⭐ The point of the whole slice: the token is usable. `resolveActor` is what every page calls,
    // so this is "Ian signs in and sees the app" asserted rather than implied.
    // DEF-288: `null`, so the auth entry point opens its own `authTransaction` — exactly what
    // production does now (`sign-in/actions.ts`, `lib/session.ts`). Handing it a bare
    // `transaction()` here would test a path no caller uses any more.
    const session = await resolveActor(null, outcome.token);
    expect(session.actor.personId).toBe(bootstrapped.personId);
    expect(session.actor.orgId).toBe(bootstrapped.orgId);
    expect(session.credentialKind).toBe('firebase');
    // ⚠️ A browser session is bound to no store, unlike a terminal's. `storeId` is how the rest of
    // the app tells them apart, so it is asserted rather than assumed.
    expect(session.storeId).toBeNull();

    // A browser session, not a terminal one — one person on one machine (7 days, not 12 hours).
    const ttl = outcome.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(BROWSER_SESSION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(BROWSER_SESSION_TTL_MS);
  });

  it('⭐ case 2: an unknown uid on an EMPTY database is first-run, and nothing is written', async () => {
    const outcome = await resolveVerifiedSignIn(unique('stranger'));

    expect(outcome).toEqual({ kind: 'first-run' });
    // ⛔ A refused sign-in must not leave a session behind. The decision reads; it never writes.
    expect(await countOf('sessions')).toBe(0);
    expect(await countOf('organizations')).toBe(0);
  });

  it('⛔ case 3: an unknown uid once an organization EXISTS is refused, not sent to setup', async () => {
    // The CLI path — an organisation with a PIN admin and NO firebase credential anywhere. This is
    // the harder negative control: nothing about Firebase exists in this database, and the branch
    // must still close, because it turns on the organisation and not on the credential.
    await firstRun(null);

    const outcome = await resolveVerifiedSignIn(unique('stranger'));

    expect(outcome).toEqual({ kind: 'not-linked' });
    expect(await countOf('sessions')).toBe(0);
  });

  it('⛔ case 4: an unknown uid alongside an already-linked one is refused too', async () => {
    // The lived shape: Ian is set up and signed in, and somebody else's Google account arrives.
    await firstRun(unique('firebase-uid'));

    const outcome = await resolveVerifiedSignIn(unique('stranger'));

    expect(outcome).toEqual({ kind: 'not-linked' });
    expect(await countOf('sessions')).toBe(0);
  });

  it('the refusal sentence is the ratified wording, not a paraphrase', () => {
    // ⚠️ Pinned deliberately. It is the one sentence an administrator will be shown, agreed with
    // Ian on 2026-09-08, and it names the action to take — which is the half a domain-level
    // "not linked" message cannot know.
    expect(NOT_LINKED_MESSAGE).toBe(
      'This account is not linked to a person. Ask an administrator to link it',
    );
  });
});

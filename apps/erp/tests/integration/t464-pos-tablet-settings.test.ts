import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-464 - `/settings/pos-tablet` server actions, end to end against Postgres with the REAL session and cookie helpers (the global
 * flash-jar setup fakes `next/headers`). docs/tasks/464-pos-tablet-sign-in.md s2.
 *
 *   - pairing as the store's manager: the pairing cookie holds a secret that resolves to the new live pairing, the manager's OWN session is
 *     ended and its cookie cleared, and the browser is sent to /sign-in;
 *   - a staff member and a manager of ANOTHER store are refused with a sentence: no cookie, no row, no signed-out manager;
 *   - un-pairing: the wrong label is refused (still paired), the right label (case/space-insensitive, like every Tier R confirm) revokes;
 *     a forged non-uuid id is "not paired", never a database error; a manager of another store cannot un-pair.
 * Runs on ANY `_test` database; every row uses fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

import { currentJar, RedirectSignal } from '../../../../tests/helpers/flash-jar-core';
import { outcomeOf } from '../../../../tests/helpers/flash-jar';
import { closeDb } from '@shareat/db';
import { hashPin, pinLookupHash, resolveActor, resolvePosTablet, signInWithPin, POS_TABLET_COOKIE } from '@shareat/auth';

vi.mock('next/navigation', async () => {
  const core = await import('../../../../tests/helpers/flash-jar-core');
  return {
    redirect: (to: string) => {
      throw new core.RedirectSignal(to);
    },
    notFound: () => {
      throw new Error('notFound() called');
    },
  };
});

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;

async function fixture() {
  const code = uid('t464e');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const store = async (n: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${n}) returning id`)[0]!.id;
  const storeA = await store('Lipa');
  const storeB = await store('Malvar');
  /** A person with a PIN who can sign in (a manager with store scope and no employment is admitted by R1 leg c). */
  const person = async (name: string, role: string, scope: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scope}, 'manual')`;
    const pin = String(520100 + ++pinSeq);
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${id}, 'pin', ${scope}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { id, pin, scope };
  };
  const managerA = await person('Manager A', 'manager', storeA);
  const managerB = await person('Manager B', 'manager', storeB);
  const staffA = await person('Staff A', 'staff', storeA);
  // a cashier signs in only with an open employment (T-407 R1)
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeA}, ${staffA.id}, 'SE-001', 'regular', '2026-01-01')`;
  /** Signs `who` in (a real session) and puts its token in the cookie jar, as the browser would hold it. */
  const signedInAs = async (who: { pin: string; scope: string }) => {
    const s = await signInWithPin(null, { orgId, storeId: who.scope, pin: who.pin });
    currentJar().set('shareat_session', s.token, {});
    return s.token;
  };
  return { orgId, storeA, storeB, managerA, managerB, staffA, signedInAs };
}

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

async function run(action: (fd: FormData) => Promise<void>, fd: FormData) {
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return outcomeOf(e);
    throw e;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  const jar = currentJar();
  jar.store.clear();
});

const liveCount = async (storeId: string) => (await sql`select 1 from pos_tablet_pairings where store_id = ${storeId} and revoked_at is null`).length;

describe('pairPosTabletAction', () => {
  it('the store\'s manager pairs: the cookie resolves to the new pairing, the manager is signed out (server session ended, cookie cleared), and the browser goes to /sign-in', async () => {
    const { pairPosTabletAction } = await import('../../src/app/settings/pos-tablet/actions');
    const f = await fixture();
    const sessionToken = await f.signedInAs(f.managerA);

    const out = await run(pairPosTabletAction, form({ storeId: f.storeA, label: '  Lipa   counter ' }));
    expect(out.path).toBe('/sign-in');

    const cookie = currentJar().get(POS_TABLET_COOKIE)?.value;
    expect(cookie, 'mutant: the pairing cookie was not set').toBeTruthy();
    const options = currentJar().store.get(POS_TABLET_COOKIE)!.options;
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(Number(options.maxAge), '400 days').toBe(400 * 24 * 60 * 60);
    const pairing = await resolvePosTablet(null, cookie);
    expect(pairing).toMatchObject({ orgId: f.orgId, storeId: f.storeA, label: 'Lipa counter' });

    // the manager's own session is gone: the server-side session ended and the cookie cleared
    await expect(resolveActor(null, sessionToken), 'mutant: the manager stays signed in on the tablet').rejects.toThrow();
    expect(currentJar().has('shareat_session')).toBe(false);
    expect(await liveCount(f.storeA)).toBe(1);
    const audit = await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos_tablet.paired'`;
    expect(audit).toHaveLength(1);
  });

  it('a staff member and a manager of ANOTHER store are refused with a sentence: no cookie, no row, the person stays signed in', async () => {
    const { pairPosTabletAction } = await import('../../src/app/settings/pos-tablet/actions');
    const f = await fixture();
    for (const who of [f.staffA, f.managerB]) {
      const token = await f.signedInAs(who);
      const out = await run(pairPosTabletAction, form({ storeId: f.storeA, label: 'Sneaky' }));
      expect(out.path).toBe('/settings/pos-tablet');
      expect(out.flash.error, 'a refusal in words').toBeTruthy();
      expect(currentJar().has(POS_TABLET_COOKIE), 'no cookie for a refused pairing').toBe(false);
      await expect(resolveActor(null, token), 'still signed in').resolves.toBeTruthy();
    }
    expect(await liveCount(f.storeA)).toBe(0);
  });
});

describe('unpairPosTabletAction', () => {
  async function paired(f: Awaited<ReturnType<typeof fixture>>) {
    const { pairPosTabletAction } = await import('../../src/app/settings/pos-tablet/actions');
    await f.signedInAs(f.managerA);
    await run(pairPosTabletAction, form({ storeId: f.storeA, label: 'Lipa counter' }));
    const id = (await sql<{ id: string }[]>`select id from pos_tablet_pairings where store_id = ${f.storeA} and revoked_at is null`)[0]!.id;
    const cookie = currentJar().get(POS_TABLET_COOKIE)!.value;
    currentJar().store.clear();
    return { id, cookie };
  }

  it('the wrong label is refused and the tablet stays paired; the right label un-pairs; a second try says it is not paired', async () => {
    const { unpairPosTabletAction } = await import('../../src/app/settings/pos-tablet/actions');
    const f = await fixture();
    const p = await paired(f);
    await f.signedInAs(f.managerA);

    const wrong = await run(unpairPosTabletAction, form({ pairingId: p.id, confirmName: 'Malvar counter' }));
    expect(wrong.flash.error).toMatch(/Type the name exactly/);
    expect((await resolvePosTablet(null, p.cookie))?.pairingId, 'mutant: un-paired without the label').toBe(p.id);

    const blank = await run(unpairPosTabletAction, form({ pairingId: p.id, confirmName: '' }));
    expect(blank.flash.error, 'an empty confirm never matches').toBeTruthy();
    expect(await liveCount(f.storeA)).toBe(1);

    const ok = await run(unpairPosTabletAction, form({ pairingId: p.id, confirmName: '  LIPA  counter ' }));
    expect(ok.flash.ok).toMatch(/un-paired/i);
    expect(await resolvePosTablet(null, p.cookie), 'the tablet\'s cookie is dead now').toBeNull();
    expect(await liveCount(f.storeA)).toBe(0);
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos_tablet.unpaired'`).toHaveLength(1);

    const again = await run(unpairPosTabletAction, form({ pairingId: p.id, confirmName: 'Lipa counter' }));
    expect(again.flash.error).toMatch(/not paired/i);
  });

  it('a manager of another store cannot un-pair (even with the right label); a forged id is "not paired", never a database error', async () => {
    const { unpairPosTabletAction } = await import('../../src/app/settings/pos-tablet/actions');
    const f = await fixture();
    const p = await paired(f);
    await f.signedInAs(f.managerB);

    const out = await run(unpairPosTabletAction, form({ pairingId: p.id, confirmName: 'Lipa counter' }));
    expect(out.flash.error, 'mutant: capability not checked at the pairing\'s store').toBeTruthy();
    expect((await resolvePosTablet(null, p.cookie))?.pairingId).toBe(p.id);

    for (const forged of ['not-a-uuid', "x'; drop table pos_tablet_pairings; --", '']) {
      const o = await run(unpairPosTabletAction, form({ pairingId: forged, confirmName: 'Lipa counter' }));
      expect(o.flash.error, forged).toMatch(/not paired/i);
    }
  });
});

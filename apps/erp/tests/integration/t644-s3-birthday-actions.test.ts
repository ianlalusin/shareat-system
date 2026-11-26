import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-644 S3 - the birthday Server Actions (`apps/erp/src/app/pos/lobby/actions.ts`) with REAL Postgres and the REAL T-455 staff twins. Only the session, `next/cache` and
 * `next/navigation` are replaced. Any scratch "_test" database (nothing pins a lane database). docs/tasks/644-lobby-in-erp-pos.md, S3.
 * Fixture: packages/domain/tests/integration/_fixtures/t525-pos.ts (counter = record_sale at store A; kitchen = NO record_sale; admin holds both stores; pairingToken = store A's tablet).
 *
 * MUTANT INDEX (each title ends with "[kills: ...]"): a list that shows another store's requests; an accept / decline / played that answers ok without writing; a request of ANOTHER store
 * moved through the pairing's store (drop `onlyStoreId` in the staff twin -> red); a person without record_sale; no pairing; a store taken from the body; a decline reason typed by
 * hand reaching the database; a time or reason bounded BEFORE the store check (auth first); a bad id reaching the database; a played that skips the accepted state.
 */
const HOLD = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string }, token: null as string | null }));
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: HOLD.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));

import { parkWalkIn } from '../../../../packages/domain/src/lobby/staff';
import { asOrg, closeAll, fixture, sql, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

type Out = { ok: boolean; error?: string } & Record<string, unknown>;
async function call(name: 'listBirthdaysAction' | 'acceptBirthdayAction' | 'declineBirthdayAction' | 'markBirthdayPlayedAction', as: { orgId: string; personId: string }, input: unknown, token: string | null = null): Promise<Out> {
  const m = await import('../../src/app/pos/lobby/actions');
  HOLD.actor = as;
  HOLD.token = token;
  return name === 'listBirthdaysAction' ? m.listBirthdaysAction() : (m[name] as (i: unknown) => Promise<Out>)(input);
}

/** A walk-in on the line at `storeId` with one birthday request on it, in the state asked for. */
async function request(f: Fx, storeId: string, state: 'requested' | 'accepted' = 'requested', celebrant = 'Ben'): Promise<string> {
  const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId, displayName: 'Ana', partySize: 4 }));
  const [b] = await sql<{ id: string }[]>`insert into lobby_birthday_requests (org_id, entry_id, celebrant_name, status) values (${f.orgId}, ${parked.entryId}, ${celebrant}, 'requested') returning id`;
  if (state === 'accepted') await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = now() + interval '20 minutes' where id = ${b!.id}`;
  return b!.id;
}
const rowOf = async (id: string) => (await sql<{ status: string; decline_reason: string | null; scheduled_at: Date | null }[]>`select status, decline_reason, scheduled_at from lobby_birthday_requests where id = ${id}`)[0]!;
const auditCount = async (id: string, action: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from audit_log where entity_id = ${id} and action = ${action}`)[0]!.n);
const oneSentence = (s: unknown) => {
  expect(typeof s).toBe('string');
  expect((s as string).length).toBeGreaterThan(10);
  expect(s, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
};
const inTwentyMinutes = () => new Date(Date.now() + 20 * 60_000).toISOString();

describe('listBirthdaysAction', () => {
  it('the paired tablet sees ONLY its own store requests, with ISO times and no phone, hash or link [kills: a list that shows another store, a list that leaks the diner phone]', async () => {
    const f = await fixture();
    const mine = await request(f, f.storeId, 'requested', 'Ben');
    const acc = await request(f, f.storeId, 'accepted', 'Cy');
    await request(f, f.store2Id, 'requested', 'Elsewhere');
    const r = await call('listBirthdaysAction', f.counter, {}, f.pairingToken);
    expect(r.ok).toBe(true);
    const rows = r.birthdays as Record<string, unknown>[];
    expect(rows.map((x) => x.requestId).sort()).toEqual([mine, acc].sort());
    expect(rows.map((x) => x.celebrantName)).not.toContain('Elsewhere');
    const accepted = rows.find((x) => x.requestId === acc)!;
    expect(typeof accepted.scheduledAt).toBe('string');
    expect(typeof accepted.createdAt).toBe('string');
    expect(Object.keys(accepted).sort()).toEqual(['celebrantName', 'code', 'createdAt', 'displayName', 'requestId', 'scheduledAt', 'standLabel', 'status']);
  });

  it('a person without record_sale is refused with a sentence and sees nothing [kills: a list that skips the record_sale check]', async () => {
    const f = await fixture();
    await request(f, f.storeId);
    const r = await call('listBirthdaysAction', f.kitchen, {}, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect(r.birthdays).toBeUndefined();
  });

  it('with no pairing (a laptop) it is refused [kills: a list that works on any browser]', async () => {
    const f = await fixture();
    await request(f, f.storeId);
    const r = await call('listBirthdaysAction', f.counter, {}, null);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect(r.birthdays).toBeUndefined();
  });
});

describe('acceptBirthdayAction', () => {
  it('the paired tablet accepts at a time: the row is accepted with that time and one audit row is written [kills: an accept that answers ok without writing]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const at = inTwentyMinutes();
    const r = await call('acceptBirthdayAction', f.counter, { requestId: id, scheduledAt: at }, f.pairingToken);
    expect(r).toEqual({ ok: true, scheduledAt: at });
    const row = await rowOf(id);
    expect(row.status).toBe('accepted');
    expect(row.scheduled_at?.toISOString()).toBe(at);
    expect(await auditCount(id, 'lobby.birthday_accept')).toBe(1);
  });

  it('a request of ANOTHER store is refused like a ghost id and stays requested, even for a person who holds record_sale at both stores [kills: an accept that trusts the request id instead of the pairing store]', async () => {
    const f = await fixture();
    const other = await request(f, f.store2Id);
    const r = await call('acceptBirthdayAction', f.admin, { requestId: other, scheduledAt: inTwentyMinutes() }, f.pairingToken);
    const ghost = await call('acceptBirthdayAction', f.admin, { requestId: uuid(), scheduledAt: inTwentyMinutes() }, f.pairingToken);
    expect(r.ok).toBe(false);
    expect(ghost.ok).toBe(false);
    expect(r.error).toBe(ghost.error);
    expect((await rowOf(other)).status).toBe('requested');
  });

  it('a store named in the body is ignored: the pairing decides [kills: a store read from the body]', async () => {
    const f = await fixture();
    const other = await request(f, f.store2Id);
    const r = await call('acceptBirthdayAction', f.admin, { storeId: f.store2Id, requestId: other, scheduledAt: inTwentyMinutes() }, f.pairingToken);
    expect(r.ok).toBe(false);
    expect((await rowOf(other)).status).toBe('requested');
  });

  it('a person without record_sale, or a browser with no pairing, is refused and the request stays requested [kills: an accept that skips the record_sale check or the pairing]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const noCap = await call('acceptBirthdayAction', f.kitchen, { requestId: id, scheduledAt: inTwentyMinutes() }, f.pairingToken);
    const noPair = await call('acceptBirthdayAction', f.counter, { requestId: id, scheduledAt: inTwentyMinutes() }, null);
    for (const r of [noCap, noPair]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
    }
    expect((await rowOf(id)).status).toBe('requested');
  });

  it('no time, a loose date and a bad id are refused and change nothing; a person who may not act here gets the access refusal, not the time rule [kills: an accept with no time, a loose date accepted, a time bounded before the store check]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const noTime = await call('acceptBirthdayAction', f.counter, { requestId: id }, f.pairingToken);
    expect(noTime).toEqual({ ok: false, error: 'Please pick a time for the birthday song first.' });
    const loose = await call('acceptBirthdayAction', f.counter, { requestId: id, scheduledAt: 'tomorrow evening' }, f.pairingToken);
    expect(loose.ok).toBe(false);
    oneSentence(loose.error);
    const badId = await call('acceptBirthdayAction', f.counter, { requestId: 'nope', scheduledAt: inTwentyMinutes() }, f.pairingToken);
    expect(badId).toEqual({ ok: false, error: 'Choose a birthday request from the list.' });
    const noAccess = await call('acceptBirthdayAction', f.kitchen, { requestId: id }, f.pairingToken);
    expect(noAccess.ok).toBe(false);
    expect(noAccess.error).not.toBe(noTime.error);
    expect(await rowOf(id)).toMatchObject({ status: 'requested', scheduled_at: null });
  });

  it('accepting twice answers a sentence the second time and the first time stands [kills: a second accept that overwrites the time]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const first = inTwentyMinutes();
    expect((await call('acceptBirthdayAction', f.counter, { requestId: id, scheduledAt: first }, f.pairingToken)).ok).toBe(true);
    const again = await call('acceptBirthdayAction', f.counter, { requestId: id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }, f.pairingToken);
    expect(again.ok).toBe(false);
    oneSentence(again.error);
    expect((await rowOf(id)).scheduled_at?.toISOString()).toBe(first);
  });
});

describe('declineBirthdayAction', () => {
  it('one of the three fixed reasons declines: the row is declined with that reason and one audit row is written [kills: a decline that answers ok without writing]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const r = await call('declineBirthdayAction', f.counter, { requestId: id, reason: 'Too busy right now' }, f.pairingToken);
    expect(r).toEqual({ ok: true });
    expect(await rowOf(id)).toMatchObject({ status: 'declined', decline_reason: 'Too busy right now' });
    expect(await auditCount(id, 'lobby.birthday_decline')).toBe(1);
  });

  it('a reason typed by hand is refused with a sentence before the database is touched, blank too [kills: a free-text decline reason reaching the database]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    for (const reason of ['The kitchen is on fire', '', '   ', 'too busy right now', 'Too busy right now ']) {
      const r = await call('declineBirthdayAction', f.counter, { requestId: id, reason }, f.pairingToken);
      expect(r, JSON.stringify(reason)).toEqual({ ok: false, error: 'Choose a reason to decline.' });
    }
    expect(await call('declineBirthdayAction', f.counter, { requestId: id }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a reason to decline.' });
    expect(await rowOf(id)).toMatchObject({ status: 'requested', decline_reason: null });
  });

  it('no record_sale + bad reason gives the access refusal, not the reason one [kills: a preset check before authorize]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId);
    const good = await call('declineBirthdayAction', f.kitchen, { requestId: id, reason: 'Too busy right now' }, f.pairingToken);
    const bad = await call('declineBirthdayAction', f.kitchen, { requestId: id, reason: 'The kitchen is on fire' }, f.pairingToken);
    expect(good.ok).toBe(false);
    expect(bad).toEqual(good);
    expect(bad.error).not.toBe('Choose a reason to decline.');
    expect(await rowOf(id)).toMatchObject({ status: 'requested', decline_reason: null });
  });

  it('a request of ANOTHER store, a person without record_sale and a browser with no pairing are all refused and the request stays requested [kills: a decline across stores, without the capability, or without the pairing]', async () => {
    const f = await fixture();
    const other = await request(f, f.store2Id);
    const mine = await request(f, f.storeId);
    const reason = 'Not available today';
    const across = await call('declineBirthdayAction', f.admin, { requestId: other, reason }, f.pairingToken);
    const ghost = await call('declineBirthdayAction', f.admin, { requestId: uuid(), reason }, f.pairingToken);
    expect(across.ok).toBe(false);
    expect(across.error).toBe(ghost.error);
    for (const r of [await call('declineBirthdayAction', f.kitchen, { requestId: mine, reason }, f.pairingToken), await call('declineBirthdayAction', f.counter, { requestId: mine, reason }, null)]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
    }
    expect((await rowOf(other)).status).toBe('requested');
    expect((await rowOf(mine)).status).toBe('requested');
  });
});

describe('markBirthdayPlayedAction', () => {
  it('an accepted request becomes played with one audit row [kills: a played that answers ok without writing]', async () => {
    const f = await fixture();
    const id = await request(f, f.storeId, 'accepted');
    expect(await call('markBirthdayPlayedAction', f.counter, { requestId: id }, f.pairingToken)).toEqual({ ok: true });
    expect((await rowOf(id)).status).toBe('played');
    expect(await auditCount(id, 'lobby.birthday_play')).toBe(1);
  });

  it('a request that was never accepted cannot be marked played, and a second report is refused with a sentence [kills: a played that skips the accepted state]', async () => {
    const f = await fixture();
    const fresh = await request(f, f.storeId, 'requested');
    const r = await call('markBirthdayPlayedAction', f.counter, { requestId: fresh }, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect(r.final, 'a request that is not accepted is final').toBe(true);
    expect((await rowOf(fresh)).status).toBe('requested');
    const acc = await request(f, f.storeId, 'accepted');
    expect((await call('markBirthdayPlayedAction', f.counter, { requestId: acc }, f.pairingToken)).ok).toBe(true);
    const twice = await call('markBirthdayPlayedAction', f.counter, { requestId: acc }, f.pairingToken);
    expect(twice.ok).toBe(false);
    oneSentence(twice.error);
  });

  it('a request of ANOTHER store, a person without record_sale, no pairing and a bad id are refused and nothing changes [kills: a played across stores, without the capability, without the pairing, or with an unchecked id]', async () => {
    const f = await fixture();
    const other = await request(f, f.store2Id, 'accepted');
    const mine = await request(f, f.storeId, 'accepted');
    const across = await call('markBirthdayPlayedAction', f.admin, { requestId: other }, f.pairingToken);
    const ghost = await call('markBirthdayPlayedAction', f.admin, { requestId: uuid() }, f.pairingToken);
    expect(across.ok).toBe(false);
    expect(across.error).toBe(ghost.error);
    for (const r of [await call('markBirthdayPlayedAction', f.kitchen, { requestId: mine }, f.pairingToken), await call('markBirthdayPlayedAction', f.counter, { requestId: mine }, null)]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
      expect(r.final, 'an access or pairing refusal may pass: not final [kills: every refusal final]').toBeUndefined();
    }
    expect(across.final, 'another store looks like a ghost id: final').toBe(true);
    expect(await call('markBirthdayPlayedAction', f.counter, { requestId: 'nope' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a birthday request from the list.' });
    expect((await rowOf(other)).status).toBe('accepted');
    expect((await rowOf(mine)).status).toBe('accepted');
  });
});

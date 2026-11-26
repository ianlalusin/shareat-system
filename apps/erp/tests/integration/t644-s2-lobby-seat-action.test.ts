import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-644 S2 - `seatLobbyEntryAction` (`apps/erp/src/app/pos/lobby/actions.ts`) with REAL Postgres and the REAL T-455 staff twin `seatEntry`. Only the session, `next/cache` and
 * `next/navigation` are replaced. Any scratch "_test" database (nothing pins a lane database). docs/tasks/644-lobby-in-erp-pos.md, S2.
 * Fixture: packages/domain/tests/integration/_fixtures/t525-pos.ts (counter = record_sale at store A; kitchen = NO record_sale; admin holds both stores; pairingToken = store A's tablet).
 *
 * MUTANT INDEX (each title ends with "[kills: ...]"): a seat that answers ok without writing; a seat of ANOTHER store's entry through the pairing's store (drop `onlyStoreId` in `seatEntry` -> red);
 * a person without record_sale; a stand label bounded BEFORE the store check (auth-first); a store taken from the body; a bad entry or session id reaching the database; a join link stored.
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
import { asOrg, closeAll, fixture, sql, uuid } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

async function seat(as: { orgId: string; personId: string }, input: unknown, token: string | null = null) {
  const m = await import('../../src/app/pos/lobby/actions');
  HOLD.actor = as;
  HOLD.token = token;
  return (m.seatLobbyEntryAction as (i: unknown) => Promise<{ ok: boolean; error?: string; entryId?: string }>)(input);
}
const row = async (id: string) => (await sql<{ status: string; session_ref: string | null; stand_label: string | null; handoff_url: string | null }[]>`select status, session_ref, stand_label, handoff_url from lobby_entries where id = ${id}`)[0]!;
const oneSentence = (s: unknown) => {
  expect(typeof s).toBe('string');
  expect((s as string).length).toBeGreaterThan(10);
  expect(s, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
};

describe('seatLobbyEntryAction', () => {
  it('the paired tablet seats the party: the entry ends seated with the session and the stand, and NO join link is kept [kills: a seat that answers ok without writing, or one that stores a made-up join link]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Ana', partySize: 4 }));
    const sessionId = uuid();
    const r = await seat(f.counter, { entryId: parked.entryId, sessionId, standLabel: '5' }, f.pairingToken);
    expect(r).toEqual({ ok: true, entryId: parked.entryId });
    expect(await row(parked.entryId)).toEqual({ status: 'seated', session_ref: sessionId, stand_label: '5', handoff_url: null });
    const audit = await sql<{ action: string; store_id: string }[]>`select action, store_id from audit_log where entity = 'lobby_entry' and entity_id = ${parked.entryId} and action = 'lobby.seat'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.store_id).toBe(f.storeId);
  });

  it('an entry of ANOTHER store is refused with a sentence and changes nothing, even for a person who holds record_sale at both stores [kills: a seat that trusts the entry id instead of the pairing store]', async () => {
    const f = await fixture();
    const other = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.store2Id, displayName: 'Elsewhere', partySize: 2 }));
    const r = await seat(f.admin, { entryId: other.entryId, sessionId: uuid(), standLabel: '5' }, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect(await row(other.entryId)).toMatchObject({ status: 'waiting', session_ref: null, stand_label: null });
  });

  it('a store named in the body is ignored: the pairing decides, and the answer for another store entry is the same as for a ghost id [kills: a store read from the body, an entry probe across stores]', async () => {
    const f = await fixture();
    const other = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.store2Id, displayName: 'Elsewhere', partySize: 2 }));
    const viaBody = await seat(f.admin, { storeId: f.store2Id, entryId: other.entryId, sessionId: uuid(), standLabel: '5' }, f.pairingToken);
    const ghost = await seat(f.admin, { entryId: uuid(), sessionId: uuid(), standLabel: '5' }, f.pairingToken);
    expect(viaBody.ok).toBe(false);
    expect(ghost.ok).toBe(false);
    expect(viaBody.error).toBe(ghost.error);
    expect((await row(other.entryId)).status).toBe('waiting');
  });

  it('a person without record_sale is refused and the entry stays waiting [kills: a seat that skips the record_sale check]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Ben', partySize: 2 }));
    const r = await seat(f.kitchen, { entryId: parked.entryId, sessionId: uuid(), standLabel: '5' }, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect((await row(parked.entryId)).status).toBe('waiting');
  });

  it('with no pairing (a laptop) nothing is seated [kills: a seat that works on any browser]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Cy', partySize: 2 }));
    const r = await seat(f.counter, { entryId: parked.entryId, sessionId: uuid(), standLabel: '5' }, null);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect((await row(parked.entryId)).status).toBe('waiting');
  });

  it('a stand label over 20 characters is refused by the domain with its own sentence and the entry stays waiting; a person who may not act here gets the access refusal instead, not the rule [kills: a label that is stored unbounded, a rule checked before the store check]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Di', partySize: 2 }));
    const long = 'x'.repeat(21);
    const bad = await seat(f.counter, { entryId: parked.entryId, sessionId: uuid(), standLabel: long }, f.pairingToken);
    expect(bad).toEqual({ ok: false, error: 'Choose a stand (up to 20 characters).' });
    const noAccess = await seat(f.kitchen, { entryId: parked.entryId, sessionId: uuid(), standLabel: long }, f.pairingToken);
    expect(noAccess.ok).toBe(false);
    expect(noAccess.error).not.toBe('Choose a stand (up to 20 characters).');
    expect(await row(parked.entryId)).toMatchObject({ status: 'waiting', stand_label: null });
  });

  it('a bad entry id, a bad session id and a blank stand are refused before anything is written [kills: an unchecked id reaching the database]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Ed', partySize: 2 }));
    expect(await seat(f.counter, { entryId: 'nope', sessionId: uuid(), standLabel: '5' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a party from the list.' });
    expect(await seat(f.counter, { entryId: parked.entryId, sessionId: 'not-a-uuid', standLabel: '5' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a party from the list.' });
    const blank = await seat(f.counter, { entryId: parked.entryId, sessionId: uuid(), standLabel: '   ' }, f.pairingToken);
    expect(blank.ok).toBe(false);
    oneSentence(blank.error);
    expect((await row(parked.entryId)).status).toBe('waiting');
  });

  it('seating twice answers a sentence the second time and the first seat stands [kills: a second seat that overwrites the table of a party already seated]', async () => {
    const f = await fixture();
    const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Flo', partySize: 2 }));
    const first = uuid();
    expect((await seat(f.counter, { entryId: parked.entryId, sessionId: first, standLabel: '5' }, f.pairingToken)).ok).toBe(true);
    const again = await seat(f.counter, { entryId: parked.entryId, sessionId: uuid(), standLabel: '6' }, f.pairingToken);
    expect(again.ok).toBe(false);
    oneSentence(again.error);
    expect(await row(parked.entryId)).toMatchObject({ status: 'seated', session_ref: first, stand_label: '5' });
  });
});

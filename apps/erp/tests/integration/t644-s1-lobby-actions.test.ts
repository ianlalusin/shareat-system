import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-644 S1 - the Lobby Server Actions (`apps/erp/src/app/pos/lobby/actions.ts`) with REAL Postgres and the REAL T-455 staff twins. Only the session, `next/cache` and
 * `next/navigation` are replaced. Any scratch "_test" database (nothing pins a lane database). docs/tasks/644-lobby-in-erp-pos.md rulings 1-3.
 * Fixture: packages/domain/tests/integration/_fixtures/t525-pos.ts (counter = record_sale at store A; kitchen = NO record_sale; pairingToken = store A's tablet).
 *
 * MUTANT INDEX (each title ends with "[kills: ...]"): a list action that does not stamp pos_seen_at; any action that skips record_sale; a store taken from the body
 * on a paired tablet; call / remove of another store's entry through the pairing's store; a bad entry id reaching the database; pause that does not round-trip; a list that stamps with no pairing or with another store's pairing (drop the pairing check in `atStore(..., true)` -> red).
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
import { asOrg, closeAll, fixture, sql, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

const NAMES = ['listLobbyAction', 'parkWalkInAction', 'callEntryAction', 'removeEntryAction', 'setLobbyPausedAction'] as const;
async function act(name: (typeof NAMES)[number], as: { orgId: string; personId: string }, input: unknown, token: string | null = null) {
  const m = await import('../../src/app/pos/lobby/actions');
  HOLD.actor = as;
  HOLD.token = token;
  return (m[name] as (i: unknown) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>)(input);
}

const lobbyRow = async (storeId: string) => (await sql<{ paused: boolean; pos_seen_at: Date | null }[]>`select paused, pos_seen_at from lobby_stores where store_id = ${storeId}`)[0];
const withLobbyStore = (f: Fx, storeId: string) =>
  sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at) values (${f.orgId}, ${storeId}, true, false, 60, ${null})`;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from lobby_entries where id = ${id}`)[0]!.status;
const countAt = async (storeId: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from lobby_entries where store_id = ${storeId}`)[0]!.n);
const oneSentence = (s: unknown) => {
  expect(typeof s).toBe('string');
  expect((s as string).length).toBeGreaterThan(10);
  expect(s, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
};

describe('listLobbyAction: the list and the stamp', () => {
  it('on the paired tablet it answers the line AND stamps pos_seen_at at the pairing\'s store [kills: a list action that does not stamp, so diners cannot check in]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.storeId, displayName: 'Ana', partySize: 4 }));
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
    const r = await act('listLobbyAction', f.counter, { storeId: f.storeId }, f.pairingToken);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ lobbyEnabled: true, paused: false });
    expect((r.entries as { displayName: string; partySize: number; createdAt: string }[]).map((e) => [e.displayName, e.partySize])).toEqual([['Ana', 4]]);
    expect(typeof (r.entries as { createdAt: string }[])[0]!.createdAt, 'times are ISO text, safe to send').toBe('string');
    const seen = (await lobbyRow(f.storeId))!.pos_seen_at;
    expect(seen).not.toBeNull();
    expect(Date.now() - seen!.getTime()).toBeLessThan(60_000);
  });

  it('a person without record_sale is REFUSED with a sentence, nothing is stamped [kills: any action that skips the record_sale check]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    const r = await act('listLobbyAction', f.kitchen, { storeId: f.storeId }, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
    const w = await act('parkWalkInAction', f.kitchen, { storeId: f.storeId, displayName: 'Nope', partySize: 2 }, f.pairingToken);
    expect(w.ok).toBe(false);
    expect(await countAt(f.storeId)).toBe(0);
  });
});

describe('the list stamps only from a paired tablet of the same store', () => {
  it('no pairing token (a laptop) is refused and pos_seen_at stays null [kills: a list that stamps for any record_sale holder with no pairing]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    const r = await act('listLobbyAction', f.counter, { storeId: f.storeId }, null);
    expect(r).toEqual({ ok: false, error: "Open the lobby on the store's paired tablet." });
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
  });

  it('a pairing of ANOTHER store cannot stamp this store [kills: a list that stamps the store named in the body after a pairing of a different store]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    await withLobbyStore(f, f.store2Id);
    const r = await act('listLobbyAction', f.admin, { storeId: f.store2Id }, f.pairingToken);
    expect(r.ok).toBe(false);
    oneSentence(r.error);
    expect((await lobbyRow(f.store2Id))!.pos_seen_at).toBeNull();
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
  });
});

describe('the store comes from the pairing, never from the body', () => {
  it('a tablet paired at store A that names store B is refused with the one sentence; store B is not stamped and gets no walk-in [kills: a store read from the body on a paired tablet]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    await withLobbyStore(f, f.store2Id);
    const list = await act('listLobbyAction', f.admin, { storeId: f.store2Id }, f.pairingToken);
    expect(list).toEqual({ ok: false, error: 'This tablet works at one store only.' });
    const park = await act('parkWalkInAction', f.admin, { storeId: f.store2Id, displayName: 'Wrong store', partySize: 2 }, f.pairingToken);
    expect(park).toEqual({ ok: false, error: 'This tablet works at one store only.' });
    const pause = await act('setLobbyPausedAction', f.admin, { storeId: f.store2Id, paused: true }, f.pairingToken);
    expect(pause).toEqual({ ok: false, error: 'This tablet works at one store only.' });
    expect((await lobbyRow(f.store2Id))!.pos_seen_at).toBeNull();
    expect((await lobbyRow(f.store2Id))!.paused).toBe(false);
    expect(await countAt(f.store2Id)).toBe(0);
  });

  it('call and remove of an entry that belongs to ANOTHER store are refused and change nothing, even for a person who holds record_sale at both [kills: call/remove that trust the entry id instead of the pairing\'s store]', async () => {
    const f = await fixture();
    const other = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId: f.store2Id, displayName: 'Elsewhere', partySize: 2 }));
    for (const name of ['callEntryAction', 'removeEntryAction'] as const) {
      const r = await act(name, f.admin, { storeId: f.storeId, entryId: other.entryId }, f.pairingToken);
      expect(r.ok, name).toBe(false);
      oneSentence(r.error);
    }
    expect(await statusOf(other.entryId)).toBe('waiting');
  });

  it('a bad entry id is refused before the database, and a non-boolean pause is refused [kills: an unchecked id reaching a uuid cast]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    expect(await act('callEntryAction', f.counter, { storeId: f.storeId, entryId: 'not-a-uuid' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a party from the list.' });
    expect(await act('removeEntryAction', f.counter, { storeId: f.storeId }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a party from the list.' });
    expect(await act('setLobbyPausedAction', f.counter, { storeId: f.storeId, paused: 'yes' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose pause or resume.' });
    expect((await lobbyRow(f.storeId))!.paused).toBe(false);
  });
});

describe('the cashier\'s moves through the actions', () => {
  it('walk-in, call, remove: the line follows each move and the row ends removed [kills: an action that answers ok without writing]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    const parked = await act('parkWalkInAction', f.counter, { storeId: f.storeId, displayName: 'Ben', partySize: 3, phone: '0917 555 0100', note: 'window' }, f.pairingToken);
    expect(parked.ok).toBe(true);
    expect(String(parked.code)).toMatch(/^[1-9][0-9]{3}$/);
    const line = async () => (await act('listLobbyAction', f.counter, { storeId: f.storeId }, f.pairingToken)).entries as { entryId: string; status: string; displayName: string; phone: string; note: string }[];
    const [row] = await line();
    expect(row).toMatchObject({ displayName: 'Ben', status: 'waiting', phone: '0917 555 0100', note: 'window' });
    expect((await act('callEntryAction', f.counter, { storeId: f.storeId, entryId: row!.entryId }, f.pairingToken)).ok).toBe(true);
    expect((await line())[0]!.status).toBe('called');
    expect((await act('removeEntryAction', f.counter, { storeId: f.storeId, entryId: row!.entryId }, f.pairingToken)).ok).toBe(true);
    expect(await line()).toEqual([]);
    expect(await statusOf(row!.entryId)).toBe('removed');
  });

  it('a walk-in with no name or too many guests is refused with the domain\'s sentence and nothing is written', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    for (const bad of [{ displayName: '  ', partySize: 2 }, { displayName: 'Cy', partySize: 31 }, { displayName: 'Cy', partySize: 1.5 }]) {
      const r = await act('parkWalkInAction', f.counter, { storeId: f.storeId, ...bad }, f.pairingToken);
      expect(r.ok).toBe(false);
      oneSentence(r.error);
    }
    expect(await countAt(f.storeId)).toBe(0);
  });

  it('pause then resume round-trips through the actions and shows in the list [kills: a pause that does not stick or a resume that leaves it paused]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    expect(await act('setLobbyPausedAction', f.counter, { storeId: f.storeId, paused: true }, f.pairingToken)).toEqual({ ok: true, paused: true });
    expect((await act('listLobbyAction', f.counter, { storeId: f.storeId }, f.pairingToken)).paused).toBe(true);
    expect(await act('setLobbyPausedAction', f.counter, { storeId: f.storeId, paused: false }, f.pairingToken)).toEqual({ ok: true, paused: false });
    expect((await act('listLobbyAction', f.counter, { storeId: f.storeId }, f.pairingToken)).paused).toBe(false);
    expect((await lobbyRow(f.storeId))!.paused).toBe(false);
  });
});

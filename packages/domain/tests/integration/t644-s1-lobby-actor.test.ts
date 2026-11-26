import { afterAll, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@shareat/auth';

/**
 * T-644 S1 - the ERP POS's lobby twins in the domain: `listLobby` (the list + the `pos_seen_at` stamp), `setLobbyPaused`, and the `onlyStoreId` narrowing on
 * `callEntry` / `removeEntry`. Real Postgres on any scratch "_test" database (nothing pins a lane database); raw SQL is the oracle.
 * Fixture: _fixtures/t525-pos.ts (counter = everyday access = record_sale at store A; kitchen = serve_pos_ticket + request_pos_refill, NO record_sale).
 *
 * MUTANT INDEX (each title ends with "[kills: ...]"): list that does not stamp pos_seen_at / stamps another store / creates a lobby_stores row;
 * list without authorize(record_sale); pause or resume without the capability / not audited / without a row silently ok / paused stays after resume;
 * call or remove that ignores `onlyStoreId` (acts on another store's entry); `onlyStoreId` that refuses the store's own entry.
 */
import { asOrg, closeAll, fixture, sql, uid, type Fx } from './_fixtures/t525-pos';
import { callEntry, listLobby, parkWalkIn, removeEntry, setLobbyPaused } from '../../src/lobby/staff';
import { LobbyRefusal } from '../../src/lobby/refusal';

afterAll(closeAll);

const lobbyRow = async (storeId: string) => (await sql<{ paused: boolean; pos_seen_at: Date | null }[]>`select paused, pos_seen_at from lobby_stores where store_id = ${storeId}`)[0];
const withLobbyStore = (f: Fx, storeId: string, o: { enabled?: boolean; paused?: boolean } = {}) =>
  sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, pos_seen_at) values (${f.orgId}, ${storeId}, ${o.enabled ?? true}, ${o.paused ?? false}, 60, ${null})`;
const entryStatus = async (id: string) => (await sql<{ status: string }[]>`select status from lobby_entries where id = ${id}`)[0]!.status;
const audit = (f: Fx, storeId: string, action: string) =>
  sql<{ actor_person_id: string | null; before: unknown; after: unknown }[]>`select actor_person_id, before, after from audit_log where org_id = ${f.orgId} and store_id = ${storeId} and action = ${action} order by occurred_at, id`;
async function refusal(f: Fx, fn: Parameters<typeof asOrg>[1]): Promise<unknown> {
  try {
    await asOrg(f.orgId, fn);
  } catch (e) {
    return e;
  }
  return undefined;
}
const park = (f: Fx, storeId: string, name = uid('Diner')) => asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId, displayName: name, partySize: 3 }));

describe('T-644 S1 listLobby: the list and the stamp', () => {
  it('stamps lobby_stores.pos_seen_at, and only this store\'s row [kills: a list that does not stamp (diners then cannot check in), a stamp on the wrong store]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    await withLobbyStore(f, f.store2Id);
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
    const r = await asOrg(f.orgId, (tx) => listLobby(tx, f.counter, { storeId: f.storeId }));
    expect(r).toMatchObject({ lobbyEnabled: true, paused: false, entries: [] });
    const seen = (await lobbyRow(f.storeId))!.pos_seen_at;
    expect(seen).not.toBeNull();
    expect(Date.now() - seen!.getTime()).toBeLessThan(60_000);
    expect((await lobbyRow(f.store2Id))!.pos_seen_at, 'the other store was stamped').toBeNull();
  });

  it('returns the live line with its lines, oldest first, and reports paused [kills: lines dropped, closed entries listed]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId, { paused: true });
    const a = await park(f, f.storeId, 'First');
    const b = await park(f, f.storeId, 'Second');
    await asOrg(f.orgId, (tx) => removeEntry(tx, f.counter, b.entryId));
    const r = await asOrg(f.orgId, (tx) => listLobby(tx, f.counter, { storeId: f.storeId }));
    expect(r.paused).toBe(true);
    expect(r.entries.map((e) => e.entryId)).toEqual([a.entryId]);
    expect(r.entries[0]).toMatchObject({ displayName: 'First', partySize: 3, status: 'waiting', source: 'staff', lines: [] });
  });

  it('a store with no lobby_stores row lists as off and no row is created [kills: a list that fails or creates a row]', async () => {
    const f = await fixture();
    const r = await asOrg(f.orgId, (tx) => listLobby(tx, f.counter, { storeId: f.storeId }));
    expect(r).toMatchObject({ lobbyEnabled: false, paused: false, entries: [] });
    expect(await lobbyRow(f.storeId)).toBeUndefined();
  });

  it('a person without record_sale is REFUSED and nothing is stamped; another store\'s manager is refused too [kills: a list with no authorize(), an authorize at the wrong store]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    expect(await refusal(f, (tx) => listLobby(tx, f.kitchen, { storeId: f.storeId }))).toBeInstanceOf(AuthorizationError);
    expect(await refusal(f, (tx) => listLobby(tx, f.managerOther, { storeId: f.storeId }))).toBeInstanceOf(AuthorizationError);
    expect((await lobbyRow(f.storeId))!.pos_seen_at).toBeNull();
  });
});

describe('T-644 S1 setLobbyPaused: pause and resume round-trip', () => {
  it('pause then resume flips the switch, shows in the next list, and writes one audit row each by the cashier [kills: a switch that does not stick, a resume that leaves it paused, no audit]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    expect(await asOrg(f.orgId, (tx) => setLobbyPaused(tx, f.counter, { storeId: f.storeId, paused: true }))).toEqual({ paused: true });
    expect((await lobbyRow(f.storeId))!.paused).toBe(true);
    expect((await asOrg(f.orgId, (tx) => listLobby(tx, f.counter, { storeId: f.storeId }))).paused).toBe(true);
    expect(await asOrg(f.orgId, (tx) => setLobbyPaused(tx, f.counter, { storeId: f.storeId, paused: false }))).toEqual({ paused: false });
    expect((await lobbyRow(f.storeId))!.paused).toBe(false);
    expect((await asOrg(f.orgId, (tx) => listLobby(tx, f.counter, { storeId: f.storeId }))).paused).toBe(false);
    const p = await audit(f, f.storeId, 'lobby.pause');
    const r = await audit(f, f.storeId, 'lobby.resume');
    expect(p).toHaveLength(1);
    expect(r).toHaveLength(1);
    expect(p[0]!.actor_person_id).toBe(f.counterId);
    expect(p[0]!.before).toEqual({ paused: false });
    expect(r[0]!.after).toEqual({ paused: false });
  });

  it('is REFUSED without record_sale (the switch does not move, nothing audited), and a store with no lobby row is LOBBY_NOT_FOUND [kills: a pause with no authorize(), a silent ok on a missing row]', async () => {
    const f = await fixture();
    await withLobbyStore(f, f.storeId);
    expect(await refusal(f, (tx) => setLobbyPaused(tx, f.kitchen, { storeId: f.storeId, paused: true }))).toBeInstanceOf(AuthorizationError);
    expect((await lobbyRow(f.storeId))!.paused).toBe(false);
    expect(await audit(f, f.storeId, 'lobby.pause')).toHaveLength(0);
    const err = await refusal(f, (tx) => setLobbyPaused(tx, f.admin, { storeId: f.store2Id, paused: true }));
    expect(err).toBeInstanceOf(LobbyRefusal);
    expect((err as LobbyRefusal).code).toBe('LOBBY_NOT_FOUND');
  });
});

describe('T-644 S1 call / remove with onlyStoreId (the paired tablet\'s store)', () => {
  it('the tablet\'s own store entry can be called and removed [kills: an onlyStoreId that refuses the store\'s own entry]', async () => {
    const f = await fixture();
    const a = await park(f, f.storeId);
    const b = await park(f, f.storeId);
    await asOrg(f.orgId, (tx) => callEntry(tx, f.counter, a.entryId, { onlyStoreId: f.storeId }));
    await asOrg(f.orgId, (tx) => removeEntry(tx, f.counter, b.entryId, { onlyStoreId: f.storeId.toUpperCase() }));
    expect(await entryStatus(a.entryId)).toBe('called');
    expect(await entryStatus(b.entryId)).toBe('removed');
  });

  it('an entry of ANOTHER store is LOBBY_NOT_FOUND and unchanged, even for a person who holds record_sale at both stores [kills: call/remove that ignore onlyStoreId and act on any store the person holds]', async () => {
    const f = await fixture();
    const other = await park(f, f.store2Id);
    for (const fn of [
      (tx: Parameters<Parameters<typeof asOrg>[1]>[0]) => callEntry(tx, f.admin, other.entryId, { onlyStoreId: f.storeId }),
      (tx: Parameters<Parameters<typeof asOrg>[1]>[0]) => removeEntry(tx, f.admin, other.entryId, { onlyStoreId: f.storeId }),
    ]) {
      const err = await refusal(f, fn);
      expect(err).toBeInstanceOf(LobbyRefusal);
      expect((err as LobbyRefusal).code).toBe('LOBBY_NOT_FOUND');
    }
    expect(await entryStatus(other.entryId)).toBe('waiting');
  });
});

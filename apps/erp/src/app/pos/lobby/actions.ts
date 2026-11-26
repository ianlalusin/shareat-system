'use server';

/**
 * T-644 S1 - the cashier's waiting line, as Server Actions (docs/tasks/644-lobby-in-erp-pos.md, rulings 1-3). Online only. Each call is the T-455 staff twin
 * (`listLobby`, `parkWalkIn`, `callEntry`, `removeEntry`, `setLobbyPaused`), which authorizes `record_sale` at the store and owns every refusal sentence.
 * ⛔ No rule here. The store is `actionStore(...)`: on a paired tablet the pairing's store wins and a different `storeId` in the body is refused, never obeyed;
 * call and remove also pass it as `onlyStoreId`, so an entry id of another store answers like a ghost id. A domain refusal comes back as a RESULT, never a thrown error.
 * ⛔ `listLobbyAction` stamps `lobby_stores.pos_seen_at` (inside `listLobby`): the shell polls it on every tab, and diners cannot check in without that stamp.
 */
import type { Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import { callEntry, listLobby, parkWalkIn, removeEntry, seatEntry, setLobbyPaused } from '@shareat/domain';
import { requireActor } from '@/lib/session';
import { tabletPairing } from '@/lib/pos-api';
import { errorMessage } from '@/lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';
import { actionStore } from '../_shell/action-store';
import { BAD_ENTRY, type LobbyListView, type LobbyResult } from '../_lobby/logic';

const ROUTE = '/pos/lobby';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_PAIRED = "Open the lobby on the store's paired tablet.";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The one shape of every action: who is signed in, which store this tablet works at, then the domain call; a refusal becomes `{ ok: false, error }`. */
async function atStore<T extends object>(input: unknown, run: (tx: Tx, actor: Actor, storeId: string) => Promise<T>, needsPairing = false): Promise<LobbyResult<T>> {
  const actor = await requireActor(ROUTE);
  const store = await actionStore(actor, isRecord(input) ? input.storeId : undefined);
  if ('error' in store) return { ok: false, error: store.error };
  if (needsPairing) {
    const pairing = await tabletPairing();
    if (!pairing || pairing.orgId !== actor.orgId || pairing.storeId.toLowerCase() !== store.storeId) return { ok: false, error: NOT_PAIRED };
  }
  try {
    return { ok: true, ...(await withOrgPrincipal(actor.orgId, (tx) => run(tx, actor, store.storeId))) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

const entryIdOf = (input: unknown): string | null => (isRecord(input) && typeof input.entryId === 'string' && UUID.test(input.entryId) ? input.entryId.toLowerCase() : null);

/** The live line with each party's lines, JSON-safe. Stamps `pos_seen_at`. */
export async function listLobbyAction(input: { storeId: string }): Promise<LobbyResult<LobbyListView>> {
  return atStore(input, async (tx, actor, storeId) => {
    const r = await listLobby(tx, actor, { storeId });
    return {
      lobbyEnabled: r.lobbyEnabled,
      paused: r.paused,
      entries: r.entries.map((e) => ({
        entryId: e.entryId,
        code: e.code,
        displayName: e.displayName,
        partySize: e.partySize,
        status: e.status === 'called' ? ('called' as const) : ('waiting' as const),
        source: e.source,
        note: e.note,
        phone: e.phone,
        createdAt: e.createdAt.toISOString(),
        calledAt: e.calledAt ? e.calledAt.toISOString() : null,
        lines: e.lines.map((l) => ({ lineKind: l.lineKind, qty: l.qty, variantId: l.variantId, optionValueIds: l.optionValueIds, label: l.label, posItemKey: l.posItemKey })),
      })),
    };
  }, true);
}

/** The cashier parks a walk-in on the line. The domain trims and bounds the name, party size, phone and note. */
export async function parkWalkInAction(input: { storeId: string; displayName: string; partySize: number; phone?: string | null; note?: string | null }): Promise<LobbyResult<{ code: string }>> {
  return atStore(input, async (tx, actor, storeId) => {
    const r = await parkWalkIn(tx, actor, { storeId, displayName: input.displayName, partySize: input.partySize, phone: input.phone ?? null, note: input.note ?? null });
    return { code: r.code };
  });
}

export async function callEntryAction(input: { storeId: string; entryId: string }): Promise<LobbyResult> {
  const entryId = entryIdOf(input);
  if (!entryId) return { ok: false, error: BAD_ENTRY };
  return atStore(input, async (tx, actor, storeId) => {
    await callEntry(tx, actor, entryId, { onlyStoreId: storeId });
    return {};
  });
}

export async function removeEntryAction(input: { storeId: string; entryId: string }): Promise<LobbyResult> {
  const entryId = entryIdOf(input);
  if (!entryId) return { ok: false, error: BAD_ENTRY };
  return atStore(input, async (tx, actor, storeId) => {
    await removeEntry(tx, actor, entryId, { onlyStoreId: storeId });
    return {};
  });
}

/**
 * T-644 S2 - record that a party sits at a table the cashier has just opened (`stand.opened` is already in the outbox). `joinUrl` is always null: the ERP has no join-link
 * source, so the diner's phone shows the counter message. The body names no store: it is the pairing's (`needsPairing`), and `onlyStoreId` makes another store's entry
 * answer like a ghost id. The stand label is bounded by the domain after the store check.
 */
export async function seatLobbyEntryAction(input: { entryId: string; sessionId: string; standLabel: string }): Promise<LobbyResult<{ entryId: string }>> {
  const entryId = entryIdOf(input);
  const sessionId = isRecord(input) && typeof input.sessionId === 'string' && UUID.test(input.sessionId) ? input.sessionId.toLowerCase() : null;
  if (!entryId || !sessionId) return { ok: false, error: BAD_ENTRY };
  const standLabel = typeof input.standLabel === 'string' ? input.standLabel : '';
  return atStore(
    {},
    async (tx, actor, storeId) => {
      const r = await seatEntry(tx, actor, { entryId, sessionId, standLabel, joinUrl: null }, { onlyStoreId: storeId });
      return { entryId: r.entryId };
    },
    true,
  );
}

export async function setLobbyPausedAction(input: { storeId: string; paused: boolean }): Promise<LobbyResult<{ paused: boolean }>> {
  if (!isRecord(input) || typeof input.paused !== 'boolean') return { ok: false, error: 'Choose pause or resume.' };
  const paused = input.paused;
  return atStore(input, (tx, actor, storeId) => setLobbyPaused(tx, actor, { storeId, paused }));
}

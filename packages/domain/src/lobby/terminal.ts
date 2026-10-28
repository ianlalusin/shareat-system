/**
 * T-455 S5 - the lobby moves a POS TABLET makes (docs/tasks/455-customer-lobby.md "S5 rulings" 2-4). A POS v2 cashier is a Firebase
 * user with no ERP person, and the tablet's terminal person holds no capability by design (T-304), so these moves ask for no capability check:
 * (the staff capability check): the trust chain is the route's token + staff assignment + `resolvePosTerminalLink` (the same chain `approveManagerPin`
 * uses). Each move checks that the entry belongs to the tablet's own store; another store's entry answers exactly like a ghost id
 * (LOBBY_NOT_FOUND), so a tablet cannot probe other stores. The state logic is `core.ts`, shared with `staff.ts`.
 *
 * `tx: Tx` first, no transaction opened here (DEF-421). Audit rows: actor = the terminal person, source 'pos', `after.cashier` = the
 * staff member's name; never a diner name, phone or the join link.
 */
import { auditLogRepo, lobbyRepo, type Tx } from '@shareat/db';
import { callCore, listCore, parkCore, removeCore, seatCore, type CoreListRow, type MoveCtx, type ParkInput, type SeatInput, type StoreGuard } from './core';
import { lobbyRefusal } from './refusal';

export interface TerminalActor {
  readonly orgId: string;
  /** The ERP store the tablet's live POS link resolves to - never taken from a request body. */
  readonly erpStoreId: string;
  readonly terminalPersonId: string;
  readonly cashierName: string;
}

export interface TerminalLine {
  readonly lineKind: 'package' | 'a_la_carte';
  readonly qty: number;
  readonly variantId: string;
  readonly optionValueIds: string[];
  readonly label: string;
  /** The store's ACTIVE POS v1 link key, or null: the screen then shows `label` as text to tap in by hand. */
  readonly posItemKey: string | null;
}

export interface TerminalListRow extends CoreListRow {
  readonly lines: TerminalLine[];
}

const ctxOf = (a: TerminalActor): MoveCtx => ({ orgId: a.orgId, personId: a.terminalPersonId, cashier: a.cashierName });
/** Another store's entry answers exactly like a ghost id. */
const guardFor = (a: TerminalActor): StoreGuard => (entryStoreId) => {
  if (entryStoreId !== a.erpStoreId) throw lobbyRefusal('LOBBY_NOT_FOUND');
};

/** The tablet's live line, oldest first, with each party's order lines; stamps `lobby_stores.pos_seen_at` (the POS-is-up signal). */
export async function listForTerminal(
  tx: Tx,
  actor: TerminalActor,
): Promise<{ lobbyEnabled: boolean; paused: boolean; entries: TerminalListRow[] }> {
  const store = await lobbyRepo.getLobbyStore(tx, actor.orgId, actor.erpStoreId, 0, false);
  if (store) await lobbyRepo.stampPosSeen(tx, actor.orgId, actor.erpStoreId);
  const rows = await listCore(tx, actor.orgId, actor.erpStoreId);
  const lines = await lobbyRepo.listLinesForEntries(tx, actor.orgId, actor.erpStoreId, rows.map((r) => r.entryId));
  const entries = rows.map((r) => ({
    ...r,
    lines: lines
      .filter((l) => l.entryId === r.entryId)
      .map((l) => ({ lineKind: l.lineKind, qty: l.qty, variantId: l.variantId, optionValueIds: l.optionValueIds, label: l.label, posItemKey: l.posItemKey })),
  }));
  return { lobbyEnabled: store?.enabled ?? false, paused: store?.paused ?? false, entries };
}

export async function parkForTerminal(
  tx: Tx,
  actor: TerminalActor,
  input: ParkInput,
  opts?: { randomCode?: () => string },
): Promise<{ entryId: string; code: string }> {
  return parkCore(tx, ctxOf(actor), actor.erpStoreId, input, opts);
}

export async function callForTerminal(tx: Tx, actor: TerminalActor, entryId: string): Promise<{ entryId: string; status: 'called' }> {
  return callCore(tx, ctxOf(actor), entryId, guardFor(actor));
}

export async function seatForTerminal(tx: Tx, actor: TerminalActor, input: SeatInput): Promise<{ entryId: string; status: 'seated' }> {
  return seatCore(tx, ctxOf(actor), input, guardFor(actor));
}

export async function removeForTerminal(tx: Tx, actor: TerminalActor, entryId: string): Promise<{ entryId: string; status: 'removed' }> {
  return removeCore(tx, ctxOf(actor), entryId, guardFor(actor));
}

/** Flip the store's pause switch (audit `lobby.pause` / `lobby.resume`). A store with no `lobby_stores` row is LOBBY_NOT_FOUND. */
export async function setLobbyPausedForTerminal(tx: Tx, actor: TerminalActor, paused: boolean): Promise<{ paused: boolean }> {
  const ok = await lobbyRepo.setPaused(tx, actor.orgId, actor.erpStoreId, paused);
  if (!ok) throw lobbyRefusal('LOBBY_NOT_FOUND', 'lobby store');
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.terminalPersonId,
    action: paused ? 'lobby.pause' : 'lobby.resume',
    storeId: actor.erpStoreId,
    entityId: actor.erpStoreId,
    before: { paused: !paused },
    after: { paused, cashier: actor.cashierName },
    source: 'pos',
  });
  return { paused };
}

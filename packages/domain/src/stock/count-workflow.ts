/**
 * The count-session WORKFLOW — T-169 / DEF-135 (2026-09-03).
 *
 * `count-sessions.ts` (this same directory) is the tested ENGINE: `commitCountSession` takes a
 * flat list of counted lines and posts the variance. It has no `authorize()` call and knows
 * nothing about a session's status, its rooms, or who may open one — by design, so the two stay
 * independently testable (docs/tasks/169 "do not change the engine").
 *
 * **This file is everything the engine deliberately leaves out**: open a session (freeze the
 * rooms), record one counted line at a time, advance the session's status, commit (which calls
 * straight into the engine), and cancel. It is the only caller `commitCountSession` has today.
 *
 * ## ⭐ Why a room-frozen refusal is THROWN, not returned
 *
 * `count_session_locations_one_active_trg` is the ONLY place "already frozen" is decided (the
 * migration's own header explains why it could not be a partial unique index). Pre-checking here
 * and then inserting would read the same fact twice with a race between the two reads — the
 * database is the single source of truth, so `openCountSession` lets the trigger's exception
 * propagate. `apps/erp/.../inventory/counts/actions.ts` translates the message for the screen,
 * the same shape `commissary/catalogue/actions.ts` already uses for its own trigger messages.
 *
 * ## ⚠️ `bypass_count_freeze` has no caller here, on purpose
 *
 * The capability is declared (`packages/auth/src/capabilities.ts`) but nothing in this pass sets
 * `app.bypass_count_freeze` — docs/tasks/169 says so explicitly ("not used in this pass"). Every
 * writer in this module is an ordinary actor working the count itself; an admin override for a
 * writer OTHER than the count (e.g. an emergency usage post into a frozen room) is a capability
 * with no caller yet, same shape as `allocate_stock` (T-160).
 */
import { authorize, type Actor } from '@shareat/auth';
import { countSessionsRepo, type Tx } from '@shareat/db';
import { FREEZING_STATUSES } from '@shareat/db/schema';
import { commitCountSession, type CountLineInput, type VarianceLine } from './count-sessions';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from './receipt-posting';
import { quantity, type Quantity } from './quantity';

// -------------------------------------------------------------------------------------------
// Open — freezes every named room the moment the rooms row is written (the trigger, not this file)
// -------------------------------------------------------------------------------------------

export interface OpenCountSessionInput {
  readonly storeId: string;
  readonly locationIds: readonly string[];
  /** YYYY-MM-DD. */
  readonly countedOn: string;
  readonly note?: string | null;
}

export type OpenCountSessionOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: string };

export async function openCountSession(
  tx: Tx,
  actor: Actor,
  input: OpenCountSessionInput,
): Promise<OpenCountSessionOutcome> {
  await authorize(tx, actor, 'open_count_session', { storeId: input.storeId });

  const locationIds = [...new Set(input.locationIds)];
  if (locationIds.length === 0) {
    return { ok: false, reason: 'a count session needs at least one room' };
  }

  const active = await countSessionsRepo.listActiveLocationsLike(tx, input.storeId);
  const activeIds = new Set(active.map((l) => l.id));
  const notActive = locationIds.filter((id) => !activeIds.has(id));
  if (notActive.length > 0) {
    return {
      ok: false,
      reason: `room(s) not active in this store: ${notActive.join(', ')}`,
    };
  }

  // ⚠️ NOT wrapped in try/catch — see this file's header. A room already frozen throws the
  // trigger's own exception, and the caller (actions.ts) translates it for the screen.
  const { id } = await countSessionsRepo.insertCountSession(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    countedOn: input.countedOn,
    note: input.note ?? null,
    openedBy: actor.personId,
    locationIds,
  });

  return { ok: true, sessionId: id };
}

// -------------------------------------------------------------------------------------------
// Record — one counted line. Staff-open: counting is floor work (record_stock_movement).
// -------------------------------------------------------------------------------------------

export interface RecordCountInput {
  readonly sessionId: string;
  readonly itemId: string;
  readonly locationId: string;
  /** ⭐ Zero is a real, meaningful answer — see count-sessions.ts schema header. */
  readonly countedQuantity: Quantity;
}

export type RecordCountOutcome =
  | { readonly ok: true; readonly lineId: string }
  | { readonly ok: false; readonly reason: string };

/** ⛔ Negative is refused by `count_lines_counted_non_negative_check`, not re-checked here — the
 *  database already owns that rule (bible: "do not re-implement a rule the database enforces"). */
export async function recordCount(
  tx: Tx,
  actor: Actor,
  input: RecordCountInput,
): Promise<RecordCountOutcome> {
  const session = await countSessionsRepo.getCountSession(tx, input.sessionId);
  if (!session) return { ok: false, reason: `count session ${input.sessionId} does not exist` };

  await authorize(tx, actor, 'record_stock_movement', { storeId: session.storeId });

  if (session.status !== 'open' && session.status !== 'counting') {
    return {
      ok: false,
      reason: `count session ${input.sessionId} is ${session.status} — counting is closed`,
    };
  }
  if (!session.locations.some((l) => l.id === input.locationId)) {
    return { ok: false, reason: `room ${input.locationId} is not one of this session's rooms` };
  }

  const { id } = await countSessionsRepo.upsertCountLine(tx, {
    sessionId: input.sessionId,
    itemId: input.itemId,
    locationId: input.locationId,
    countedQuantity: input.countedQuantity,
    countedBy: actor.personId,
  });

  // ⭐ open → counting on the FIRST line, once, per invariant in docs/tasks/169.
  if (session.status === 'open') {
    await countSessionsRepo.setCountSessionStatus(tx, input.sessionId, 'counting');
  }

  return { ok: true, lineId: id };
}

// -------------------------------------------------------------------------------------------
// Advance — counting → reviewing. Same gate as opening: this is a supervisory checkpoint.
// -------------------------------------------------------------------------------------------

export type AdvanceCountSessionOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export async function advanceCountSession(
  tx: Tx,
  actor: Actor,
  input: { readonly sessionId: string; readonly to: 'reviewing' },
): Promise<AdvanceCountSessionOutcome> {
  const session = await countSessionsRepo.getCountSession(tx, input.sessionId);
  if (!session) return { ok: false, reason: `count session ${input.sessionId} does not exist` };

  await authorize(tx, actor, 'open_count_session', { storeId: session.storeId });

  if (session.status !== 'counting') {
    return {
      ok: false,
      reason: `count session ${input.sessionId} is ${session.status}, not counting — count at least one line first`,
    };
  }

  await countSessionsRepo.setCountSessionStatus(tx, input.sessionId, input.to);
  return { ok: true };
}

// -------------------------------------------------------------------------------------------
// Commit — calls straight into the tested engine, then writes the audit trail back onto the lines.
// -------------------------------------------------------------------------------------------

export type CommitCountWorkflowOutcome =
  | {
      readonly ok: true;
      readonly lines: readonly VarianceLine[];
      readonly shortEntryId: string | null;
      readonly longEntryId: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export async function commitCount(
  tx: Tx,
  actor: Actor,
  input: { readonly sessionId: string },
): Promise<CommitCountWorkflowOutcome> {
  const session = await countSessionsRepo.getCountSession(tx, input.sessionId);
  if (!session) return { ok: false, reason: `count session ${input.sessionId} does not exist` };

  await authorize(tx, actor, 'commit_count', { storeId: session.storeId });

  if (session.status !== 'counting' && session.status !== 'reviewing') {
    return { ok: false, reason: `count session ${input.sessionId} is ${session.status} — nothing to commit` };
  }

  const locationIds = session.locations.map((l) => l.id);
  const [lines, expected] = await Promise.all([
    countSessionsRepo.listCountLines(tx, input.sessionId),
    countSessionsRepo.expectedItemsAt(tx, locationIds),
  ]);

  // ⭐ Invariant 4 — every item with stock in a frozen room must have a line, or the close names
  // them. An item silently absent is indistinguishable from an item counted at zero.
  const countedKeys = new Set(lines.map((l) => `${l.itemId}:${l.locationId}`));
  const missing = expected.filter((e) => !countedKeys.has(`${e.itemId}:${e.locationId}`));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `${missing.length} item(s) with stock in a frozen room were never counted — ` +
        missing.map((m) => `${m.itemCode} in ${m.locationName}`).join(', '),
    };
  }

  const countLineInputs: CountLineInput[] = [];
  for (const line of lines) {
    const inventoryAccount = INVENTORY_ACCOUNT_BY_ITEM_KIND[line.itemKind];
    if (!inventoryAccount) {
      return {
        ok: false,
        reason: `item ${line.itemCode} (kind "${line.itemKind}") has no inventory account in COA-ALIGNMENT §4.1`,
      };
    }
    countLineInputs.push({
      itemId: line.itemId,
      locationId: line.locationId,
      countedQuantity: quantity(line.countedQuantity),
      inventoryAccount,
    });
  }

  const now = new Date();

  // ⭐ DEF-142 (2026-09-03). Every counted line's room is, by construction (`recordCount` only
  // accepts a session's own rooms), one of THIS session's frozen rooms — and the engine writes its
  // variance movement into exactly that room. Until migration 0123 the freeze trigger refused
  // that write too, so a real single-room count could never commit; the engine's own tests hid it
  // by freezing a different room than they counted. The trigger now exempts precisely one shape —
  // a `count_adjustment` from the session that holds the room — so the engine is called FIRST,
  // with nothing written yet, and a business refusal (counted long with no cost basis, an uncounted
  // item) is handed back as `{ ok: false }` while the session stays exactly as it was.
  const result = await commitCountSession(tx, {
    orgId: actor.orgId,
    storeId: session.storeId,
    sessionId: input.sessionId,
    countedOn: session.countedOn,
    lines: countLineInputs,
    committedBy: actor.personId,
    isOpeningCount: false,
  });
  if (!result.ok) return result;

  const lineIdByKey = new Map(lines.map((l) => [`${l.itemId}:${l.locationId}`, l.id]));
  for (const varianceLine of result.lines) {
    const lineId = lineIdByKey.get(`${varianceLine.itemId}:${varianceLine.locationId}`);
    if (!lineId) continue; // ⛔ Cannot happen — every variance line came from a `lines` row above.
    await countSessionsRepo.setCountLineResult(tx, lineId, {
      expectedQuantity: varianceLine.expected,
      variance: varianceLine.variance,
      movementId: varianceLine.movementId,
    });
  }

  await countSessionsRepo.markCountCommitted(tx, input.sessionId, {
    committedAt: now,
    // ⚠️ The column is singular; the engine posts up to TWO entries by design (short and long are
    // never netted — see count-sessions.ts). The short entry is stored; the long one is real and
    // returned to the caller but has no column of its own. Documented, not fixed — see the task doc.
    journalEntryId: result.shortEntryId ?? result.longEntryId,
    closedBy: actor.personId,
    closedAt: now,
  });

  return { ok: true, lines: result.lines, shortEntryId: result.shortEntryId, longEntryId: result.longEntryId };
}

// -------------------------------------------------------------------------------------------
// Cancel — releases the freeze, posts nothing. Same gate as commit: ending a count is supervisory.
// -------------------------------------------------------------------------------------------

export type CancelCountSessionOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export async function cancelCountSession(
  tx: Tx,
  actor: Actor,
  input: { readonly sessionId: string },
): Promise<CancelCountSessionOutcome> {
  const session = await countSessionsRepo.getCountSession(tx, input.sessionId);
  if (!session) return { ok: false, reason: `count session ${input.sessionId} does not exist` };

  await authorize(tx, actor, 'commit_count', { storeId: session.storeId });

  if (session.status === 'closed' || session.status === 'cancelled') {
    return { ok: false, reason: `count session ${input.sessionId} is already ${session.status}` };
  }

  const now = new Date();
  await countSessionsRepo.markCountCancelled(tx, input.sessionId, { closedBy: actor.personId, closedAt: now });
  return { ok: true };
}

// -------------------------------------------------------------------------------------------
// The pure predicate — for a UI badge only. The trigger is the real enforcement (migration 0068).
// -------------------------------------------------------------------------------------------

export interface FreezingSessionLike {
  readonly status: unknown;
  readonly locationIds: unknown;
}

/**
 * ⭐ Fails CLOSED to `false` on anything malformed — a null/unknown status, a missing or
 * non-array location list — and NEVER throws (spec invariant 2). This mirrors, at the TypeScript
 * level, the same fail-safe direction `stock_movements_check_not_frozen_trg` takes in SQL: a
 * malformed row must never freeze a room with no way to clear it.
 */
export function isFrozenBySessions(rows: readonly FreezingSessionLike[], locationId: string): boolean {
  const freezing = new Set<string>(FREEZING_STATUSES);
  for (const row of rows) {
    if (typeof row.status !== 'string' || !freezing.has(row.status)) continue;
    if (!Array.isArray(row.locationIds)) continue;
    if (row.locationIds.includes(locationId)) return true;
  }
  return false;
}

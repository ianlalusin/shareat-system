/**
 * Server-only reads for the physical-count screens — T-169 / DEF-135 (2026-09-03).
 *
 * ⚠️ **Reads only.** Every rule here — the freeze, who may open or commit, the missing-item
 * refusal — lives in `packages/domain/src/stock/count-workflow.ts` and is enforced there. This
 * file just shapes what a `page.tsx` needs to render.
 */
import { countSessionsRepo, itemsRepo } from '@shareat/db';
import { isFrozenBySessions } from '@shareat/domain';
import { listStores, withOrgPrincipal } from '../../expenses/lib';

export { listStores, withOrgPrincipal };
export type { StoreOption } from '../../expenses/lib';

export interface RegisterLocation {
  readonly id: string;
  readonly name: string;
  readonly frozen: boolean;
}

export interface RegisterSessionRow {
  readonly id: string;
  readonly status: string;
  readonly countedOn: string;
  readonly note: string | null;
  readonly openedByName: string;
  readonly openedAt: Date;
  readonly locations: readonly { id: string; name: string }[];
  readonly lineCount: number;
}

export interface CountsRegister {
  readonly locations: readonly RegisterLocation[];
  readonly sessions: readonly RegisterSessionRow[];
}

/** The register: this store's active rooms (with a live "frozen" badge) and its count sessions,
 *  newest first. `orgId` is the ACTOR's org (never derived from the store row itself) — the same
 *  RLS-principal shape every other T-172-era screen uses. */
export async function countsRegister(orgId: string, storeId: string): Promise<CountsRegister> {
  return withOrgPrincipal(orgId, async (tx) => {
    const [active, sessions] = await Promise.all([
      countSessionsRepo.listActiveLocationsLike(tx, storeId),
      countSessionsRepo.listCountSessions(tx, storeId),
    ]);

    const locationIds = active.map((l) => l.id);
    const freezing = await countSessionsRepo.freezingSessionsFor(tx, locationIds);
    const locations = active.map((l) => ({ id: l.id, name: l.name, frozen: isFrozenBySessions(freezing, l.id) }));

    const names = await countSessionsRepo.personNamesById(tx, sessions.map((s) => s.openedBy));

    return {
      locations,
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        countedOn: s.countedOn,
        note: s.note,
        openedByName: names.get(s.openedBy) ?? 'Someone',
        openedAt: s.openedAt,
        locations: s.locations,
        lineCount: s.lineCount,
      })),
    };
  });
}

// -----------------------------------------------------------------------------------------
// The count sheet — one session's detail
// -----------------------------------------------------------------------------------------

export interface SheetLine {
  /** count_lines.id once something has been typed against this row; `null` for a row not counted yet. */
  readonly id: string | null;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly baseUnit: string;
  readonly locationId: string;
  readonly locationName: string;
  /** From the ledger — `null` for a line the sheet did not expect (an "extra" find). */
  readonly ledgerQuantity: string | null;
  /** What was typed, if anything yet. */
  readonly countedQuantity: string | null;
  /** Only set once the session has been committed. */
  readonly expectedQuantity: string | null;
  readonly variance: string | null;
  readonly movementId: string | null;
}

export interface CountSessionDetail {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly status: string;
  readonly countedOn: string;
  readonly note: string | null;
  readonly committedAt: Date | null;
  readonly journalEntryId: string | null;
  readonly openedByName: string;
  readonly openedAt: Date;
  readonly closedByName: string | null;
  readonly closedAt: Date | null;
  readonly locations: readonly { id: string; name: string }[];
  /** Expected items merged with whatever has already been typed against them. */
  readonly sheet: readonly SheetLine[];
  /** Items counted that the ledger did NOT expect in this room — a real find, not a mistake. */
  readonly extras: readonly SheetLine[];
  /** For the "this is here but wasn't expected" picker — every active item, minus what's on the
   *  sheet already. */
  readonly addableItems: readonly { id: string; code: string; name: string; baseUnit: string }[];
}

/**
 * T-389 S4: the count line's own id for a (session, item, room), or '' when there is none. A refused save keeps the
 * typing under this id so only that line reopens. One row is read, never the whole sheet. A database error is not
 * swallowed: it surfaces like any other failure of the action.
 */
export async function countLineId(orgId: string, sessionId: string, itemId: string, locationId: string): Promise<string> {
  return withOrgPrincipal(orgId, async (tx) => (await countSessionsRepo.lineIdFor(tx, sessionId, itemId, locationId)) ?? '');
}

/** ⚠️ `orgId` is the ACTOR's org, not derived from the row — a session id from another org
 *  resolves to "not found" under this org's RLS principal rather than ever being read. */
export async function getCountSessionDetail(orgId: string, id: string): Promise<CountSessionDetail | undefined> {
  return withOrgPrincipal(orgId, async (tx) => {
    const session = await countSessionsRepo.getCountSession(tx, id);
    if (!session || session.orgId !== orgId) return undefined;

    const locationIds = session.locations.map((l) => l.id);
    // ⚠️ `includeInactive: true` — no status filter, matching the pre-move query exactly. This
    // screen offers "add an item not on the sheet" from EVERY item in the org, active or not;
    // narrowing that is a behaviour change for a different task, not this layering fix.
    const [expected, lines, resolvedStoreName, itemRows] = await Promise.all([
      countSessionsRepo.expectedItemsAt(tx, locationIds),
      countSessionsRepo.listCountLines(tx, id),
      countSessionsRepo.storeName(tx, session.storeId),
      itemsRepo.listItems(tx, session.orgId, { includeInactive: true }),
    ]);
    const allItems = itemRows.map((i) => ({ id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit }));

    const names = await countSessionsRepo.personNamesById(
      tx,
      [session.openedBy, session.closedBy].filter((x): x is string => Boolean(x)),
    );
    const locName = new Map(session.locations.map((l) => [l.id, l.name]));

    const lineByKey = new Map(lines.map((l) => [`${l.itemId}:${l.locationId}`, l]));
    const expectedKeys = new Set(expected.map((e) => `${e.itemId}:${e.locationId}`));

    const sheet: SheetLine[] = expected.map((e) => {
      const line = lineByKey.get(`${e.itemId}:${e.locationId}`);
      return {
        id: line?.id ?? null,
        itemId: e.itemId,
        itemCode: e.itemCode,
        itemName: e.itemName,
        baseUnit: e.baseUnit,
        locationId: e.locationId,
        locationName: e.locationName,
        ledgerQuantity: e.quantity,
        countedQuantity: line?.countedQuantity ?? null,
        expectedQuantity: line?.expectedQuantity ?? null,
        variance: line?.variance ?? null,
        movementId: line?.movementId ?? null,
      };
    });

    const extras: SheetLine[] = lines
      .filter((l) => !expectedKeys.has(`${l.itemId}:${l.locationId}`))
      .map((l) => ({
        id: l.id,
        itemId: l.itemId,
        itemCode: l.itemCode,
        itemName: l.itemName,
        baseUnit: l.baseUnit,
        locationId: l.locationId,
        locationName: locName.get(l.locationId) ?? l.locationName,
        ledgerQuantity: null,
        countedQuantity: l.countedQuantity,
        expectedQuantity: l.expectedQuantity,
        variance: l.variance,
        movementId: l.movementId,
      }));

    const onSheetItemIds = new Set([...sheet.map((s) => s.itemId), ...extras.map((s) => s.itemId)]);

    return {
      id: session.id,
      orgId: session.orgId,
      storeId: session.storeId,
      storeName: resolvedStoreName ?? session.storeId,
      status: session.status,
      countedOn: session.countedOn,
      note: session.note,
      committedAt: session.committedAt,
      journalEntryId: session.journalEntryId,
      openedByName: names.get(session.openedBy) ?? 'Someone',
      openedAt: session.openedAt,
      closedByName: session.closedBy ? (names.get(session.closedBy) ?? 'Someone') : null,
      closedAt: session.closedAt,
      locations: session.locations,
      sheet,
      extras,
      addableItems: allItems.filter((i) => !onSheetItemIds.has(i.id)),
    };
  });
}

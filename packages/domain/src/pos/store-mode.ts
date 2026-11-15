/**
 * T-533 S1 - set a store's POS mode: off, test, or live from a date. docs/tasks/533-pos-lipa-switch.md R1; Ian's answers O1 (bible row 456).
 *
 * `setStorePosMode(tx, actor, { storeId, mode, liveFrom?, reason }, { keyFilePresent, today? })`. This is the switch that decides whether a store's sales days
 * come from the new POS (live) or from the v1 day feed, so:
 *   - WHO: `manage_stores` first (the word /admin/stores uses), then the role itself must be exactly admin or super_admin. A manager handed `manage_stores` by hand
 *     is refused: switching a store is not a store manager's call.
 *   - TEST and OFF are free (no pre-flight, no date), except leaving LIVE, which is the roll-back below.
 *   - LIVE needs: the store to have been in TEST first ("Switch <store> to test mode first."); a date today (the BUSINESS date, which respects
 *     `pos.business_day_start_hour`) or later; no sales day (any source, voided ones aside) on or after it; and a pre-flight with nothing blocking (`posPreflight`, S3).
 *   - ROLL-BACK (live -> test or off, or a different live date) only while no Z has closed on or after `live_from`. Release 1 rolls back only to before the first Z.
 *   - Reason 1 to 200 characters. Bumps `state_version`, sets `changed_by` and `changed_at`, audits `pos.store_mode_set` with before and after.
 * The first call for a store creates its `pos_stores` row (mode off) in the same transaction, so a refused call leaves no row behind. Two admins at once queue on the
 * per-store lock the Z uses (`lockPosDayClose`) and read the row FOR UPDATE, so the second decides on what the first committed.
 *
 * The rules are the pure functions below (tested with no database); `setStorePosMode` reads the facts, asks them, and writes.
 */
import { authorize, isAdministrative, type Actor } from '@shareat/auth';
import { accessRepo, advisoryLocksRepo, auditLogRepo, posStoreModeRepo, posV2Repo, storesRepo, type Tx } from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { safeHumanDate } from '../sales-days/create-block';
import { gone, refuse } from '../shared/refusal';
import { posPreflight, type PreflightItem } from './preflight';
import { businessDateOf, uuidInput, type PosDeps } from './shared';

export type PosStoreMode = 'off' | 'test' | 'live';
const MODES: readonly PosStoreMode[] = ['off', 'test', 'live'];

export interface CheckedModeInput {
  readonly mode: PosStoreMode;
  /** The date a live store starts from; null for off and test. */
  readonly liveFrom: string | null;
  readonly reason: string;
}

/** The input rules, in words (pure). A date given with off or test is ignored: a form posts the field either way. */
export function checkModeInput(raw: { mode: unknown; liveFrom: unknown; reason: unknown }): CheckedModeInput {
  if (typeof raw.mode !== 'string' || !(MODES as readonly string[]).includes(raw.mode)) {
    throw refuse('setStorePosMode: bad mode', 'Choose a mode: off, test or live.');
  }
  const mode = raw.mode as PosStoreMode;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 1 || reason.length > 200) throw refuse('setStorePosMode: reason length', 'Give a reason of 1 to 200 characters.');
  if (mode !== 'live') return { mode, liveFrom: null, reason };
  if (typeof raw.liveFrom !== 'string' || raw.liveFrom.trim() === '') throw refuse('setStorePosMode: live without a date', 'A live switch needs the date it starts from.');
  const liveFrom = raw.liveFrom.trim();
  try {
    parseBusinessDate(liveFrom);
  } catch {
    throw refuse('setStorePosMode: bad date', `"${liveFrom}" is not a valid date. Use the date picker, or type it as YYYY-MM-DD.`);
  }
  return { mode, liveFrom, reason };
}

/** Going live needs the store to have been in test (or already live, moving its date). `currentMode` is null when the store has no switch row. */
export function judgeBeforeLive(f: { currentMode: string | null; storeName: string }): string | null {
  return f.currentMode === 'test' || f.currentMode === 'live' ? null : `Switch ${f.storeName} to test mode first.`;
}

/** Going live: the date is today or later and no sales day sits on or after it (`firstDay` = the earliest such day, or null). A sentence, or null when fine. */
export function judgeGoingLive(f: { liveFrom: string; today: string; firstDay: string | null }): string | null {
  if (f.liveFrom.localeCompare(f.today) < 0) return `The start date can't be in the past. Today is ${safeHumanDate(f.today)}.`;
  if (f.firstDay !== null) return `Sales day ${safeHumanDate(f.firstDay)} already exists. Switch from the next day.`;
  return null;
}

/** Leaving live (or moving its date): refused once a Z has closed on or after `live_from`. `lastZDate` = the store's latest Z date, or null. */
export function judgeLeavingLive(f: { current: { mode: string; liveFrom: string | null } | null; lastZDate: string | null }): string | null {
  if (!f.current || f.current.mode !== 'live' || f.current.liveFrom === null) return null;
  if (f.lastZDate !== null && f.lastZDate.localeCompare(f.current.liveFrom) >= 0) return 'Days are already closed on the new POS. Roll back from the next day.';
  return null;
}

/** The pre-flight gate: a sentence when anything blocks, naming how many and the first few. */
export function preflightRefusal(blocking: readonly PreflightItem[]): string | null {
  if (blocking.length === 0) return null;
  const shown = blocking.slice(0, 3).map((i) => i.sentence).join(' ');
  const more = blocking.length > 3 ? ` And ${blocking.length - 3} more.` : '';
  return `This store is not ready to go live: ${blocking.length} ${blocking.length === 1 ? 'thing blocks' : 'things block'} it. ${shown}${more} See the pre-flight page for the full list.`;
}

const ONLY_ADMIN = 'Only an admin can switch a store between the old and the new POS.';

/** Who may switch a store: `manage_stores`, then the role itself must be admin or super_admin. Shared by the switch and by the screen's confirm step (a manager is refused at step 1). */
export async function assertMaySwitchStorePosMode(tx: Tx, actor: Actor): Promise<void> {
  await authorize(tx, actor, 'manage_stores', {});
  if (!isAdministrative((await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role)) {
    throw refuse('setStorePosMode: actor is not admin or super_admin', ONLY_ADMIN);
  }
}

export interface SetStorePosModeInput {
  readonly storeId: string;
  readonly mode: unknown;
  readonly liveFrom?: unknown;
  readonly reason: unknown;
}
export interface SetStorePosModeDeps {
  /** Whether the bridge key-file setting is configured: yes or no only (the pre-flight's probe). */
  readonly keyFilePresent: () => boolean;
  /** Tests only: the Manila business date to treat as today. */
  readonly today?: string;
  /** Tests only: the clock the business date is worked out from (the day starts at `pos.business_day_start_hour`, not at midnight). */
  readonly now?: PosDeps['now'];
}
export interface SetStorePosModeResult {
  readonly changed: boolean;
  readonly mode: PosStoreMode;
  readonly liveFrom: string | null;
  readonly stateVersion: number;
}

export async function setStorePosMode(tx: Tx, actor: Actor, input: SetStorePosModeInput, deps: SetStorePosModeDeps): Promise<SetStorePosModeResult> {
  const storeId = uuidInput(input.storeId, 'That store');
  const { orgId } = actor;
  await assertMaySwitchStorePosMode(tx, actor);
  // The Z's own per-store lock: a close and a switch (or two switches) queue, and the loser reads what the winner committed.
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);
  const want = checkModeInput({ mode: input.mode, liveFrom: input.liveFrom, reason: input.reason });
  const store = await storesRepo.getById(tx, orgId, storeId);
  if (!store) throw gone(`setStorePosMode: store ${storeId} not in org`, 'store');

  const { row, created } = await posStoreModeRepo.ensureOffRow(tx, { orgId, storeId, changedBy: actor.personId });
  const before = { mode: row.mode as PosStoreMode, liveFrom: row.liveFrom ?? null };
  if (!created && before.mode === want.mode && before.liveFrom === want.liveFrom) {
    return { changed: false, mode: before.mode, liveFrom: before.liveFrom, stateVersion: row.stateVersion };
  }

  // Leaving live, or moving its date, is the roll-back: only before the first Z.
  const leaving = before.mode === 'live' ? judgeLeavingLive({ current: before, lastZDate: (await posV2Repo.lastDayCloseBusinessDate(tx, orgId, storeId)) ?? null }) : null;
  if (leaving) throw refuse('setStorePosMode: roll-back after a Z', leaving);

  if (want.mode === 'live') {
    const first = judgeBeforeLive({ currentMode: created ? null : before.mode, storeName: store.name });
    if (first) throw refuse('setStorePosMode: not in test first', first);
    // Today is the BUSINESS date (the day starts at pos.business_day_start_hour), the same helper a sale and a Z use.
    const today = deps.today ?? (await businessDateOf(tx, orgId, storeId, deps.now ? { now: deps.now } : undefined));
    const firstDay = (await posStoreModeRepo.firstLiveSalesDayOnOrAfter(tx, orgId, storeId, want.liveFrom!)) ?? null;
    const dateRefusal = judgeGoingLive({ liveFrom: want.liveFrom!, today, firstDay });
    if (dateRefusal) throw refuse('setStorePosMode: live date', dateRefusal);
    const gate = preflightRefusal((await posPreflight(tx, actor, { storeId }, { keyFilePresent: deps.keyFilePresent, today })).blocking);
    if (gate) throw refuse('setStorePosMode: pre-flight blocks', gate);
  }

  const stateVersion = await posStoreModeRepo.setMode(tx, orgId, storeId, { mode: want.mode, liveFrom: want.liveFrom, changedBy: actor.personId });
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: actor.personId,
    action: 'pos.store_mode_set',
    storeId,
    entityId: row.id,
    before,
    after: { mode: want.mode, liveFrom: want.liveFrom, reason: want.reason },
    source: 'web',
  });
  return { changed: true, mode: want.mode, liveFrom: want.liveFrom, stateVersion };
}

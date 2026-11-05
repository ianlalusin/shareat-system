/**
 * T-510 S2 - the daypart writers (create, edit, retire) and the offer-daypart checks. docs/tasks/510-menu-dayparts.md R1, R3, R8, R12.
 *
 * A daypart is a repeating weekly window (days, start, end; store-local wall clock) that a menu offer can be tied to. Every writer needs
 * `manage_store_settings` AT THE STORE OF THE DAYPART (R8), writes its `audit_log` row in the same transaction (R12), and refuses in a
 * sentence. The database (migration 0233) is the authority on the hard rules (retire while a live offer uses it, overlap, unique active
 * name); the checks here only run FIRST and word the refusal, and a 23514 or 23505 that still gets through is worded too (the backstop).
 * The pure window logic is `./daypart`.
 */
import { authorize, type Actor } from '@shareat/auth';
import { daypartsRepo, menuRepo, storesRepo, type Tx } from '@shareat/db';
import type { MenuChannel } from '@shareat/db/schema';
import { gone, refuse } from '../shared/refusal';
import { validateDaypart, type DaypartInvalidReason } from './daypart';
import { audit, inTxRetry, pgCode, requireName } from './shared';

const CAPABILITY = 'manage_store_settings' as const;

export interface DaypartInput {
  /** 0 = Sunday .. 6; the day the window starts on. Any order; stored ascending. */
  days: number[];
  /** Store-local 'HH:MM'. */
  start: string;
  /** Store-local 'HH:MM'; earlier than `start` means overnight. */
  end: string;
}

const INVALID: Record<DaypartInvalidReason, [string, string]> = {
  days_empty: ['at least one day is needed', 'Choose at least one day.'],
  days_duplicate: ['a day is listed twice', 'A day is listed twice. Pick each day once.'],
  days_out_of_range: ['a day must be 0 (Sunday) to 6 (Saturday)', 'Pick days from Sunday to Saturday.'],
  start_invalid: ['the start time must be HH:MM', 'Enter the start time as hours and minutes, like 08:00.'],
  end_invalid: ['the end time must be HH:MM', 'Enter the end time as hours and minutes, like 17:00.'],
  end_equals_start: [
    'the end time cannot equal the start time',
    'The end time cannot be the same as the start time. For a window that runs past midnight, start later than you end, like 17:00 to 08:00.',
  ],
};

/** The window as stored form ('HH:MM', days ascending), or a refusal in a sentence. */
function requireWindow(w: DaypartInput, label: string): { days: number[]; start: string; end: string } {
  const v = validateDaypart({ id: '', days: w.days, start: w.start, end: w.end });
  if (!v.ok) throw refuse(`${label}: ${INVALID[v.reason][0]}.`, INVALID[v.reason][1]);
  return { days: [...w.days].sort((a, b) => a - b), start: w.start.slice(0, 5), end: w.end.slice(0, 5) };
}

const hhmm = (t: string): string => t.slice(0, 5);
const snap = (d: daypartsRepo.MenuDaypartRow) => ({ name: d.name, days: [...d.days], start: hhmm(d.startTime), end: hhmm(d.endTime), status: d.status });

const nameTaken = (name: string) =>
  refuse('daypart name already in use at this store', `This store already has a daypart called ${name}. Names are compared ignoring capital letters.`);

/** The unique index `menu_dayparts_store_active_name_key` is what refuses a duplicate active name, races included. */
function isNameTaken(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name === 'menu_dayparts_store_active_name_key') return true;
  }
  return false;
}

/** Backstop: a 23514 raised by a 0233 guard (a race the first check could not see) as a sentence; anything else is not ours and is left alone. */
export function daypartGuardRefusal(err: unknown): ReturnType<typeof refuse> | undefined {
  if (pgCode(err) !== '23514') return undefined;
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && /daypart|all-day|scheduled row cannot be deleted/.test(msg)) {
      return refuse(msg, 'Another change to these prices or times got there first, and the two clash. Reload and check the current prices and times, then try again.');
    }
  }
  return undefined;
}

const conflictSentence = (c: 'mixed_all_day_and_daypart' | 'overlapping_dayparts', label: string) =>
  c === 'overlapping_dayparts'
    ? refuse(
        `${label}: live dayparted offers of one variant, store and channel may not overlap in time.`,
        'Another price for this package already covers some of these hours on these days. Withdraw it first, or choose times that do not overlap.',
      )
    : refuse(
        `${label}: a variant cannot have a live all-day offer and a live dayparted offer at the same time for one store and channel.`,
        'This package has an all-day price and prices by time of day at the same time, so the cashier would not know which applies. Withdraw one kind first.',
      );

async function daypartOf(tx: Tx, actor: Actor, id: string, label: string): Promise<daypartsRepo.MenuDaypartRow> {
  const d = await daypartsRepo.getDaypart(tx, actor.orgId, id);
  if (!d) throw gone(`${label}: daypart ${id} does not exist.`, 'daypart');
  return d;
}

export async function createDaypart(actor: Actor, input: { storeId: string; name: string } & DaypartInput, tx?: Tx): Promise<{ id: string }> {
  return inTxRetry(tx, actor.orgId, async (trx) => {
    await authorize(trx, actor, CAPABILITY, { storeId: input.storeId });
    const name = requireName(input.name, 'createDaypart', 'A daypart');
    const w = requireWindow(input, 'createDaypart');
    if (!(await storesRepo.getById(trx, actor.orgId, input.storeId))) throw gone(`createDaypart: store ${input.storeId} does not exist.`, 'store');
    let row: daypartsRepo.MenuDaypartRow;
    try {
      row = await daypartsRepo.insertDaypart(trx, { orgId: actor.orgId, storeId: input.storeId, name, days: w.days, startTime: w.start, endTime: w.end, createdBy: actor.personId });
    } catch (err) {
      if (isNameTaken(err)) throw nameTaken(name);
      throw err;
    }
    await audit(trx, actor, 'menu_daypart.created', input.storeId, row.id, null, snap(row));
    return { id: row.id };
  });
}

/** Name, days, start, end. An omitted field is left alone; an edit that changes nothing writes nothing (`wrote: false`). A retired daypart is never edited. */
export async function updateDaypart(
  actor: Actor,
  input: { id: string; name?: string; days?: number[]; start?: string; end?: string },
  tx?: Tx,
): Promise<{ id: string; wrote: boolean }> {
  return inTxRetry(tx, actor.orgId, async (trx) => {
    const before = await daypartOf(trx, actor, input.id, 'updateDaypart');
    await authorize(trx, actor, CAPABILITY, { storeId: before.storeId });
    if (before.status === 'retired') {
      throw refuse(`updateDaypart: daypart ${before.id} is retired.`, `${before.name} is retired, so it can't be changed. Add a new daypart instead.`);
    }
    const name = input.name === undefined ? before.name : requireName(input.name, 'updateDaypart', 'A daypart');
    const w = requireWindow({ days: input.days ?? before.days, start: input.start ?? hhmm(before.startTime), end: input.end ?? hhmm(before.endTime) }, 'updateDaypart');
    const windowChanged =
      w.days.join() !== [...before.days].sort((a, b) => a - b).join() || w.start !== hhmm(before.startTime) || w.end !== hhmm(before.endTime);
    if (name === before.name && !windowChanged) return { id: before.id, wrote: false };
    if (windowChanged) {
      const c = await daypartsRepo.windowConflict(trx, before.id, { days: w.days, startTime: w.start, endTime: w.end });
      if (c) throw conflictSentence(c, 'updateDaypart');
    }
    let after: daypartsRepo.MenuDaypartRow;
    try {
      after = await daypartsRepo.updateDaypart(trx, before.id, { name, days: w.days, startTime: w.start, endTime: w.end });
    } catch (err) {
      if (isNameTaken(err)) throw nameTaken(name);
      throw daypartGuardRefusal(err) ?? err;
    }
    await audit(trx, actor, 'menu_daypart.edited', before.storeId, before.id, snap(before), snap(after));
    return { id: before.id, wrote: true };
  });
}

/** Refused, with the count, while a live offer still uses the daypart (R3). Retiring a retired daypart is a no-op. */
export async function retireDaypart(actor: Actor, input: { id: string }, tx?: Tx): Promise<{ id: string; wrote: boolean }> {
  return inTxRetry(tx, actor.orgId, async (trx) => {
    const before = await daypartOf(trx, actor, input.id, 'retireDaypart');
    await authorize(trx, actor, CAPABILITY, { storeId: before.storeId });
    if (before.status === 'retired') return { id: before.id, wrote: false };
    const live = await daypartsRepo.countLiveOfferSlots(trx, before.id);
    if (live > 0) {
      throw refuse(
        `retireDaypart: ${live} live offer(s) still use daypart ${before.id}.`,
        `${before.name} still has ${live} live ${live === 1 ? 'price' : 'prices'}. Withdraw ${live === 1 ? 'it' : 'them'} first, then retire the daypart.`,
      );
    }
    let after: daypartsRepo.MenuDaypartRow;
    try {
      after = await daypartsRepo.updateDaypart(trx, before.id, { status: 'retired' });
    } catch (err) {
      throw daypartGuardRefusal(err) ?? err;
    }
    await audit(trx, actor, 'menu_daypart.retired', before.storeId, before.id, snap(before), snap(after));
    return { id: before.id, wrote: true };
  });
}

// ---- the offer side (setMenuOffer / withdrawMenuOffer) ----------------------------------------------------------------

/**
 * The daypart an offer names must exist and belong to the offer's store; a LIVE offer's must also be active (a withdrawal may name a retired
 * one, so a leftover can still be cleaned up). Takes the daypart row FOR SHARE first (the 0233 lock order). Omitted or null = all day.
 */
export async function requireOfferDaypart(actor: Actor, trx: Tx, storeId: string, daypartId: string | null | undefined, label: string, live: boolean): Promise<void> {
  if (daypartId == null) return;
  const d = await daypartsRepo.getDaypart(trx, actor.orgId, daypartId);
  if (!d) throw gone(`${label}: daypart ${daypartId} does not exist.`, 'daypart');
  if (d.storeId !== storeId) {
    throw refuse(`${label}: daypart ${daypartId} belongs to another store.`, `${d.name} is a daypart of a different store. Choose one of this store's dayparts, or all day.`);
  }
  if (live && d.status !== 'active') {
    throw refuse(`${label}: daypart ${daypartId} is retired.`, `${d.name} is retired, so a price can't use it. Choose an active daypart, or all day.`);
  }
  await daypartsRepo.lockDaypartShare(trx, daypartId);
}

/** A live offer about to be stored must not sit beside an all-day or dayparted offer it clashes with: a sentence before the 0233 insert guard would raise. Call under the variant's `lockKey`. */
export async function requireNoSlotConflict(
  trx: Tx,
  key: { storeId: string; variantId: string; channel: MenuChannel; daypartId?: string | null },
  at: Date | undefined,
  label: string,
): Promise<void> {
  const c = await menuRepo.offerSlotConflict(trx, key, at);
  if (c === null) return;
  if (c === 'mixed_all_day_and_daypart') {
    const dayparted = key.daypartId != null;
    throw refuse(
      `${label}: a variant cannot have a live all-day offer and a live dayparted offer at the same time for one store and channel.`,
      dayparted
        ? 'This package already has an all-day price here. Withdraw the all-day price first, then add the prices by time of day.'
        : 'This package already has prices by time of day here. Withdraw those first, then set an all-day price.',
    );
  }
  throw conflictSentence(c, label);
}

/**
 * R8 (Ian, 5 Nov): the PAIRING STRUCTURE of a variant and channel (which offer belongs to which daypart, or all day) is super admin only
 * (`pair_menu_dayparts`); a plain price change stays `set_menu_price`. Needed only when the write changes the structure:
 *   set, dayparted, and the exact slot is not live -> creates a pairing;
 *   set, all day, while a dayparted slot is live -> switches to all day;
 *   withdraw, dayparted -> removes a pairing; withdraw, all day, while the variant has any dayparted slot -> part of a switch.
 * A variant that never had a daypart is never touched by this. Takes the variant's lock first so the facts cannot move under the check.
 */
export async function requirePairingAuthority(
  actor: Actor,
  trx: Tx,
  key: { storeId: string; variantId: string; channel: MenuChannel; daypartId?: string | null },
  kind: 'set' | 'withdraw',
): Promise<void> {
  await menuRepo.lockKey(trx, key.variantId);
  const st = await menuRepo.offerStructure(trx, key);
  const dayparted = key.daypartId != null;
  const changes =
    kind === 'set' ? (dayparted ? !st.slotLive : st.daypartedLive) : dayparted || st.hasDayparted;
  if (changes) await authorize(trx, actor, 'pair_menu_dayparts', {});
}

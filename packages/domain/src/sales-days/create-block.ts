/**
 * The create-block, moved verbatim out of `create.ts` so BOTH ways of opening a sales day call the one copy:
 * `createSalesDay` (a typed day, an UNLINKED store) and `importSalesDay` (a day derived from POS, a LINKED store).
 * T-375 S3, `docs/tasks/375-pos-v1-day-feed.md` (R5). docs/tasks/123-sales-day.md §4.2, bible row 126.
 *
 * `create.ts`'s header explains the forcing function and its three carve-outs; they all fall out of WHERE this is
 * called (only when a NEW day is being opened), never out of special-casing here:
 *  - editing an existing draft never calls it;
 *  - backfilling an OLDER date is not blocked (the query is strictly before the date);
 *  - admins bypass.
 *
 * Also here: the typed path's gate (R13). A LINKED store takes its sales from POS, so a typed create or edit refuses
 * with a sentence; the store row is taken `FOR KEY SHARE` first, so a typed write and a link of the same store
 * serialize (`linkStoreToPos` holds it `FOR UPDATE`).
 */
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { posV1Repo, salesDaysRepo, tradeDiscrepanciesRepo, type Tx } from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { gone, humanDate, refuse, RefusalError } from '../shared/refusal';

/**
 * A refusal message builder must never itself throw (code-review item 7, 2026-09-26):
 * `input.businessDate` is caller-supplied and `parseBusinessDate` rejects anything not strictly
 * `YYYY-MM-DD` (e.g. `2026-1-10`, unpadded) — a malformed date must fall back to the raw string
 * rather than crash the refusal it is naming.
 */
export function safeHumanDate(rawBusinessDate: string): string {
  try {
    return humanDate(parseBusinessDate(rawBusinessDate));
  } catch {
    return rawBusinessDate;
  }
}

/**
 * ⭐ T-174. Thrown when an unresolved transit shortfall blocks a new day at the COMMISSARY.
 *
 * ⚠️ v1's reason is exactly right and worth keeping in the code: *forces resolution before revenue
 * can be understated further.* A commissary whose dispatched goods are unaccounted for is a
 * commissary whose cost of sales is wrong, and every day it opens on top of that makes the figure
 * worse and harder to unpick.
 */
export class TransitShortfallBlockedError extends Error {
  constructor(
    message: string,
    readonly discrepancyIds: readonly string[],
  ) {
    super(message);
    this.name = 'TransitShortfallBlockedError';
  }
}

/** Thrown when an older unverified day blocks this one. A named type, not a bare Error, because
 *  a caller has a genuinely useful thing to do with it: send the user to that day. It is a
 *  `RefusalError`, so the screen shows `userMessage` (a plain sentence naming the date) and never the
 *  developer text in `message`. */
export class SalesDayBlockedError extends RefusalError {
  constructor(
    message: string,
    userMessage: string,
    readonly blockingDayId: string,
    readonly blockingBusinessDate: string,
  ) {
    super(message, userMessage);
    this.name = 'SalesDayBlockedError';
  }
}

/**
 * Whether this actor bypasses the create-block.
 *
 * ⚠️ Deliberately expressed as a CAPABILITY question, not a role check. `close_period` is held by
 * admins and by managers whose scope covers the whole org (bible row 123) — the same population
 * that v1's `isAdmin` bypass was reaching for, and asking it this way means the capability matrix
 * stays the one place that decides who may do what. A `role === 'admin'` here would be a second,
 * competing authority (bible row 120).
 */
export async function canBypassBlock(tx: Tx, actor: Actor, storeId: string): Promise<boolean> {
  try {
    await authorize(tx, actor, 'close_period', { storeId });
    return true;
  } catch (err) {
    if (err instanceof AuthorizationError) return false;
    throw err;
  }
}

/**
 * Everything that must hold before a NEW day may be opened for `businessDate`: the voided-date rule, the
 * create-block and the transit-shortfall block. `fn` names the caller in the developer text only.
 */
export async function assertCanOpenDay(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; businessDate: string },
  fn: 'createSalesDay' | 'importSalesDay',
): Promise<void> {
  // T-369 S7 (Ian Q1): a VOIDED day frees its date, but only a manager may enter it again - never staff.
  // The same capability that lets someone withdraw a day lets them re-enter its date. Asked only when a
  // voided day really is on this date, so an ordinary create never pays for it.
  if (await salesDaysRepo.hasVoidedOn(tx, actor.orgId, input.storeId, input.businessDate)) {
    try {
      await authorize(tx, actor, 'void_sales_day', { storeId: input.storeId });
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      throw refuse(
        `${fn}: ${input.businessDate} at store ${input.storeId} was voided and re-entering it needs void_sales_day`,
        `${safeHumanDate(input.businessDate)} was withdrawn earlier. Only a manager can enter that date again — ask one to do it.`,
      );
    }
    // Cash handed over and counted against this date has to be reversed before the date is entered again.
    if (await salesDaysRepo.hasPostedHandoverOn(tx, actor.orgId, input.storeId, input.businessDate)) {
      throw refuse(
        `${fn}: ${input.businessDate} at store ${input.storeId} has a posted remittance allocation`,
        'Cash handed over has been counted against this date. Reverse that handover first.',
      );
    }
  }

  // ── The create-block ────────────────────────────────────────────────────────────────
  // Admins bypass. Checked by asking whether this actor could close a period — the closest
  // existing capability that only admins and org-wide managers hold — rather than reading a
  // role name here, so the matrix stays the single source of who may do what.
  const isAdmin = await canBypassBlock(tx, actor, input.storeId);
  if (!isAdmin) {
    const blocking = await salesDaysRepo.findOldestUnverifiedBefore(
      tx,
      actor.orgId,
      input.storeId,
      input.businessDate,
    );
    if (blocking) {
      throw new SalesDayBlockedError(
        `${fn}: ${blocking.businessDate} is still ${blocking.status} and must be verified ` +
          `before a newer day can be created. You can still edit that day, or backfill an even ` +
          `older one`,
        `${safeHumanDate(blocking.businessDate)} is still ${blocking.status} — verify or edit it before entering a newer day.`,
        blocking.id,
        blocking.businessDate,
      );
    }

    // ── T-174: the transit-shortfall block ────────────────────────────────────────────
    // ⭐ Everything `open`, plus everything `deferred` whose date has ARRIVED — a deferral is a
    // promise to decide by a date, not an exemption. ⛔ Derived from the rows every time, never a
    // counter (DEF-075), and it is the SAME query the discrepancy screen lists from: one source,
    // two consumers, so the block can never refuse a day over something the screen does not show.
    const shortfalls = await tradeDiscrepanciesRepo.blocking(
      tx,
      actor.orgId,
      input.storeId,
      input.businessDate,
    );
    if (shortfalls.length > 0) {
      const first = shortfalls[0]!;
      throw new TransitShortfallBlockedError(
        `${fn}: ${shortfalls.length} dispatched shipment` +
          `${shortfalls.length === 1 ? ' has' : 's have'} goods unaccounted for — ` +
          `${first.quantity} units worth ₱${first.value} and ` +
          `${shortfalls.length - 1} other${shortfalls.length === 2 ? '' : 's'}. ` +
          `Decide what happened to them before opening a new day`,
        shortfalls.map((d) => d.id),
      );
    }
  }
}

/**
 * R13: the typed path's gate. Call AFTER `authorize()`: takes the store row `FOR KEY SHARE`, then reads the link.
 * A LINKED store refuses with the import-instead sentence.
 *
 * Why the lock and not only the trigger: without it a typed create could read "no link", a concurrent link commit
 * could then see no typed day of the store, and both would commit (✎Y4). `FOR UPDATE` (the link) conflicts with
 * `FOR KEY SHARE` (this), so one of the two waits and re-reads. The lock is defence in depth with no killing mutant;
 * L5 proves the behaviour.
 */
export async function assertStoreTakesTypedDays(tx: Tx, actor: Actor, storeId: string, fn: string): Promise<void> {
  const store = await salesDaysRepo.lockStoreKeyShare(tx, actor.orgId, storeId);
  if (!store) throw gone(`${fn}: store ${storeId} does not exist in org ${actor.orgId}`, 'store');
  const link = await posV1Repo.getLinkByStore(tx, actor.orgId, storeId);
  if (link) {
    throw refuse(
      `${fn}: store ${storeId} is linked to POS store ${link.posStoreId}; its sales days are imported, never typed`,
      `${store.name} takes its sales from POS. Import the day instead.`,
    );
  }
}

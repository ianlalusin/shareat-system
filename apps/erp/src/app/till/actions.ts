'use server';

/**
 * Server actions for `/till`. T-186.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ Every gate is `authorize()` inside
 * the service — `record_till_count` to count, `resolve_till_variance` to charge. A gate in a
 * server action protects one caller.
 */
import {
  chargeTillShortage,
  closeTillShift,
  openTillShift,
  recordTillCount,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ⭐ Plain language for the database constraints a person can actually hit. ⚠️ Only the WORDING is
 * ours — re-checking these in TypeScript would be a second source of truth that drifts.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  till_custody_shifts_one_open_per_store:
    'This store already has an open shift. Close it first — two open shifts on one till means ' +
    'two people believe they hold the same cash.',
  till_custody_shifts_prev_unique:
    'That shift has already been handed over to someone else.',
  till_custody_shifts_store_date_no_unique:
    'A shift with that number already exists for this store on that date.',
  till_count_lines_shift_moment_account_unique:
    'That account has already been counted at this moment. A count is signed for once — record ' +
    'the next one on the next shift.',
  till_count_lines_counted_nonnegative_check:
    'A physical count cannot be negative. Enter what is actually in the drawer, or 0.',
};

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  return sharedErrorMessage(err);
}

/**
 * ⚠️ The store key is `store`, NOT `storeId` — it must match what `page.tsx` reads from
 * `searchParams`. They disagreed until 2026-08-30, and the symptom was invisible on the first
 * store in the list and only showed on the second: every action bounced the picker back.
 */
export async function openShiftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const businessDate = str(formData, 'businessDate');
  const prevShiftId = str(formData, 'prevShiftId');

  let shiftNo = 0;
  try {
    const r = await withOrgPrincipal(actor.orgId, (tx) =>
      openTillShift(tx, actor, {
        storeId,
        businessDate,
        prevShiftId: prevShiftId || null,
        notes: str(formData, 'notes') || null,
      }),
    );
    shiftNo = r.shiftNo;
  } catch (err) {
    return await redirectWithFlash('/till', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/till', { store: storeId }, {
    ok: `Shift ${shiftNo} is open. Record the opening count before trading.`,
  });
}

export async function recordCountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const shiftId = str(formData, 'shiftId');
  const moment = str(formData, 'moment') === 'close' ? 'close' : 'open';

  // One field per account, named `count:<accountId>`. ⚠️ A blank is SKIPPED, not read as zero —
  // "I did not count this pocket" and "this pocket is empty" are different facts.
  const counts: { moneyAccountId: string; counted: string }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('count:') || typeof value !== 'string' || value.trim() === '') continue;
    counts.push({ moneyAccountId: key.slice('count:'.length), counted: value.trim() });
  }

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      recordTillCount(tx, actor, { shiftId, moment, counts }),
    );
  } catch (err) {
    return await redirectWithFlash('/till', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/till', { store: storeId }, { ok: `${moment === 'open' ? 'Opening' : 'Closing'} count recorded.` });
}

export async function closeShiftAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      closeTillShift(tx, actor, {
        shiftId: str(formData, 'shiftId'),
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/till', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/till', { store: storeId }, { ok: 'Shift closed. The till is now in nobody’s custody until the next opens.' });
}

/**
 * ⛔ Gated on `resolve_till_variance`, which denies staff. Charging the shortage your own count
 * revealed is the one thing the person who counted must not be able to do.
 */
export async function chargeShortageAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let outcome: { posted: boolean; reason?: string } = { posted: false };
  try {
    outcome = await withOrgPrincipal(actor.orgId, (tx) =>
      chargeTillShortage(tx, actor, {
        countLineId: str(formData, 'countLineId'),
        personId: str(formData, 'personId'),
        note: str(formData, 'note') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/till', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/till', { store: storeId }, {
    ok: outcome.posted
      ? 'Charged to the cashier against 1230. ⚠️ The office replenishment is a separate transfer.'
      : (outcome.reason ?? 'Nothing to charge.'),
  });
}

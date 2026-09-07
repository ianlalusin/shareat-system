'use server';

/**
 * Server actions for `/settings/sales-channels`. T-230.
 *
 * ⛔ **No rule is re-implemented here.** `createSalesChannel`, `updateSalesChannel` and
 * `setSalesChannelActive` each call `authorize(tx, actor, 'manage_store_settings', …)` as their
 * own first meaningful statement — `settings/attendance/actions.ts:6-9` states the reason: a gate
 * here would protect only this one caller, and the screen would be one new form away from a hole.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSalesChannel, setSalesChannelActive, updateSalesChannel } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/settings/sales-channels?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
}

/**
 * ⭐ **`is_remitted_daily` is read as a THREE-state answer, and that is the whole point.** The
 * column is NOT NULL with no default, so "unanswered" has to survive the round trip and be
 * refused — not silently become `false` the way an unchecked checkbox would. The form ships two
 * radios with no `defaultChecked`; an absent value lands here as `''`.
 *
 * ⚠️ v1 did the opposite (`sales-channel-form.tsx:19`, `z.boolean().default(true)`), which is why
 * every v1 reader is written `isRemittedDaily !== false` — a default nobody chose, propagated into
 * the shape of every consumer.
 */
function remittance(fd: FormData): boolean {
  const raw = str(fd, 'isRemittedDaily');
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      'Say whether this channel’s money reaches the till on the day or settles later — there is ' +
        'no sensible default, because it decides whether the money is part of expected remittance at all.',
    );
  }
  return raw === 'true';
}

/** ⛔ `''` is a real absence, never an empty-string account code — DEF-087's failure shape. */
function receivable(fd: FormData): string | null {
  const raw = str(fd, 'receivableAccountCode');
  return raw === '' ? null : raw;
}

function mode(fd: FormData): 'tracked' | 'instant' {
  return str(fd, 'wastageTypeMode') === 'instant' ? 'instant' : 'tracked';
}

export async function createSalesChannelAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/sales-channels');
  const storeId = str(fd, 'storeId');
  const name = str(fd, 'name');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createSalesChannel(tx, actor, {
        storeId,
        name,
        isRemittedDaily: remittance(fd),
        receivableAccountCode: receivable(fd),
        wastageTypeMode: mode(fd),
      }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  revalidatePath('/settings/sales-channels');
  revalidatePath('/wastage');
  back(storeId, { ok: `"${name}" added. This store can now record sales through it.` });
}

export async function updateSalesChannelAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/sales-channels');
  const storeId = str(fd, 'storeId');
  const name = str(fd, 'name');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateSalesChannel(tx, actor, {
        channelId: str(fd, 'channelId'),
        name,
        isRemittedDaily: remittance(fd),
        receivableAccountCode: receivable(fd),
        wastageTypeMode: mode(fd),
      }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  revalidatePath('/settings/sales-channels');
  revalidatePath('/wastage');
  // ⭐ Renaming is safe to state plainly: wastages point at the channel by id, so nothing that is
  //   already recorded resolves differently — T-230 contract 3.
  back(storeId, { ok: `Saved. Anything already recorded against this channel is unaffected.` });
}

export async function setSalesChannelActiveAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/sales-channels');
  const storeId = str(fd, 'storeId');
  const isActive = str(fd, 'isActive') === 'true';
  const name = str(fd, 'name');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setSalesChannelActive(tx, actor, { channelId: str(fd, 'channelId'), isActive }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  revalidatePath('/settings/sales-channels');
  revalidatePath('/wastage');
  back(storeId, {
    ok: isActive
      ? `"${name}" is active again and can be chosen on new sales days.`
      : `"${name}" is retired. It stays on everything already recorded, and anything still open ` +
        'against it can still be resolved.',
  });
}

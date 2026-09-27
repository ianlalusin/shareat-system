'use server';

/**
 * Server actions for the daily POS usage pull screen — T-177.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { finalizeSections, requestMap } from '@shareat/domain';
import { buildPlanForDay, withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/inventory/pos-usage?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
}

export async function buildPlanAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-usage');
  const storeId = str(fd, 'storeId');
  const salesDayId = str(fd, 'salesDayId');
  const locationId = str(fd, 'locationId');

  let result: Awaited<ReturnType<typeof buildPlanForDay>> | undefined;
  try {
    result = await buildPlanForDay(actor.orgId, actor, { storeId, salesDayId, locationId });
  } catch (err) {
    back(storeId, { day: salesDayId, error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { day: salesDayId, error: result!.reason });
  }

  revalidatePath('/inventory/pos-usage');
  back(storeId, { day: salesDayId, pull: result!.pullId, ok: `Plan built — ${result!.lines.length} line(s).` });
}

export async function finalizeSectionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-usage');
  const storeId = str(fd, 'storeId');
  const salesDayId = str(fd, 'salesDayId');
  const pullId = str(fd, 'pullId');
  const section = str(fd, 'section') as 'direct' | 'recipe' | 'orphan';
  const confirmedKeys = strs(fd, 'confirmedKeys');

  let result: Awaited<ReturnType<typeof finalizeSections>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => finalizeSections(tx, actor, { pullId, sections: [section], confirmedKeys }));
  } catch (err) {
    back(storeId, { day: salesDayId, pull: pullId, error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { day: salesDayId, pull: pullId, error: result!.reason });
  }

  const outcome = result!.sections[0];
  revalidatePath('/inventory/pos-usage');
  if (!outcome || !outcome.ok) {
    back(storeId, { day: salesDayId, pull: pullId, error: outcome?.reason ?? 'Finalize refused.' });
  }

  back(storeId, {
    day: salesDayId,
    pull: pullId,
    ok:
      outcome.blockedLineCount > 0
        ? `${section}: ${outcome.postedLineCount} line(s) posted, ${outcome.blockedLineCount} skipped (frozen location) — finalized either way.`
        : `${section}: ${outcome.postedLineCount} line(s) posted.`,
  });
}

export async function requestMapFromPullAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-usage');
  const storeId = str(fd, 'storeId');
  const salesDayId = str(fd, 'salesDayId');
  const pullId = str(fd, 'pullId');

  let result: Awaited<ReturnType<typeof requestMap>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      requestMap(tx, actor, {
        orgId: actor.orgId,
        storeId,
        posItemKey: str(fd, 'posItemKey'),
        posItemName: str(fd, 'posItemName'),
        note: str(fd, 'note') || null,
      }),
    );
  } catch (err) {
    back(storeId, { day: salesDayId, pull: pullId, error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { day: salesDayId, pull: pullId, error: result!.reason });
  }

  back(storeId, { day: salesDayId, pull: pullId, ok: 'Flagged — a manager will decide from the mapping screen.' });
}

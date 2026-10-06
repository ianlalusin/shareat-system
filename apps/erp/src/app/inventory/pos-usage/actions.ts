'use server';

/**
 * Server actions for the daily POS usage pull screen — T-177.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { finalizeSections, requestMap, voidPosUsagePull } from '@shareat/domain';
import { salesDaysRepo } from '@shareat/db';
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
  const finish = str(fd, 'finish') === '1';
  const rawSection = str(fd, 'section');
  const confirmedKeys = strs(fd, 'confirmedKeys');

  // T-377 S2 (REV-3): the finish button sends no section and no keys; only the empty-section sweep can run.
  let sections: ('direct' | 'recipe' | 'orphan')[] = [];
  if (!finish) {
    if (rawSection !== 'direct' && rawSection !== 'recipe' && rawSection !== 'orphan') {
      back(storeId, { day: salesDayId, pull: pullId, error: 'Unknown section. Nothing was finalized.' });
    }
    sections = [rawSection as 'direct' | 'recipe' | 'orphan'];
  }

  let result: Awaited<ReturnType<typeof finalizeSections>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      finalizeSections(tx, actor, { pullId, sections, confirmedKeys: finish ? [] : confirmedKeys }),
    );
  } catch (err) {
    back(storeId, { day: salesDayId, pull: pullId, error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(storeId, { day: salesDayId, pull: pullId, error: result!.reason });
  }

  revalidatePath('/inventory/pos-usage');
  if (finish) {
    if (result!.pullFinalized) {
      back(storeId, { day: salesDayId, pull: pullId, ok: 'Pull finished — nothing left to post.' });
    }
    back(storeId, {
      day: salesDayId,
      pull: pullId,
      error: 'Something new turned up in this pull. Build the plan again and review it.',
    });
  }

  const section = sections[0]!;
  const outcome = result!.sections[0];
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

/** T-374 S7 (DEF-578): void the whole pull - every usage record it made is reversed, and the day can be pulled again. */
export async function voidPullAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/pos-usage');
  const storeId = str(fd, 'storeId');
  const salesDayId = str(fd, 'salesDayId');
  const pullId = str(fd, 'pullId');
  const reason = str(fd, 'reason');

  let count = 0;
  let dayVoided = false;
  try {
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const r = await voidPosUsagePull(tx, actor, { pullId, reason });
      const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
      dayVoided = day?.status === 'voided';
      return r;
    });
    count = result.reversedRecordCount;
  } catch (err) {
    back(storeId, { day: salesDayId, pull: pullId, error: errorMessage(err) });
  }

  revalidatePath('/inventory/pos-usage');
  revalidatePath('/inventory/usage');
  back(storeId, {
    day: salesDayId,
    ok: dayVoided
      ? `Pull voided — ${count} usage record(s) reversed. A replacement day can now be pulled.`
      : `Pull voided — ${count} usage record(s) reversed. The day can be pulled again.`,
  });
}

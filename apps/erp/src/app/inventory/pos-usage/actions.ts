'use server';

/**
 * Server actions for the daily POS usage pull screen — T-177.
 */
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { assertFieldRules, finalizeSections, requestMap, voidPosUsagePull } from '@shareat/domain';
import { INVENTORY_POS_VOID_RULES } from '@shareat/domain/field-rules';
import { salesDaysRepo } from '@shareat/db';
import { buildPlanForDay, withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
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
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId }, { error: errorMessage(err) });
  }
  if (!result.ok) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId }, { error: result.reason });
  }

  revalidatePath('/inventory/pos-usage');
  return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: result.pullId }, { ok: `Plan built — ${result.lines.length} line(s).` });
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
      return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: 'Unknown section. Nothing was finalized.' });
    }
    sections = [rawSection as 'direct' | 'recipe' | 'orphan'];
  }

  let result: Awaited<ReturnType<typeof finalizeSections>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      finalizeSections(tx, actor, { pullId, sections, confirmedKeys: finish ? [] : confirmedKeys }),
    );
  } catch (err) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: errorMessage(err) });
  }
  if (!result.ok) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: result.reason });
  }

  revalidatePath('/inventory/pos-usage');
  if (finish) {
    if (result.pullFinalized) {
      return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { ok: 'Pull finished — nothing left to post.' });
    }
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: 'Something new turned up in this pull. Build the plan again and review it.' });
  }

  const section = sections[0]!;
  const outcome = result.sections[0];
  if (!outcome || !outcome.ok) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: outcome?.reason ?? 'Finalize refused.' });
  }

  // T-401 S6 (Ian 15 Oct): nothing is posted here; the section's lines went into the day's usage draft, which a manager posts
  // (or the system posts at 14:00 the next day).
  const n = outcome.draftedLineCount;
  return await redirectWithFlash(
    '/inventory/pos-usage',
    { store: storeId, day: salesDayId, pull: pullId },
    { ok: n === 0 ? `${section}: reviewed. Nothing to add to the usage draft.` : `${section}: ${n} line(s) added to the day's usage draft. Nothing is posted until a manager posts the draft.` },
  );
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
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: errorMessage(err) });
  }
  if (!result.ok) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: result.reason });
  }

  return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { ok: 'Flagged — a manager will decide from the mapping screen.' });
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
    assertFieldRules(INVENTORY_POS_VOID_RULES, fd);
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store (not the form's `storeId`).
    const target = await loadDestructiveTarget(actor, 'pos_usage_pull', pullId, ['void_usage_record']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability: 'void_usage_record' });
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const r = await voidPosUsagePull(tx, actor, { pullId, reason });
      await recordApproval(tx, actor, approval, { capability: 'void_usage_record', entityType: 'pos_usage_pull', entityId: pullId, storeId: target.storeId });
      const day = await salesDaysRepo.getById(tx, actor.orgId, salesDayId);
      dayVoided = day?.status === 'voided';
      return r;
    });
    count = result.reversedRecordCount;
  } catch (err) {
    return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId, pull: pullId }, { error: errorMessage(err) });
  }

  revalidatePath('/inventory/pos-usage');
  revalidatePath('/inventory/usage');
  return await redirectWithFlash('/inventory/pos-usage', { store: storeId, day: salesDayId }, { stamp: 'VOID', ok: dayVoided
      ? `Pull voided — ${count} usage record(s) reversed. A replacement day can now be pulled.`
      : `Pull voided — ${count} usage record(s) reversed. The day can be pulled again.` });
}

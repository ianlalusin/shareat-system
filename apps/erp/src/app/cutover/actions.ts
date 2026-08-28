'use server';

/**
 * Server actions for the cutover screens. T-134.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **No rule is enforced here** —
 * `attestStep` refuses a verified step and `authorize()` gates the capability, both in the domain.
 * A gate in a server action protects one caller; a gate in the domain protects every caller there
 * will ever be.
 */
import { redirect } from 'next/navigation';
import { attestStep, recordOpeningCount } from '@shareat/domain';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(q ? `${path}?${q}` : path);
}

export async function attestStepAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const stepCode = str(formData, 'stepCode');
  const storeId = str(formData, 'storeId');
  try {
    await attestStep(null, actor, {
      stepCode,
      storeId: storeId || null,
      note: str(formData, 'note') || null,
    });
  } catch (err) {
    back('/cutover', { error: errorMessage(err) });
  }
  back('/cutover', {});
}

export async function recordCountAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const quantity = str(formData, 'quantity');
  const unitCost = str(formData, 'unitCost');
  try {
    await recordOpeningCount(null, actor, {
      storeId,
      itemId: str(formData, 'itemId'),
      // ⭐ An empty box is NOT a zero. The form only submits a row someone actually typed in, so
      // an item nobody counted stays uncounted and keeps showing as missing.
      quantity,
      unitCost: unitCost || null,
    });
  } catch (err) {
    back('/cutover/count', { store: storeId, error: errorMessage(err) });
  }
  back('/cutover/count', { store: storeId });
}

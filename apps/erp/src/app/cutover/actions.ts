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
import {
  addOpeningFigure,
  attestStep,
  postOpeningBalances,
  recordOpeningCount,
  removeOpeningFigure,
} from '@shareat/domain';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
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

export async function addOpeningFigureAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await addOpeningFigure(null, actor, {
      accountCode: str(formData, 'accountCode'),
      storeId: str(formData, 'storeId'),
      direction: str(formData, 'direction') === 'credit' ? 'credit' : 'debit',
      amount: str(formData, 'amount'),
      entryDate: str(formData, 'entryDate'),
      memo: str(formData, 'memo') || null,
    });
  } catch (err) {
    back('/cutover/opening', { error: errorMessage(err) });
  }
  back('/cutover/opening', {});
}

export async function removeOpeningFigureAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await removeOpeningFigure(null, actor, { entryId: str(formData, 'entryId') });
  } catch (err) {
    back('/cutover/opening', { error: errorMessage(err) });
  }
  back('/cutover/opening', {});
}

/**
 * ⛔ The one irreversible button in the application.
 *
 * It refuses on a residual, and the residual has been on screen the whole time the figures were
 * being entered — so this is never the moment anybody first learns the books do not balance.
 */
export async function postOpeningBalancesAction(): Promise<void> {
  const actor = await requireActor();
  try {
    await postOpeningBalances(null, actor);
  } catch (err) {
    back('/cutover/opening', { error: errorMessage(err) });
  }
  back('/cutover/opening', { posted: '1' });
}

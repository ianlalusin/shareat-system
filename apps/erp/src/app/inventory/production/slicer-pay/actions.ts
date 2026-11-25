'use server';

/**
 * Server action for the slicer pay rates. T-635. Thin: the gate is `set_pay_rate` inside `setSlicerPayRate`, and the actor comes from the session.
 */
import { setSlicerPayRate } from '@shareat/domain';
import { withOrgPrincipal } from '../lib';
import { requireActor } from '../../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function saveSlicerRateAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production/slicer-pay');
  const storeId = str(fd, 'storeId');
  const back = '/inventory/production/slicer-pay';
  let result: Awaited<ReturnType<typeof setSlicerPayRate>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      setSlicerPayRate(tx, actor, {
        storeId,
        itemId: str(fd, 'itemId') || null,
        ratePerKg: str(fd, 'ratePerKg'),
        effectiveFrom: str(fd, 'effectiveFrom'),
        note: str(fd, 'note') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash(back, { store: storeId }, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(back, { store: storeId }, { error: result.reason });
  return await redirectWithFlash(back, { store: storeId }, { ok: 'Rate saved. It applies to slicing from its start date; earlier days keep the old rate.' });
}

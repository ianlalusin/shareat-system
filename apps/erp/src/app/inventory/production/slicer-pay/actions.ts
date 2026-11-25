'use server';

/**
 * Server action for the slicer pay rates. T-635. Thin: the gate is `set_pay_rate` inside `setSlicerPayRate`, and the actor comes from the session.
 */
import { assertFieldRules, setSlicerPayRate } from '@shareat/domain';
import { SLICER_RATE_RULES } from '@shareat/domain/field-rules';
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
    // The domain call authorizes first and owns every sentence; the form's own rules are asserted on the same fields (T-440 S9).
    const checked = assertFieldRules(SLICER_RATE_RULES, fd);
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      setSlicerPayRate(tx, actor, {
        storeId,
        itemId: str(fd, 'itemId') || null,
        ratePerKg: checked.ratePerKg,
        effectiveFrom: checked.effectiveFrom,
        note: str(fd, 'note') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash(back, { store: storeId }, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(back, { store: storeId }, { error: result.reason });
  return await redirectWithFlash(back, { store: storeId }, { ok: 'Rate saved. It applies to slicing from its start date; earlier days keep the old rate.' });
}

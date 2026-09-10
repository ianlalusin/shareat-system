'use server';

/**
 * The two operator actions. T-183.
 *
 * ⛔ **No rule is enforced here.** `retryQuarantined` re-runs the real ingest path and
 * `discardQuarantined` refuses a blank reason, both in the domain, and `authorize()` gates each one
 * there too. These functions parse `FormData`, call the domain, and redirect.
 *
 * ⛔ **There is deliberately no third action.** Bible §5.4 rule 5 asks for *"a defined operator
 * action"* — singular and defined, not a toolbox. In particular there is no "edit the event": the
 * raw body is a fact from a device, and correcting attendance is what `manual_entry` punches
 * (T-156) and adjustments (T-158) are for, both of which attribute the human who did it. An
 * editable inbox would be a second, unattributed write path into payroll.
 */
import { redirect } from 'next/navigation';
import { discardQuarantined, retryQuarantined } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { errorMessage } from '@/lib/constraint-messages';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(q ? `/attendance/lane?${q}` : '/attendance/lane');
}

/**
 * ⭐ Retry asks the question again; it does not answer it.
 *
 * A retry that succeeds heals the row through exactly the same code an ordinary re-delivery would,
 * with `resolved_by` left null — because the world changed, not because a person decided.
 */
export async function retryEventAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/attendance/lane');
  const storeId = str(formData, 'storeId');
  const quarantineId = str(formData, 'quarantineId');

  // ⚠️ `redirect()` works by THROWING, so it must sit outside the try — a `back()` inside it would
  // be caught by this function's own catch and re-reported as a failure.
  let notice: string;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      retryQuarantined(tx, actor, { quarantineId, storeId }),
    );
    notice = result.ingested
      ? 'That event went through and is now a punch.'
      : `Still stuck: ${result.stillStuckBecause ?? 'unknown'}. Nothing about it has changed yet.`;
  } catch (err) {
    back({ store: storeId, error: errorMessage(err) });
  }
  back({ store: storeId, notice });
}

/** ⛔ The one button here that can lose a real shift. It needs a reason and it names who pressed it. */
export async function discardEventAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/attendance/lane');
  const storeId = str(formData, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      discardQuarantined(tx, actor, {
        quarantineId: str(formData, 'quarantineId'),
        storeId,
        reason: str(formData, 'reason'),
      }),
    );
  } catch (err) {
    back({ store: storeId, error: errorMessage(err) });
  }
  back({ store: storeId, notice: 'Discarded. The event is kept, with your reason against it.' });
}

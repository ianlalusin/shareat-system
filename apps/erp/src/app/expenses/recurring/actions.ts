'use server';

/**
 * Server actions for `/expenses/recurring`. T-216.
 *
 * ⛔ The gate is `manage_recurring_expenses`, inside the service. A gate in a server action
 * protects one caller.
 */
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  setRecurringTemplateStatus,
  updateRecurringTemplate,
} from '@shareat/domain';
import type { RecurringInterval } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { RECURRING_TEMPLATE_EDIT } from './typed-forms';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      createRecurringTemplate(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        categoryId: str(formData, 'categoryId'),
        supplierId: str(formData, 'supplierId'),
        defaultAmount: str(formData, 'defaultAmount'),
        defaultMoneyAccountId: str(formData, 'defaultMoneyAccountId') || null,
        interval: str(formData, 'interval') as RecurringInterval,
        // T-374 S5 / DEF-579 — raw: the domain parses it after `authorize()`; a blank is refused there, never read as 0.
        anchorDay: str(formData, 'anchorDay'),
        // T-430: the period it starts from; blank = today. A past date makes the nightly job write catch-up drafts.
        startsOn: str(formData, 'startsOn') || undefined,
        tillIsDeliberate: str(formData, 'tillIsDeliberate') === 'on',
      }),
    );
    // ⭐ Says the derived due date back, because it is the one field nobody typed — and a template
    // that silently starts next month instead of this one is the defect this sentence prevents.
    message = `Template saved. First due ${result.nextDueDate}.`;
  } catch (err) {
    return await redirectWithFlash('/expenses/recurring', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/expenses/recurring', { store: storeId }, { ok: message });
}

export async function updateTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  try {
    const interval = str(formData, 'interval');
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateRecurringTemplate(tx, actor, {
        templateId: str(formData, 'templateId'),
        name: str(formData, 'name'),
        categoryId: str(formData, 'categoryId'),
        supplierId: formData.has('supplierId') ? str(formData, 'supplierId') : undefined,
        defaultAmount: str(formData, 'defaultAmount'),
        defaultMoneyAccountId: str(formData, 'defaultMoneyAccountId') || null,
        interval: interval ? (interval as RecurringInterval) : undefined,
        // A form that does not carry the box leaves the stored day alone; a box that is there but blank is refused.
        anchorDay: formData.has('anchorDay') ? str(formData, 'anchorDay') : undefined,
        tillIsDeliberate: str(formData, 'tillIsDeliberate') === 'on',
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/expenses/recurring', { store: storeId }, { error: errorMessage(err), typed: keepTyping(formData, RECURRING_TEMPLATE_EDIT, str(formData, 'templateId'), { actorId: actor.personId }) });
  }
  return await redirectWithFlash('/expenses/recurring', { store: storeId }, { ok: 'Template updated.' });
}

export async function setTemplateStatusAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  const status = str(formData, 'status') === 'paused' ? 'paused' : 'active';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setRecurringTemplateStatus(tx, actor, { templateId: str(formData, 'templateId'), status }),
    );
  } catch (err) {
    return await redirectWithFlash('/expenses/recurring', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/expenses/recurring', { store: storeId }, {
    ok:
      status === 'paused'
        ? 'Paused. It keeps its history and stops coming due.'
        : 'Resumed. ⚠️ Its next due date was moved forward to the next one from today — a template that woke up months behind would try to catch up.',
  });
}

export async function deleteTemplateAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const storeId = str(formData, 'storeId');
  try {
    // T-418 (Ian, row 348): a never-produced template is an unposted draft; no admin PIN. The domain keeps its gate and refusal.
    const templateId = str(formData, 'templateId');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await deleteRecurringTemplate(tx, actor, { templateId });
    });
  } catch (err) {
    return await redirectWithFlash('/expenses/recurring', { store: storeId }, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/expenses/recurring', { store: storeId }, { ok: 'Template deleted — it had never produced anything.' });
}

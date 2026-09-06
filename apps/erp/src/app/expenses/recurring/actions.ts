'use server';

/**
 * Server actions for `/expenses/recurring`. T-216.
 *
 * ⛔ The gate is `manage_recurring_expenses`, inside the service. A gate in a server action
 * protects one caller.
 */
import { redirect } from 'next/navigation';
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  setRecurringTemplateStatus,
  updateRecurringTemplate,
} from '@shareat/domain';
import type { RecurringInterval } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Strips the throwing function's name — right for a log, useless on screen. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/expenses/recurring?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
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
        defaultAmount: str(formData, 'defaultAmount'),
        defaultMoneyAccountId: str(formData, 'defaultMoneyAccountId') || null,
        interval: str(formData, 'interval') as RecurringInterval,
        anchorDay: Number(str(formData, 'anchorDay')),
        tillIsDeliberate: str(formData, 'tillIsDeliberate') === 'on',
      }),
    );
    // ⭐ Says the derived due date back, because it is the one field nobody typed — and a template
    // that silently starts next month instead of this one is the defect this sentence prevents.
    message = `Template saved. First due ${result.nextDueDate}.`;
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  back(storeId, { ok: message });
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
        defaultAmount: str(formData, 'defaultAmount'),
        defaultMoneyAccountId: str(formData, 'defaultMoneyAccountId') || null,
        interval: interval ? (interval as RecurringInterval) : undefined,
        anchorDay: Number(str(formData, 'anchorDay')),
        tillIsDeliberate: str(formData, 'tillIsDeliberate') === 'on',
      }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  back(storeId, { ok: 'Template updated.' });
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
    back(storeId, { error: errorMessage(err) });
  }
  back(storeId, {
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
    await withOrgPrincipal(actor.orgId, (tx) =>
      deleteRecurringTemplate(tx, actor, { templateId: str(formData, 'templateId') }),
    );
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  back(storeId, { ok: 'Template deleted — it had never produced anything.' });
}

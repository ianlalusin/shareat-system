'use server';

/**
 * Server action for `/settings/business-rules`. T-512 (T-511 S5c).
 *
 * ⛔ No rule is re-implemented here. `setBusinessRule` calls `authorize(..., 'manage_business_rules')` as its own first statement (admin
 * only), and owns the bounds, the decimals, the reason and the no-backdating rule, each with its own plain sentence. This action reads the
 * form, calls it and shows the sentence that comes back; a refused save keeps what was typed.
 */
import { revalidatePath } from 'next/cache';
import { setBusinessRule } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { keepTyping } from '../../../lib/keep-typing';
import { withOrgPrincipal } from './lib';
import { BUSINESS_RULE_EDIT, ruleRecordId } from './typed-forms';

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setBusinessRuleAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/business-rules');
  const key = str(fd, 'key');
  const input = { key, value: str(fd, 'value'), effectiveFrom: str(fd, 'effectiveFrom'), reason: str(fd, 'reason') };
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setBusinessRule(tx, actor, input));
  } catch (err) {
    return await redirectWithFlash('/settings/business-rules', {}, { error: errorMessage(err), typed: keepTyping(fd, BUSINESS_RULE_EDIT, ruleRecordId(key), { actorId: actor.personId }) });
  }
  revalidatePath('/settings/business-rules');
  return await redirectWithFlash('/settings/business-rules', {}, { ok: 'The new value is saved. It applies from the day you chose; days before it keep the old value.' });
}

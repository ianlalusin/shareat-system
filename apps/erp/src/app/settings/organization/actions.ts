'use server';

/**
 * Server action for `/settings/organization`. T-229 slice 4 (DEF-208).
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_chart_of_accounts', {})` **inside**
 * `setOrganizationIdentity` — this action does not re-check it, for the reason
 * `settings/attendance/actions.ts:6-9` states: a gate here would protect only this one caller.
 *
 * ⭐ **The organisation is never read from the form.** `setOrganizationIdentity` takes it from the
 * Actor and has no `orgId` parameter at all — the shape DEF-210 exists to close.
 */
import { revalidatePath } from 'next/cache';
import { setOrganizationIdentity } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { ORGANIZATION_IDENTITY } from './typed-forms';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setOrganizationIdentityAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/organization');
  // ⭐ Every field on every save, and `''` means "not stated" rather than the empty string
  // (DEF-087's shape). That is what makes a wrong TIN correctable — an identifier that cannot be
  // removed is worse than one that was never set.
  const taxRaw = str(fd, 'taxType');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setOrganizationIdentity(tx, actor, {
        legalName: str(fd, 'legalName') || null,
        tin: str(fd, 'tin') || null,
        taxType: taxRaw === '' ? null : (taxRaw as 'vat' | 'non_vat'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/organization', {}, { error: errorMessage(err), typed: keepTyping(fd, ORGANIZATION_IDENTITY, '', { actorId: actor.personId }) });
  }
  revalidatePath('/settings/organization');
  return await redirectWithFlash('/settings/organization', {}, { ok: 'Saved. This is what a document printed from these books will carry.' });
}

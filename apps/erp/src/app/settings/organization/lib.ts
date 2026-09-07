/**
 * Server-only reads for `/settings/organization`. T-229 slice 4 (DEF-208).
 *
 * ⭐ Ungated, like every other settings surface here — the gate belongs to the WRITE, which
 * `setOrganizationIdentity` performs itself. Hiding a screen is presentation, not a control
 * (DEF-051); a manager who opens this sees it and is refused on submit, which is honest.
 */
import { organizationIdentity } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };

export type OrganizationIdentityView = Awaited<ReturnType<typeof organizationIdentity>>;

export async function identityView(actor: Actor): Promise<OrganizationIdentityView> {
  return withOrgPrincipal(actor.orgId, (tx) => organizationIdentity(tx, actor));
}

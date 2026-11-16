/**
 * Who may READ a document that has no store (an organisation-wide memo). T-584, Ian 15 Nov 2026.
 *
 * Anyone who holds `view_documents` at ANY store may list, open and print a storeless document and see the signature images on it; an administrator
 * (`manage_document_templates`, org scope) always may. ISSUING, REVISING, VOIDING and SIGNING a storeless document stay the administrator's: nothing here
 * grants any of them.
 */
import { authorize, can, type Actor } from '@shareat/auth';
import { storesRepo, type Tx } from '@shareat/db';

export async function authorizeViewStoreless(tx: Tx, actor: Actor): Promise<void> {
  const stores = await storesRepo.listForOrg(tx, actor.orgId);
  for (const s of stores) if (await can(tx, actor, 'view_documents', { storeId: s.id })) return;
  if (await can(tx, actor, 'manage_document_templates', {})) return;
  // Held nowhere: the refusal of the first store, the same one a store document gives (or the admin refusal when the organisation has no store).
  if (stores[0]) await authorize(tx, actor, 'view_documents', { storeId: stores[0].id });
  await authorize(tx, actor, 'manage_document_templates', {});
}

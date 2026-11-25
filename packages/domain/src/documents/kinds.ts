/**
 * Document kinds. T-637 (migration 0281, docs/tasks/637-document-editor.md "Addition"). The organisation's own list of kinds (Certificate of employment, Memo, Explanation letter ...),
 * edited by Ian on /documents/templates: add, rename, retire. A template points at one by id; the name is only a label, so nothing in the code branches on it.
 *
 * Capability `manage_document_templates` (org scope, the admin's), the same one that manages templates; `authorize()` is the first statement of every write and every write is audited
 * against entity `document_kinds`. Retire is refused while an ACTIVE template uses the kind (the kind row is locked, and a template save takes a share lock on it, so the two cannot cross).
 * An issued document keeps the name its version froze (the letterhead snapshot), so renaming or retiring a kind never changes a printed page.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, documentsRepo, type Tx } from '@shareat/db';
import type { DocumentKindStatus } from '@shareat/db/schema';
import { DOCUMENT_KIND_RULES } from '../field-rules/documents';
import { assertFieldRules } from '../shared/field-rules-assert';
import { gone, refuse } from '../shared/refusal';
import { authorizeViewStoreless } from './access';

const CAPABILITY = 'manage_document_templates' as const;

export interface DocumentKindItem {
  id: string;
  name: string;
  active: boolean;
}

const asItem = (k: documentsRepo.DocumentKindRow): DocumentKindItem => ({ id: k.id, name: k.name, active: k.status === 'active' });

function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 4; i++, e = (e as { cause?: unknown }).cause) {
    const x = e as { code?: string; constraint_name?: string };
    if (x.code === '23505' && x.constraint_name) return x.constraint_name;
  }
  return undefined;
}

/** A race past the pre-check lands on the unique index: say it in words. */
function translate(err: unknown, name: string): never {
  if (constraintOf(err) === 'document_kinds_org_name_unique') throw refuse('document kinds: duplicate name', `There is already a kind called "${name}".`);
  throw err;
}

const cleanName = (raw: string): string => assertFieldRules(DOCUMENT_KIND_RULES, { name: raw }).name ?? '';

async function assertFree(tx: Tx, orgId: string, name: string, exceptId?: string): Promise<void> {
  const same = await documentsRepo.findKindByName(tx, orgId, name);
  if (same && same.id !== exceptId) throw refuse(`document kinds: "${name}" matches kind ${same.id}`, `There is already a kind called "${same.name}". Kind names are the same whatever the capital letters.`);
}

/** Every kind of the org, retired ones marked, for the admin's list. */
export async function listDocumentKinds(tx: Tx, actor: Actor): Promise<DocumentKindItem[]> {
  await authorize(tx, actor, CAPABILITY, {});
  return (await documentsRepo.listKinds(tx, actor.orgId)).map(asItem);
}

/** The kinds for a filter or a pick-list. Anyone who may read documents may see the NAMES (they print on the register); only the admin edits them. */
export async function documentKindOptions(tx: Tx, actor: Actor): Promise<DocumentKindItem[]> {
  await authorizeViewStoreless(tx, actor);
  return (await documentsRepo.listKinds(tx, actor.orgId)).map(asItem);
}

export async function createDocumentKind(tx: Tx, actor: Actor, input: { name: string }): Promise<{ id: string }> {
  await authorize(tx, actor, CAPABILITY, {});
  const name = cleanName(input.name);
  await assertFree(tx, actor.orgId, name);
  const sortOrder = (await documentsRepo.listKinds(tx, actor.orgId)).reduce((m, k) => Math.max(m, k.sortOrder), 0) + 10;
  let id: string;
  try {
    id = await documentsRepo.insertKind(tx, { orgId: actor.orgId, name, sortOrder });
  } catch (err) {
    translate(err, name);
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document_kind.created',
    storeId: null,
    entityId: id,
    before: null,
    after: { name, sortOrder },
    source: 'web',
  });
  return { id };
}

async function loadForUpdate(tx: Tx, actor: Actor, kindId: string): Promise<documentsRepo.DocumentKindRow> {
  const row = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(kindId) ? await documentsRepo.getKindLocked(tx, actor.orgId, kindId, 'update') : null;
  if (!row) throw gone(`document kinds: kind ${kindId} not in org`, 'document kind');
  return row;
}

export async function renameDocumentKind(tx: Tx, actor: Actor, input: { kindId: string; name: string }): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  const before = await loadForUpdate(tx, actor, input.kindId);
  const name = cleanName(input.name);
  if (name === before.name) return;
  await assertFree(tx, actor.orgId, name, before.id);
  try {
    await documentsRepo.updateKind(tx, actor.orgId, before.id, { name });
  } catch (err) {
    translate(err, name);
  }
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'document_kind.renamed',
    storeId: null,
    entityId: before.id,
    before: { name: before.name },
    after: { name },
    source: 'web',
  });
}

/** Retire is refused while an active template uses the kind; reactivating needs nothing. */
export async function setDocumentKindStatus(tx: Tx, actor: Actor, input: { kindId: string; status: DocumentKindStatus }): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  if (input.status !== 'active' && input.status !== 'retired') throw refuse(`document kinds: unknown status ${String(input.status)}`, 'Choose active or retired.');
  const before = await loadForUpdate(tx, actor, input.kindId);
  if (before.status === input.status) return;
  const retiring = input.status === 'retired';
  if (retiring) {
    const used = await documentsRepo.countActiveTemplatesOfKind(tx, actor.orgId, before.id);
    if (used > 0) {
      throw refuse(
        `document kinds: ${before.id} retire while ${used} active template(s) use it`,
        `${before.name} is used by ${used} ${used === 1 ? 'template' : 'templates'}. Retire or change ${used === 1 ? 'that template' : 'those templates'} first, then retire the kind.`,
      );
    }
  }
  await documentsRepo.updateKind(tx, actor.orgId, before.id, { status: input.status });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: retiring ? 'document_kind.retired' : 'document_kind.reactivated',
    storeId: null,
    entityId: before.id,
    before: { status: before.status },
    after: { status: input.status },
    source: 'web',
  });
}

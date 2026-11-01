'use server';

/**
 * T-502 S4 - /items/import server actions. The gate is the domain's (`previewItemImport` / `confirmItemImport` call `authorize`
 * for `approve_item_request`); nothing here decides who may import.
 *
 * Confirm never trusts the preview: it takes the CSV TEXT again (the hidden `csv` field the preview page carries) and the domain
 * re-validates it inside its own database transaction (`withOrgPrincipal`). There is no list of rows a client could build.
 */
import { confirmItemImport, previewItemImport, type ItemImportPreview } from '@shareat/domain';
import { AuthorizationError } from '@shareat/auth';
import { withOrgPrincipal } from '../lib';
import { requireActor } from '../../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { MAX_UPLOAD_BYTES } from './lib';

export type PreviewImportResult =
  | { ok: true; csv: string; preview: ItemImportPreview }
  | { ok: false; error: string };

const TOO_BIG = 'This file is larger than 1 MiB, the most one import accepts. Split it into smaller files.';
const NOT_ADMIN = 'Only an admin can import items.';

/** Reads the uploaded file (size first), runs the preview and hands back the text and the rows. Writes nothing. */
export async function previewImportAction(formData: FormData): Promise<PreviewImportResult> {
  const actor = await requireActor();
  const file = formData.get('file');
  if (file === null || typeof file === 'string' || file.size === 0) return { ok: false, error: 'Choose the CSV file to check first.' };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_BIG };
  const csv = await file.text();
  try {
    const preview = await withOrgPrincipal(actor.orgId, (tx) => previewItemImport(tx, actor, csv));
    return { ok: true, csv, preview };
  } catch (err) {
    if (err instanceof AuthorizationError) return { ok: false, error: NOT_ADMIN };
    return { ok: false, error: sharedErrorMessage(err) };
  }
}

/** Creates the items. Re-reads the text, re-checks everything, all or nothing. */
export async function confirmImportAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const csv = formData.get('csv');
  if (typeof csv !== 'string' || csv === '') {
    return await redirectWithFlash('/items/import', {}, { error: 'The file was not sent with the Confirm. Choose it and check it again.' });
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_UPLOAD_BYTES) return await redirectWithFlash('/items/import', {}, { error: TOO_BIG });
  let message: string;
  try {
    const r = await withOrgPrincipal(actor.orgId, (tx) => confirmItemImport(tx, actor, csv));
    message =
      r.created === 0
        ? `Nothing new to add: all ${r.skipped} items were already in the list.`
        : `Created ${r.created} item${r.created === 1 ? '' : 's'} and ${r.aliasesAdded} other name${r.aliasesAdded === 1 ? '' : 's'}${r.skipped > 0 ? `; ${r.skipped} already in the list were skipped` : ''}.`;
  } catch (err) {
    if (err instanceof AuthorizationError) return await redirectWithFlash('/items/import', {}, { error: NOT_ADMIN });
    return await redirectWithFlash('/items/import', {}, { error: sharedErrorMessage(err) });
  }
  return await redirectWithFlash('/items', {}, { ok: message });
}

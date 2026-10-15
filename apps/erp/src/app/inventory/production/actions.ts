'use server';

/**
 * Server actions for the production screen — T-176.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message — same shape as
 * `inventory/usage/actions.ts`. The actor comes from the session, never the form.
 */
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import {
  createProductionDraft,
  editPostedProduction,
  postProduction,
  voidProduction,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

/** Maps the handful of known refusals onto a sentence a floor worker or manager can act on —
 *  same convention as `inventory/usage/actions.ts`'s `errorMessage`. */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (/live slicer payment/.test(raw)) return raw;
  // ⚠️ A frozen-room or closed-period refusal was listed here purely to strip its prefix. The
  // shared fallback does precisely that, so both fall through to it now — same sentence, one
  // implementation (T-255).
  return sharedErrorMessage(err);
}

function parseLines(fd: FormData, prefix: 'input' | 'output'): { itemId: string; quantity: string; unit: string }[] {
  const itemIds = strs(fd, `${prefix}ItemId`);
  const quantities = strs(fd, `${prefix}Quantity`);
  const units = strs(fd, `${prefix}Unit`);
  return itemIds
    .map((itemId, i) => ({ itemId, quantity: quantities[i] ?? '', unit: units[i] ?? '' }))
    .filter((l) => l.itemId && l.quantity && l.unit);
}

export async function saveProductionDraftAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const storeId = str(fd, 'storeId');
  const locationId = str(fd, 'locationId');
  const kind = str(fd, 'kind');
  const producedOn = str(fd, 'producedOn');
  // T-371 R6: a blank labour cost is passed on blank; the domain applies the column's default. Never `|| '0'`.
  const labourCost = str(fd, 'labourCost');
  const inputs = parseLines(fd, 'input');
  const outputs = parseLines(fd, 'output');

  if (kind !== 'slice' && kind !== 'cook' && kind !== 'convert') {
    return await redirectWithFlash('/inventory/production', { store: storeId }, { error: `unknown kind "${kind}"` });
  }

  let result: Awaited<ReturnType<typeof createProductionDraft>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      createProductionDraft(tx, actor, {
        orgId: actor.orgId, storeId, locationId, kind, producedOn, labourCost, inputs, outputs,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/inventory/production', { store: storeId }, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash('/inventory/production', { store: storeId }, { error: result.reason });

  revalidatePath('/inventory/production');
  return await redirectWithFlash(`/inventory/production/${result.recordId}`, {}, { ok: 'Draft saved. Nothing has posted — post is the step that moves stock and hits the books.' });
}

export async function postProductionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const recordId = str(fd, 'recordId');

  let result: Awaited<ReturnType<typeof postProduction>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => postProduction(tx, actor, { recordId }));
  } catch (err) {
    return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: result.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  const warn = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join('; ')}.` : '';
  return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { stamp: 'POSTED', ok: `Posted${result.journalEntryId ? ` — journal ${result.journalEntryId}` : ' (a convert posts no journal entry)'}.${warn}` });
}

export async function editPostedProductionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const recordId = str(fd, 'recordId');
  const labourCost = str(fd, 'labourCost') || undefined;
  const inputs = parseLines(fd, 'input');
  const outputs = parseLines(fd, 'output');

  let result: Awaited<ReturnType<typeof editPostedProduction>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      editPostedProduction(tx, actor, { recordId, inputs, outputs, labourCost }),
    );
  } catch (err) {
    return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: result.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { ok: `Edited — now revision ${result.revision}.` });
}

export async function voidProductionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const recordId = str(fd, 'recordId');
  const reason = str(fd, 'reason');

  let result: Awaited<ReturnType<typeof voidProduction>> | undefined;
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'production_record', recordId, ['void_production']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability: 'void_production' });
    result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await voidProduction(tx, actor, { recordId, reason });
      // `{ ok: false }` is a refusal the domain reports without throwing: nothing changed, so nothing is approved.
      if (voided.ok) await recordApproval(tx, actor, approval, { capability: 'void_production', entityType: 'production_record', entityId: recordId, storeId: target.storeId });
      return voided;
    });
  } catch (err) {
    return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: errorMessage(err) });
  }
  if (!result.ok) return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { error: result.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  return await redirectWithFlash(`/inventory/production/${recordId}`, {}, { stamp: 'VOID', ok: result.ledgerGap
      ? `Voided. Stock is restored. ⚠️ The ledger entry could not be reversed and the gap is reported: ${result.ledgerGapReason}`
      : 'Voided. Stock is restored and the entry is reversed.' });
}

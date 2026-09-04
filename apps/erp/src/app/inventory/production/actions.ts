'use server';

/**
 * Server actions for the production screen — T-176.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message — same shape as
 * `inventory/usage/actions.ts`. The actor comes from the session, never the form.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  createProductionDraft,
  editPostedProduction,
  postProduction,
  voidProduction,
} from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';

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
  const raw = err instanceof Error ? err.message : String(err);
  if (/may not 'record_stock_movement'/.test(raw)) return 'Recording a production run needs at least staff access to this store.';
  if (/may not 'post_production'/.test(raw)) return 'Only a manager or admin can post — posting is what moves stock and the books.';
  if (/may not 'edit_posted_production'/.test(raw)) return 'Only a manager or admin can edit a posted record.';
  if (/may not 'void_production'/.test(raw)) return 'Only a manager or admin can void a posted record.';
  if (/live slicer payment/.test(raw)) return raw;
  if (/is frozen by an active count session/.test(raw)) return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  if (/fiscal period .* is (closed|locked)/.test(raw)) return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
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
  const labourCost = str(fd, 'labourCost') || '0';
  const inputs = parseLines(fd, 'input');
  const outputs = parseLines(fd, 'output');

  if (kind !== 'slice' && kind !== 'cook' && kind !== 'convert') {
    back('/inventory/production', { store: storeId, error: `unknown kind "${kind}"` });
  }

  let result: Awaited<ReturnType<typeof createProductionDraft>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      createProductionDraft(tx, actor, {
        orgId: actor.orgId, storeId, locationId, kind, producedOn, labourCost, inputs, outputs,
      }),
    );
  } catch (err) {
    back('/inventory/production', { store: storeId, error: errorMessage(err) });
  }
  if (!result!.ok) back('/inventory/production', { store: storeId, error: result!.reason });

  revalidatePath('/inventory/production');
  back(`/inventory/production/${result!.recordId}`, {
    ok: 'Draft saved. Nothing has posted — post is the step that moves stock and hits the books.',
  });
}

export async function postProductionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const recordId = str(fd, 'recordId');

  let result: Awaited<ReturnType<typeof postProduction>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => postProduction(tx, actor, { recordId }));
  } catch (err) {
    back(`/inventory/production/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) back(`/inventory/production/${recordId}`, { error: result!.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  const warn = result!.warnings.length > 0 ? ` Warnings: ${result!.warnings.join('; ')}.` : '';
  back(`/inventory/production/${recordId}`, {
    ok: `Posted${result!.journalEntryId ? ` — journal ${result!.journalEntryId}` : ' (a convert posts no journal entry)'}.${warn}`,
  });
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
    back(`/inventory/production/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) back(`/inventory/production/${recordId}`, { error: result!.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  back(`/inventory/production/${recordId}`, { ok: `Edited — now revision ${result!.revision}.` });
}

export async function voidProductionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/production');
  const recordId = str(fd, 'recordId');
  const reason = str(fd, 'reason');

  let result: Awaited<ReturnType<typeof voidProduction>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => voidProduction(tx, actor, { recordId, reason }));
  } catch (err) {
    back(`/inventory/production/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) back(`/inventory/production/${recordId}`, { error: result!.reason });

  revalidatePath('/inventory/production');
  revalidatePath(`/inventory/production/${recordId}`);
  back(`/inventory/production/${recordId}`, {
    ok: result!.ledgerGap
      ? `Voided. Stock is restored. ⚠️ The ledger entry could not be reversed and the gap is reported: ${result!.ledgerGapReason}`
      : 'Voided. Stock is restored and the entry is reversed.',
  });
}

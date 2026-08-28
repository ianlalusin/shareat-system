'use server';

/** Server actions for the item master. T-145. The gates live in the service, not here. */
import { redirect } from 'next/navigation';
import { createItem } from '@shareat/domain';
import type { BaseUnit, ItemKind } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The duplicate-name violation is the one people will actually hit, and Postgres's own wording
  // for it is unreadable. Say what happened, and say why it is refused.
  if (/items_org_name_key/.test(raw)) {
    return 'An item with that name already exists — names are one per organisation, ignoring case. Use the existing one rather than a second spelling.';
  }
  if (/items_org_code_key/.test(raw)) return 'That item code is already in use.';
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

export async function createItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createItem(tx, actor, {
        code: str(formData, 'code'),
        name: str(formData, 'name'),
        kind: str(formData, 'kind') as ItemKind,
        baseUnit: str(formData, 'baseUnit') as BaseUnit,
        notes: str(formData, 'notes') || null,
      }),
    );
  } catch (err) {
    redirect(`/items?error=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect('/items?ok=Item+added.');
}

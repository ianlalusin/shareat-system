/**
 * T-611 - the reads behind the "Copy from another store" window (shared by /menu/hours and /menu/prices, and by the kitchen and discount slices later).
 * Plain reads inside the caller's `withOrgPrincipal`; every write is the domain's (`copySettingsToStore`).
 */
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { isOrgWideRole } from '@/lib/can-read-at-store';

export interface CopyStoreChoice {
  id: string;
  name: string;
  code: string;
}

/** The ACTIVE stores of the organisation: what the window offers as source and target (copying is within one organisation). */
export async function copyStoreChoices(tx: Tx, orgId: string): Promise<CopyStoreChoice[]> {
  return tx
    .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code })
    .from(schema.stores)
    .where(and(eq(schema.stores.orgId, orgId), eq(schema.stores.isActive, true)))
    .orderBy(asc(schema.stores.name));
}

/**
 * The stores to offer in the copy window, or null when the button is not drawn: only an administrator (org-wide role), and only when there is
 * another active store. Presentation only: the domain refuses a non-administrator, and the action verifies an administrator PIN first.
 */
export async function copyChoicesFor(tx: Tx, actor: Actor, currentStoreId: string): Promise<CopyStoreChoice[] | null> {
  if (!(await isOrgWideRole(tx, actor))) return null;
  const stores = await copyStoreChoices(tx, actor.orgId);
  return stores.some((s) => s.id !== currentStoreId) ? stores : null;
}

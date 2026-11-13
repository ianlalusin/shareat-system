/**
 * T-577 (DEF-834, bible row 461) - may `actor` read ONE record at the store it belongs to? True when they hold ANY of `capabilities` at
 * `storeId`. A single-record page loads the record, calls this with the record's own `storeId`, and calls `notFound()` on false, so a record
 * outside the viewer's stores is the same page as a forged id and never says it exists.
 *
 * Uses `can()`, the non-logging twin of `authorize()` (same `decide()`, so it cannot disagree): a page view is a probe, not an attempted act,
 * and must write no denial row. Pass a `tx` from `withOrgPrincipal`, and call it BEFORE any other read of the record's store.
 *
 * Its own file, not `page-access.tsx`: tests that stub `page-access` to skip the route gate must not also stub away the store check.
 */
import { can, type Actor, type Capability } from '@shareat/auth';
import type { Tx } from '@shareat/db';

export async function canReadAtStore(tx: Tx, actor: Actor, storeId: string, capabilities: readonly Capability[]): Promise<boolean> {
  for (const capability of capabilities) if (await can(tx, actor, capability, { storeId })) return true;
  return false;
}

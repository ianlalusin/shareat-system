/**
 * T-526 - the two server-side questions the /pos pages and layout ask. Reads only; the write gates stay in the domain (`authorize()`).
 */
import { heldCapabilities, resolvePosTablet, type Actor, type Capability, type PosTabletIdentity } from '@shareat/auth';
import { personsRepo, type Tx } from '@shareat/db';
// ⛔ From the CHOKEPOINT, not from `@shareat/db` (T-261 B6): the org-principalled transaction.
import { withOrgPrincipal } from '../expenses/lib';
import { heldStoresFor } from '@/lib/held-stores';
import { readPosTabletToken } from '@/lib/session';

/** The three words that open a POS tab (Receipts and Till ride on `record_sale`). */
export const POS_CAPABILITIES: readonly Capability[] = ['record_sale', 'serve_pos_ticket', 'request_pos_refill'];

/** What the shell shows beside the tabs: the stores this person works at, and their own name (names, never ids: bible row 229). */
export async function posShellFacts(tx: Tx, actor: Actor): Promise<{ stores: { id: string; name: string }[]; displayName: string }> {
  const stores = (await heldStoresFor(tx, actor, POS_CAPABILITIES)).map((s) => ({ id: s.id, name: s.name }));
  const me = await personsRepo.getPersonById(tx, actor.orgId, actor.personId);
  return { stores, displayName: me?.displayName?.trim() || 'Signed in' };
}

/**
 * Which store a POS request is for. On a PAIRED tablet the pairing's store always wins and a different `?storeId` is refused (a paired tablet cannot
 * be pointed at another store by a URL); with no pairing the requested store is used as given (the caller still checks the person holds it).
 */
export function effectiveStore(pairing: { storeId: string } | null, requested: string | undefined): { storeId: string | null; refused: boolean } {
  if (pairing) return { storeId: pairing.storeId, refused: !!requested && requested.toLowerCase() !== pairing.storeId.toLowerCase() };
  return { storeId: requested || null, refused: false };
}

/** This browser's pairing, read inside the caller's org-principalled transaction (RLS shows only this organisation's pairings), or null. */
export async function pairingInOrg(tx: Tx, actor: Actor): Promise<PosTabletIdentity | null> {
  const token = await readPosTabletToken();
  const pairing = token ? await resolvePosTablet(tx, token) : null;
  return pairing && pairing.orgId === actor.orgId ? pairing : null;
}

/**
 * True when a page must answer with the one sentence (`StoreNotAvailable`). A layout cannot read `searchParams`, so every page asks this itself.
 * Paired: a `?storeId` other than the pairing's store is refused. Not paired: the requested store must be one this person holds `capability` at.
 */
export async function storeRefused(actor: Actor, requested: string | undefined, capability: Capability): Promise<boolean> {
  const { pairing, stores } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    pairing: await pairingInOrg(tx, actor),
    stores: requested ? await heldStoresFor(tx, actor, [capability]) : [],
  }));
  const { storeId, refused } = effectiveStore(pairing, requested);
  if (refused) return true;
  // Paired: the pairing's store is the store; a lost grant there shows as the state poll's 403 banner. No `?storeId`: nothing to check.
  return !pairing && !!storeId && !stores.some((st) => st.id === storeId);
}

/**
 * T-526b - where a person who may NOT open Orders (no `record_sale`) goes instead of seeing the refusal: their first POS tab, Kitchen before Refills
 * (the same order as the sign-in landing). Null when they hold neither, so the refusal still shows. Reads only; each target page still gates itself.
 */
export async function firstOtherPosTab(actor: Actor): Promise<'/pos/kitchen' | '/pos/refills' | null> {
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));
  return held.has('serve_pos_ticket') ? '/pos/kitchen' : held.has('request_pos_refill') ? '/pos/refills' : null;
}

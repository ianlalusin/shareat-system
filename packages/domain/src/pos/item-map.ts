/**
 * POS item mapping — the standing decision, and the "can't be mapped" request workflow. T-177.
 *
 * ⭐ **The third mode is the important one** (§3): `no_stock` is a recorded decision that a POS
 * item sells but consumes no ERP stock, not an absence of one. It is what stops the item
 * resurfacing in the orphan section every day (invariant 6).
 *
 * ⭐ **Meat maps like anything else — §4.** v1 blocked mapping any `meat_slab`/`meat_sliced` item
 * because `meatUsageRecords` carried no `locationId`; T-145 made `items` one table and T-161 gives
 * every movement a `location_id`, so that gap is closed structurally. ⛔ No `kind` carve-out
 * anywhere in this module — invariant 11.
 */
import { authorize, type Actor } from '@shareat/auth';
import { compareDecimal, decimal, type Decimal } from '@shareat/core/money';
import { posMappingRepo, type Tx } from '@shareat/db';
import { parseDecimalInput } from '../shared/money-input';

export interface UpsertPosItemMapInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly mode: 'direct' | 'recipe' | 'no_stock';
  readonly itemId?: string | null;
  readonly recipeId?: string | null;
  /** Decimal string, required for 'direct'. */
  readonly quantityPerSale?: string | null;
  readonly locationId?: string | null;
  /** Invariant 8 — required to proceed when `itemId` is already the target of another ACTIVE
   *  'direct' map in this store. Recipe maps never need this: sharing is normal there. */
  readonly confirmShared?: boolean;
  /** When set, edits this existing map in place rather than creating a new one — a second `save`
   *  for the same `posItemKey` from the mapping screen. */
  readonly editMapId?: string | null;
}

export type UpsertPosItemMapOutcome =
  | { readonly ok: true; readonly mapId: string }
  | { readonly ok: false; readonly reason: string; readonly needsConfirmation?: boolean };

export async function upsertPosItemMap(tx: Tx, actor: Actor, input: UpsertPosItemMapInput): Promise<UpsertPosItemMapOutcome> {
  await authorize(tx, actor, 'manage_pos_map', { storeId: input.storeId });

  if (!input.posItemKey.trim()) return { ok: false, reason: 'a map needs the POS item key' };

  // T-371 — `quantity_per_sale` is numeric(14,6), nullable, but REQUIRED for a direct map (the
  // `pos_item_maps` mode CHECK). Parsed after `authorize()` into its column's brand: a malformed
  // value ("abc", "NaN") gets a sentence quoting it instead of reaching the INSERT, and the
  // positivity test is an exact decimal comparison, not `Number(x) <= 0` (NaN-blind).
  let quantityPerSale: Decimal<'14,6'> | null = null;
  if (input.mode === 'direct') {
    if (!input.itemId) return { ok: false, reason: 'a direct map needs a stock item' };
    if (input.quantityPerSale == null || String(input.quantityPerSale).trim() === '') {
      return { ok: false, reason: 'a direct map needs a quantity-per-sale greater than zero' };
    }
    try {
      quantityPerSale = parseDecimalInput(input.quantityPerSale, '14,6', 'upsertPosItemMap: the quantity per sale', 'Quantity per sale');
    } catch (e) {
      const userMessage = (e as { userMessage?: unknown }).userMessage;
      if (typeof userMessage === 'string') return { ok: false, reason: userMessage };
      throw e;
    }
    if (compareDecimal(quantityPerSale, decimal('0', '14,6')) <= 0) {
      return { ok: false, reason: 'a direct map needs a quantity-per-sale greater than zero' };
    }
    const conflict = await posMappingRepo.findOtherActiveDirectMapByItem(tx, input.storeId, input.itemId, input.editMapId ?? null);
    if (conflict && !input.confirmShared) {
      return {
        ok: false,
        needsConfirmation: true,
        reason:
          `this stock item is already directly mapped to "${conflict.posItemName}" — sharing one stock item across ` +
          'POS items is legal, but a direct map needs explicit confirmation, since sharing is usually a mis-click',
      };
    }
  } else if (input.mode === 'recipe') {
    if (!input.recipeId) return { ok: false, reason: 'a recipe map needs a recipe' };
  } else if (input.itemId || input.recipeId) {
    return { ok: false, reason: 'a "no_stock" map may not carry a stock item or a recipe' };
  }

  const values = {
    orgId: input.orgId,
    storeId: input.storeId,
    posItemKey: input.posItemKey.trim(),
    posItemName: input.posItemName.trim(),
    mode: input.mode,
    itemId: input.mode === 'direct' ? input.itemId! : null,
    recipeId: input.mode === 'recipe' ? input.recipeId! : null,
    quantityPerSale: input.mode === 'direct' ? quantityPerSale : null,
    locationId: input.locationId ?? null,
  };

  if (input.editMapId) {
    // ⭐ Finding-B shape (this codebase's recurring cross-store bug): `authorize()` above only
    // checked the actor's OWN scope against `input.storeId` — it says nothing about which store the
    // TARGET row actually belongs to. Without this check, a manager scoped only to store A could
    // pass another store's map id and silently edit it.
    const target = await posMappingRepo.getMapById(tx, input.editMapId);
    if (!target) return { ok: false, reason: `map ${input.editMapId} does not exist` };
    if (target.storeId !== input.storeId) {
      return { ok: false, reason: `map ${input.editMapId} belongs to a different store` };
    }
    await posMappingRepo.updateMap(tx, input.editMapId, values);
    return { ok: true, mapId: input.editMapId };
  }

  const existing = await posMappingRepo.getActiveMapByKey(tx, input.storeId, values.posItemKey);
  if (existing) {
    await posMappingRepo.updateMap(tx, existing.id, values);
    return { ok: true, mapId: existing.id };
  }

  const { id } = await posMappingRepo.insertMap(tx, { ...values, createdBy: actor.personId });
  return { ok: true, mapId: id };
}

export interface RequestMapInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posItemKey: string;
  readonly posItemName: string;
  readonly note?: string | null;
}

export type RequestMapOutcome = { readonly ok: true; readonly requestId: string } | { readonly ok: false; readonly reason: string };

/**
 * ⭐ Invariant 7 — open to **anyone who can record usage**, not gated to managers. "The person who
 * hits it is the person who knows." The request never moves stock.
 */
export async function requestMap(tx: Tx, actor: Actor, input: RequestMapInput): Promise<RequestMapOutcome> {
  await authorize(tx, actor, 'request_pos_map', { storeId: input.storeId });

  if (!input.posItemKey.trim()) return { ok: false, reason: 'a request needs the POS item key' };

  const alreadyMapped = await posMappingRepo.getActiveMapByKey(tx, input.storeId, input.posItemKey);
  if (alreadyMapped) {
    return { ok: false, reason: `"${input.posItemName}" is already mapped — edit the map instead of requesting it` };
  }
  const open = await posMappingRepo.findOpenRequest(tx, input.storeId, input.posItemKey);
  if (open) {
    return { ok: false, reason: `"${input.posItemName}" already has a request waiting on a manager` };
  }

  const { id } = await posMappingRepo.insertRequest(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    posItemKey: input.posItemKey.trim(),
    posItemName: input.posItemName.trim(),
    note: input.note?.trim() || null,
    requestedBy: actor.personId,
  });
  return { ok: true, requestId: id };
}

export interface DecideMapRequestInput {
  readonly requestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly note?: string | null;
}

export type DecideMapRequestOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Approving **silences it** — recorded as a `no_stock` map, the only thing that stops the orphan
 * section resurfacing it (invariant 6). Rejecting returns it to unmapped (invariant 4): no map is
 * written, so the next plan shows it as an orphan again, exactly as before the request.
 */
export async function decideMapRequest(tx: Tx, actor: Actor, input: DecideMapRequestInput): Promise<DecideMapRequestOutcome> {
  const request = await posMappingRepo.getRequestById(tx, input.requestId);
  if (!request) return { ok: false, reason: `request ${input.requestId} does not exist` };
  await authorize(tx, actor, 'decide_pos_map_request', { storeId: request.storeId });

  if (request.status !== 'requested') {
    return { ok: false, reason: `request ${input.requestId} was already ${request.status}` };
  }

  await posMappingRepo.decideRequest(tx, input.requestId, {
    status: input.decision,
    decidedBy: actor.personId,
    decisionNote: input.note?.trim() || null,
  });

  if (input.decision === 'approved') {
    const existing = await posMappingRepo.getActiveMapByKey(tx, request.storeId, request.posItemKey);
    const values = {
      orgId: request.orgId,
      storeId: request.storeId,
      posItemKey: request.posItemKey,
      posItemName: request.posItemName,
      mode: 'no_stock' as const,
      itemId: null,
      recipeId: null,
      quantityPerSale: null,
      locationId: null,
    };
    if (existing) await posMappingRepo.updateMap(tx, existing.id, values);
    else await posMappingRepo.insertMap(tx, { ...values, createdBy: actor.personId });
  }

  return { ok: true };
}

/**
 * Reads for /menu/usage-source (T-401 S5). Plain reads inside the caller's `withOrgPrincipal`; every write goes through the
 * seam in packages/domain/src/pos/depletion-source.ts, which authorizes, validates and audits.
 */
import { and, asc, eq } from 'drizzle-orm';
import { menuRepo, posMappingRepo, schema, stockLocationsRepo, type Tx } from '@shareat/db';
import { compareDepletionSources, type SourceComparison } from '@shareat/domain';
import type { Actor } from '@shareat/auth';

export interface LinkRow {
  id: string;
  posItemKey: string;
  posItemName: string | null;
  variantLabel: string;
  roomName: string | null;
}
export interface UnlinkedMap {
  posItemKey: string;
  posItemName: string;
}
export interface SwitchRow {
  id: string;
  source: 'v1_pos_map' | 'menu_rules';
  reason: string | null;
  differenceCount: number | null;
  createdAt: Date;
}
export interface VariantChoice {
  id: string;
  label: string;
}
export interface UsageSourcePageData {
  source: 'v1_pos_map' | 'menu_rules';
  history: SwitchRow[];
  links: LinkRow[];
  unlinked: UnlinkedMap[];
  variants: VariantChoice[];
  rooms: { id: string; name: string }[];
  comparison: SourceComparison | null;
}

export async function loadUsageSourcePage(tx: Tx, actor: Actor, storeId: string, compare: boolean): Promise<UsageSourcePageData> {
  const source = await menuRepo.usageSourceInForce(tx, storeId);
  const history = (await menuRepo.usageSwitchHistory(tx, storeId, 20)).map((r) => ({
    id: r.id,
    source: r.source,
    reason: r.reason,
    differenceCount: r.differenceCount,
    createdAt: r.createdAt,
  }));
  const maps = await posMappingRepo.listActiveMaps(tx, storeId);
  const nameByKey = new Map(maps.map((m) => [m.posItemKey, m.posItemName]));
  const rooms = (await stockLocationsRepo.listActiveLocations(tx, storeId)).map((r) => ({ id: r.id, name: r.name }));
  const roomName = new Map(rooms.map((r) => [r.id, r.name]));

  const v = schema.menuItemVariants;
  const i = schema.menuItems;
  const variantRows = await tx
    .select({ id: v.id, label: v.label, itemName: i.name })
    .from(v)
    .innerJoin(i, eq(i.id, v.menuItemId))
    .where(and(eq(v.orgId, actor.orgId), eq(v.status, 'active'), eq(i.status, 'active')))
    .orderBy(asc(i.name), asc(v.label), asc(v.id));
  const variants = variantRows.map((r) => ({ id: r.id, label: r.label ? `${r.itemName} (${r.label})` : r.itemName }));
  const variantLabel = new Map(variants.map((x) => [x.id, x.label]));

  const linkRows = await menuRepo.listActiveLinks(tx, storeId);
  const linked = new Set(linkRows.map((l) => l.posItemKey));
  const links = linkRows.map((l) => ({
    id: l.id,
    posItemKey: l.posItemKey,
    posItemName: nameByKey.get(l.posItemKey) ?? null,
    variantLabel: variantLabel.get(l.variantId) ?? 'A menu item that is no longer active',
    roomName: l.locationId ? (roomName.get(l.locationId) ?? 'A room that is no longer active') : null,
  }));
  const unlinked = maps.filter((m) => !linked.has(m.posItemKey)).map((m) => ({ posItemKey: m.posItemKey, posItemName: m.posItemName }));
  const comparison = compare ? await compareDepletionSources(actor, { storeId }, tx) : null;
  return { source, history, links, unlinked, variants, rooms, comparison };
}

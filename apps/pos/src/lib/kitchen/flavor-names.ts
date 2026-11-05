import type { StoreFlavor } from '@/lib/types';

/** Id -> name map for the kitchen "Flv:" badges. In erp mode the ERP menu is the only source (a late Firestore fetch must not overwrite it). */
export function kitchenFlavorMap(erp: { flavors: StoreFlavor[] } | null, firestoreMap: Map<string, string>): Map<string, string> {
  return erp ? new Map(erp.flavors.map((f) => [f.flavorId, f.flavorName])) : firestoreMap;
}

export const flavorNamesOf = (ids: string[] | undefined, map: Map<string, string>) =>
  ids?.map((id) => map.get(id) || 'Unknown').filter(Boolean);

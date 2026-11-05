/** T-508 R9 - `POS_MENU_SOURCE=erp|firestore`, server env, read ONCE per process; anything else (or unset) is `firestore`. Tablets learn it from /api/pos2/health. */
export type MenuSourceName = 'erp' | 'firestore';
let cached: MenuSourceName | null = null;
export function readMenuSource(): MenuSourceName {
  if (cached === null) cached = process.env.POS_MENU_SOURCE === 'erp' ? 'erp' : 'firestore';
  return cached;
}

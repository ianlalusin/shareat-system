/**
 * Server-only reads for `/settings/usage-tolerance`. T-401 S6.
 *
 * The page gate (`requirePageAccess('/settings/usage-tolerance')`, `set_menu_depletion`, admin only) is the READ control; the write
 * gate is `setOrgUsageTolerance` / `setItemUsageTolerance`'s own `authorize()`. Plain reads here carry no second gate.
 */
import { itemsRepo, stockUsageRepo } from '@shareat/db';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };

export interface ToleranceItemRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  /** The item's own override as stored ('0.0500'), or null when the org setting applies. */
  readonly override: string | null;
}

export interface ToleranceView {
  /** The org-wide band as stored ('0.1000' = 10%). */
  readonly org: string;
  readonly items: readonly ToleranceItemRow[];
}

export async function toleranceView(orgId: string): Promise<ToleranceView> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await itemsRepo.listItems(tx, orgId);
    const { org, byItem } = await stockUsageRepo.usageTolerancesFor(tx, orgId, rows.map((r) => r.id));
    return { org, items: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, override: byItem.get(r.id) ?? null })) };
  });
}

/** '0.1000' -> '10%', '0.0250' -> '2.5%' (decimal string arithmetic, no floats). */
export function percentOf(tolerance: string): string {
  const [whole = '0', frac = ''] = tolerance.split('.');
  const padded = frac.padEnd(4, '0');
  const pct = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  const rest = padded.slice(2).replace(/0+$/, '');
  return `${pct}${rest ? `.${rest}` : ''}%`;
}

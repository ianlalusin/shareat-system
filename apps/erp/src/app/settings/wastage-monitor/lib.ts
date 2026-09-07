/**
 * Server-only reads for `/settings/wastage-monitor`. T-229 slice 3.
 *
 * ⭐ Plain reads carry **no capability gate** — the gate belongs to the write, which
 * `setWastageMonitor` performs itself. Same asymmetry as `/settings/expense-categories/lib.ts`
 * and `/settings/sales-channels/lib.ts`, and the house rule in `apps/erp/src/app/admin/users/lib.ts`.
 */
import { ownerlessTrackedWastages, wastageMonitorOf } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };
export { listActivePersons, listStores } from '../../expenses/lib';

export interface MonitorView {
  readonly monitor: { personId: string; displayName: string; isActive: boolean } | null;
  /** What an unset Monitor is costing right now — derived on read, never stored. */
  readonly ownerless: { count: number; amount: string };
}

export async function monitorView(actor: Actor, storeId: string): Promise<MonitorView> {
  return withOrgPrincipal(actor.orgId, async (tx) => ({
    monitor: await wastageMonitorOf(tx, actor, storeId),
    ownerless: await ownerlessTrackedWastages(tx, actor, storeId),
  }));
}

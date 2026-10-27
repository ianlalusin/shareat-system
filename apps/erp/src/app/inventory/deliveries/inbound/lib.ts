/**
 * Server-only reads for the inbound-shipments screens - T-398 S5d.
 *
 * Plain reads under the org's RLS principal; every rule (who may see, what is shown) lives in `packages/domain/src/deliveries/inter-entity.ts`.
 */
import { sql } from 'drizzle-orm';
import { getInboundReceiveChoices, getInboundShipment, listInboundShipments, type InboundReceiveChoices, type InboundShipment } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { listStores, withOrgPrincipal } from '../../../expenses/lib';
import type { Tx } from '@shareat/db';

export { listStores };
export type { InboundReceiveChoices, InboundShipment };

export function inboundList(actor: Actor, includeVoid: boolean): Promise<InboundShipment[]> {
  return withOrgPrincipal(actor.orgId, (tx) => listInboundShipments(tx, actor, { includeVoid }));
}

export function inboundShipment(actor: Actor, id: string): Promise<InboundShipment | null> {
  return withOrgPrincipal(actor.orgId, (tx) => getInboundShipment(tx, actor, id));
}

export function inboundReceiveChoices(actor: Actor, id: string): Promise<InboundReceiveChoices | null> {
  return withOrgPrincipal(actor.orgId, (tx) => getInboundReceiveChoices(tx, actor, id));
}

/**
 * The org principal PLUS the acting person. `withOrgPrincipal` sets the org only; the receive and system-bill definers (migration 0218) read
 * `app.person_id` and refuse 42501 without it. Transaction-scoped (`set_config(..., true)`), so it reverts at commit like the org does.
 */
export function withActorPrincipal<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    await tx.execute(sql`select set_config('app.person_id', ${actor.personId}, true)`);
    return fn(tx);
  });
}

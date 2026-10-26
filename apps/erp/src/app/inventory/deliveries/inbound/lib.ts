/**
 * Server-only reads for the inbound-shipments screens - T-398 S5d.
 *
 * Plain reads under the org's RLS principal; every rule (who may see, what is shown) lives in `packages/domain/src/deliveries/inter-entity.ts`.
 */
import { getInboundReceiveChoices, getInboundShipment, listInboundShipments, type InboundReceiveChoices, type InboundShipment } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { listStores, withOrgPrincipal } from '../../../expenses/lib';

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

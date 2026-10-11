/**
 * v1_master_links - T-391 S1. Two functions and nothing else: read an org's links of one entity, write one link.
 * A link is never updated or deleted (the app role has no such grant). Both run under the caller's org principal.
 */
import { and, eq } from 'drizzle-orm';
import type { Decimal } from '@shareat/core/money';
import type { Tx } from '../client';
import { v1MasterLinks, type V1LinkEntity } from '../../schema/v1-master-links';

export interface MasterLinkRow {
  id: string;
  orgId: string;
  entity: V1LinkEntity;
  v1StoreId: string;
  v1Id: string;
  v2Id: string;
  v1Unit: string | null;
  factorToBase: string | null;
  createdBy: string;
  createdAt: Date;
}

export interface MasterLinkInput {
  orgId: string;
  entity: V1LinkEntity;
  v1StoreId: string;
  v1Id: string;
  v2Id: string;
  v1Unit: string | null;
  factorToBase: Decimal<'14,6'> | null;
  createdBy: string;
}

export async function linksFor(tx: Tx, orgId: string, entity: V1LinkEntity): Promise<MasterLinkRow[]> {
  const rows = await tx
    .select()
    .from(v1MasterLinks)
    .where(and(eq(v1MasterLinks.orgId, orgId), eq(v1MasterLinks.entity, entity)));
  return rows as MasterLinkRow[];
}

export async function insertLink(tx: Tx, row: MasterLinkInput): Promise<{ id: string }> {
  const [created] = await tx.insert(v1MasterLinks).values(row).returning({ id: v1MasterLinks.id });
  return created!;
}

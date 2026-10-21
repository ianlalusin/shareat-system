/**
 * T-436 - the one audit writer for leave. Every transition writes ONE row in the caller's transaction (no change commits without
 * its row, no row for a rolled-back change). The payload carries who, which dates and which kind - never the note (bible row 353),
 * never a stored file's id, path or URL.
 */
import { auditLogRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';

export interface LeaveAuditInput {
  readonly storeId: string | null;
  /** The request id (or the cap / type / commutation id for those events). */
  readonly entityId: string;
  readonly before?: Record<string, unknown> | null;
  readonly after: Record<string, unknown>;
}

/**
 * One audit row. The action is the THIRD positional argument, a string literal at every call site, so the catalogue build guard
 * (`t402-s1b-catalogue`: every written action is catalogued, every live entry has a caller) can see it - same call shape as `menu/shared.ts`.
 */
export async function audit(tx: Tx, actor: Actor, action: string, input: LeaveAuditInput): Promise<void> {
  const { storeId, entityId, before, after } = input;
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action,
    storeId,
    entityId,
    before: before ?? null,
    after,
    source: 'web',
  });
}

/**
 * The only place SQL is written for `audit_log`. T-350 S3 / DEF-169.
 *
 * `audit_log` had no writer anywhere until this task (the 2026-08-24 purge review counted zero
 * rows) — `setChannelPayoutDestination` (`packages/domain/src/channel-settlements/index.ts`) is
 * the first. `append` takes a required `actorPersonId: string`, not the column's own nullable
 * type: every USER-INITIATED action has an actor, and a caller with none does not compile. A
 * system/cron caller that genuinely has none writes the row directly (or a future variant of this
 * function is added for it) rather than this one silently accepting `undefined`.
 */
import type { Tx } from '../client';
import { auditLog } from '../../schema/audit-log';

export type AuditLogSource =
  | 'web'
  | 'pos'
  | 'customer'
  | 'website'
  | 'apk'
  | 'kiosk'
  | 'cron'
  | 'ingestor'
  | 'etl';

export interface AppendAuditLogInput {
  readonly actorPersonId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly source: AuditLogSource;
}

export async function append(tx: Tx, orgId: string, input: AppendAuditLogInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(auditLog)
    .values({
      orgId,
      actorPersonId: input.actorPersonId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      source: input.source,
    })
    .returning({ id: auditLog.id });
  // `!` is safe here, not a shortcut: this INSERT has no WHERE/ON CONFLICT clause, so it either
  // RETURNS exactly one row or the statement itself throws — there is no third outcome for a guard
  // to catch. Same idiom as `channel-settlements.ts`'s `insertSettlement` in this directory, not a
  // raw `throw new Error` (T-343 R1.2 — the `packages/db/src/repo` ratchet never rises).
  return { id: row!.id };
}

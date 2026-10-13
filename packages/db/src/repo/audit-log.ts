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
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../client';
import { refuse } from '../refusal';
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

/**
 * T-402 S1a - TEMPORARY. The table now requires category, sensitivity, severity and retention_class (NOT NULL,
 * CHECK-bound). Until S1b ships the event catalogue (`packages/db/src/audit/catalogue.ts`, which becomes the only
 * source of these labels and also owns redaction and scope checks), the 22 actions the 20 existing call sites write
 * carry their labels here - the SAME list as migration 0197's copy step, so a row written today is labelled exactly
 * like the row the migration copied. S1b deletes this map. An action not in it throws: a label is never guessed.
 */
const LEGACY_LABELS: Readonly<Record<string, { category: AuditCategory; sensitivity: AuditSensitivity }>> = {
  reopen_pin_sign_in: { category: 'security', sensitivity: 'high' },
  set_supplier_credit_terms: { category: 'money', sensitivity: 'normal' },
  set_supplier_status: { category: 'money', sensitivity: 'normal' },
  set_supplier_bank_account: { category: 'money', sensitivity: 'high' },
  set_supplier_counterparty_store: { category: 'money', sensitivity: 'normal' },
  set_channel_payout: { category: 'money', sensitivity: 'high' },
  set_customer_status: { category: 'customer', sensitivity: 'normal' },
  change_item_base_unit: { category: 'stock', sensitivity: 'normal' },
  set_item_purchase_unit: { category: 'stock', sensitivity: 'normal' },
  rename_item: { category: 'stock', sensitivity: 'normal' },
  retire_item: { category: 'stock', sensitivity: 'normal' },
  restore_item: { category: 'stock', sensitivity: 'normal' },
  set_staff_code: { category: 'staff', sensitivity: 'normal' },
  link_store_to_pos: { category: 'settings', sensitivity: 'normal' },
  unlink_store_from_pos: { category: 'settings', sensitivity: 'normal' },
  create_tender: { category: 'money', sensitivity: 'normal' },
  update_tender: { category: 'money', sensitivity: 'normal' },
  reactivate_tender: { category: 'money', sensitivity: 'normal' },
  retire_tender: { category: 'money', sensitivity: 'normal' },
  edit_sales_day: { category: 'money', sensitivity: 'high' },
  reimport_sales_day: { category: 'money', sensitivity: 'high' },
  set_platform_sales: { category: 'money', sensitivity: 'normal' },
};

type AuditCategory = (typeof auditLog.$inferInsert)['category'];
type AuditSensitivity = (typeof auditLog.$inferInsert)['sensitivity'];
const SEVERITY: Record<AuditSensitivity, number> = { critical: 2, high: 4, normal: 5, low: 6 };

export interface AppendAuditLogInput {
  readonly actorPersonId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly source: AuditLogSource;
  /** R1/R14: the store the act belongs to, when the caller holds one. Optional until S1b migrates the 20 callers. */
  readonly storeId?: string | null;
}

export async function append(tx: Tx, orgId: string, input: AppendAuditLogInput): Promise<{ id: string }> {
  const label = LEGACY_LABELS[input.action];
  if (!label) {
    // Refused loudly rather than defaulted: a row filed under a guessed category is worse than a failed write.
    throw refuse(
      `UNKNOWN_AUDIT_ACTION: ${input.action} has no category yet (S1b adds the catalogue)`,
      'That change could not be recorded in the activity log. Please tell the developers.',
    );
  }
  const retentionClass =
    ['money', 'order', 'menu_price', 'customer'].includes(label.category) || label.sensitivity !== 'low' ? 'r10y' : 'r2y';
  const [row] = await tx
    .insert(auditLog)
    .values({
      orgId,
      storeId: input.storeId ?? null,
      actorPersonId: input.actorPersonId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      source: input.source,
      category: label.category,
      sensitivity: label.sensitivity,
      severity: SEVERITY[label.sensitivity],
      retentionClass,
    })
    .returning({ id: auditLog.id });
  // `!` is safe here, not a shortcut: this INSERT has no WHERE/ON CONFLICT clause, so it either
  // RETURNS exactly one row or the statement itself throws — there is no third outcome for a guard
  // to catch. Same idiom as `channel-settlements.ts`'s `insertSettlement` in this directory, not a
  // raw `throw new Error` (T-343 R1.2 — the `packages/db/src/repo` ratchet never rises).
  return { id: row!.id };
}

export interface LatestAuditLogEntry {
  readonly actorPersonId: string | null;
  readonly occurredAt: Date;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * T-350 S4/S5 (G2) — the most recent audit row for one entity/action, so a caller can verify a
 * claim ("this just changed") against a real fact instead of trusting a query param. `before` is
 * read alongside `after` (S5) so a caller can tell a FIRST set (`before.moneyAccountId` null) from
 * a later change without a second read or a second guess. Tenancy is the caller's `tx` (RLS
 * confines the read to its own org already); `orgId` is still an explicit filter, the same
 * defence-in-depth every other read in this directory applies. Returns `undefined` when nothing
 * matches — a clean, ordinary answer, never an exception; a caller cannot mistake a genuinely
 * non-existent row for a broken read.
 */
export async function latestForEntity(
  tx: Tx,
  orgId: string,
  input: { entity: string; entityId: string; action: string },
): Promise<LatestAuditLogEntry | undefined> {
  const [row] = await tx
    .select({
      actorPersonId: auditLog.actorPersonId,
      occurredAt: auditLog.occurredAt,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        eq(auditLog.entity, input.entity),
        eq(auditLog.entityId, input.entityId),
        eq(auditLog.action, input.action),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(1);
  return row;
}

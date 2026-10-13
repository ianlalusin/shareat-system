/**
 * The only place SQL is written for `audit_log`. T-350 S3 / DEF-169, rebuilt by T-402 S1b.
 *
 * Every row's category, sensitivity, severity, retention class and entity come from the event catalogue
 * (`../audit/catalogue.ts`), never from the caller: the input types below have no field for them. The writer
 * refuses (the code is in the message) an unknown action (UNKNOWN_AUDIT_ACTION), a reserved one
 * (AUDIT_ACTION_RESERVED), the wrong kind of actor (AUDIT_ACTOR_MISMATCH) and a store that does not match the
 * entry's scope (AUDIT_SCOPE_MISMATCH). `before` / `after` are redacted on EVERY write (`../audit/redact.ts`:
 * secrets by key token, account numbers masked to the last 4) and capped at 16 KB serialised.
 *
 * The row is written in the CALLER'S transaction: no business change commits without its row, and no row commits
 * for a rolled-back change. `append` is for a person; `appendSystem` is for cron / ingestor / roll-up (actor
 * null); `appendClientEvent` is the storage half of the R10 offline envelope (S3 owns the rest).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../client';
import { refuse } from '../refusal';
import { auditLog, auditLogEventKeys } from '../../schema/audit-log';
import { canonicalJson } from '../audit/canonical-json';
import { catalogueEntry, severityFor, type CatalogueEntry } from '../audit/catalogue';
import { redactPayload } from '../audit/redact';

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

/** `before` + `after` serialised must fit this (R5); above it the writer stores a diff of the changed top-level keys. */
export const AUDIT_PAYLOAD_CAP_BYTES = 16 * 1024;

export interface AppendAuditLogInput {
  readonly actorPersonId: string;
  readonly action: string;
  /** The store the act belongs to; `null` for an org-scoped entry. The catalogue entry's scope decides which is legal. */
  readonly storeId: string | null;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly source: AuditLogSource;
  /** R10: the server-attested terminal (T-304), when the act came from one. */
  readonly deviceId?: string | null;
  /** When it happened, if not now (device time for a replayed offline event). `recorded_at` is always the server clock. */
  readonly occurredAt?: Date;
}

export interface AppendSystemAuditLogInput {
  readonly action: string;
  readonly storeId: string | null;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly source: AuditLogSource;
  readonly deviceId?: string | null;
  readonly occurredAt?: Date;
}

/** R10 envelope, as the device sends it. The attested values (actor, device, source, org) come from the server. */
export interface ClientEventEnvelope {
  readonly eventKey: string;
  readonly action: string;
  readonly entityId: string;
  readonly storeId: string | null;
  /** Device ISO time. */
  readonly occurredAt: string;
  readonly before: unknown;
  readonly after: unknown;
}
export interface ClientEventAttested {
  readonly actorPersonId: string;
  readonly deviceId: string | null;
  readonly source: AuditLogSource;
  /** The live session that uploaded the batch, kept apart from the actor who did it. */
  readonly uploadedByPersonId?: string | null;
}

const NOT_RECORDED = 'That change could not be recorded in the activity log. Please tell the developers.';

function lookup(action: string): CatalogueEntry {
  const entry = catalogueEntry(action);
  if (!entry) {
    // Refused loudly rather than defaulted: a row filed under a guessed category is worse than a failed write.
    throw refuse(`UNKNOWN_AUDIT_ACTION: ${action} is not in the event catalogue`, NOT_RECORDED);
  }
  return entry;
}

function checkScope(entry: CatalogueEntry, storeId: string | null): void {
  if (entry.scope === 'store' && storeId === null) {
    throw refuse(`AUDIT_SCOPE_MISMATCH: ${entry.action} is store-scoped and needs a store`, NOT_RECORDED);
  }
  if (entry.scope === 'org' && storeId !== null) {
    throw refuse(`AUDIT_SCOPE_MISMATCH: ${entry.action} is org-scoped and must not carry a store`, NOT_RECORDED);
  }
}

function checkWritable(entry: CatalogueEntry, kind: 'person' | 'system', storeId: string | null): void {
  if (entry.reserved) {
    throw refuse(`AUDIT_ACTION_RESERVED: ${entry.action} has no writer yet`, NOT_RECORDED);
  }
  if (entry.actor !== 'either' && entry.actor !== kind) {
    throw refuse(`AUDIT_ACTOR_MISMATCH: ${entry.action} is written by a ${entry.actor}, not a ${kind}`, NOT_RECORDED);
  }
  checkScope(entry, storeId);
}

const CLOCK_FUTURE_MS = 5 * 60 * 1000;
const CLOCK_PAST_MS = 30 * 24 * 3600 * 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function size(before: unknown, after: unknown): number {
  return Buffer.byteLength(JSON.stringify([before ?? null, after ?? null]));
}
function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** R5 payload cap: above 16 KB serialised, keep a diff of the changed top-level keys, shrink what is still too big. */
function capPayload(before: unknown, after: unknown): { before: unknown; after: unknown } {
  if (size(before, after) <= AUDIT_PAYLOAD_CAP_BYTES) return { before, after };
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => canonicalJson(b[k]) !== canonicalJson(a[k]));
  let nb: Record<string, unknown> = pick(b, keys);
  let na: Record<string, unknown> = { ...pick(a, keys), __truncated: true };
  if (size(nb, na) > AUDIT_PAYLOAD_CAP_BYTES) {
    const shrink = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => {
          const n = Buffer.byteLength(JSON.stringify(v ?? null));
          return [k, n > 256 ? `[truncated ${n} bytes]` : v];
        }),
      );
    nb = shrink(nb);
    na = shrink(na);
    na.__truncated = true;
  }
  if (size(nb, na) > AUDIT_PAYLOAD_CAP_BYTES) {
    nb = {};
    na = { __truncated: true, changedKeys: keys.slice(0, 100) };
  }
  return { before: nb, after: na };
}

interface Prepared {
  readonly before: unknown;
  readonly after: unknown;
  readonly redactedKeys: string[];
}
/** Redaction (R5) then the payload cap, on every write. Each side is compared with the OTHER unmasked side (the account-number `Changed` flag). */
function prepare(before: unknown, after: unknown): Prepared {
  const b = redactPayload(before, { compareWith: after });
  const a = redactPayload(after, { compareWith: before });
  const capped = capPayload(b.value, a.value);
  return {
    before: capped.before,
    after: capped.after,
    redactedKeys: [...b.redactedKeys.map((k) => `before.${k}`), ...a.redactedKeys.map((k) => `after.${k}`)],
  };
}

interface RowInput {
  readonly entry: CatalogueEntry;
  readonly actorPersonId: string | null;
  readonly storeId: string | null;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly source: AuditLogSource;
  readonly deviceId?: string | null;
  readonly occurredAt?: Date;
  readonly uploadedByPersonId?: string | null;
  readonly eventKey?: string;
}

async function insertRow(tx: Tx, orgId: string, r: RowInput): Promise<{ id: string; recordedAt: Date }> {
  const p = prepare(r.before, r.after);
  const clockSuspect =
    r.occurredAt !== undefined &&
    (r.occurredAt.getTime() > Date.now() + CLOCK_FUTURE_MS || r.occurredAt.getTime() < Date.now() - CLOCK_PAST_MS);
  const [row] = await tx
    .insert(auditLog)
    .values({
      orgId,
      storeId: r.storeId,
      actorPersonId: r.actorPersonId,
      action: r.entry.action,
      entity: r.entry.entity,
      entityId: r.entityId,
      before: p.before,
      after: p.after,
      source: r.source,
      category: r.entry.category,
      sensitivity: r.entry.sensitivity,
      severity: severityFor(r.entry.sensitivity),
      retentionClass: r.entry.retention,
      ...(r.occurredAt !== undefined ? { occurredAt: r.occurredAt } : {}),
      deviceId: r.deviceId ?? null,
      uploadedByPersonId: r.uploadedByPersonId ?? null,
      eventKey: r.eventKey ?? null,
      redactedKeys: p.redactedKeys,
      clockSuspect,
    })
    .returning({ id: auditLog.id, recordedAt: auditLog.recordedAt });
  // `!` is safe here, not a shortcut: this INSERT has no WHERE/ON CONFLICT clause, so it either
  // RETURNS exactly one row or the statement itself throws - there is no third outcome for a guard
  // to catch. Same idiom as `channel-settlements.ts`'s `insertSettlement` in this directory, not a
  // raw `throw new Error` (T-343 R1.2 - the `packages/db/src/repo` ratchet never rises).
  return { id: row!.id, recordedAt: row!.recordedAt };
}

/** A person did it. */
export async function append(tx: Tx, orgId: string, input: AppendAuditLogInput): Promise<{ id: string }> {
  const entry = lookup(input.action);
  checkWritable(entry, 'person', input.storeId);
  const { id } = await insertRow(tx, orgId, {
    entry,
    actorPersonId: input.actorPersonId,
    storeId: input.storeId,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    source: input.source,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt,
  });
  return { id };
}

/** Cron, ingestor or roll-up did it: `actor_person_id` is null. */
export async function appendSystem(tx: Tx, orgId: string, input: AppendSystemAuditLogInput): Promise<{ id: string }> {
  const entry = lookup(input.action);
  checkWritable(entry, 'system', input.storeId);
  const { id } = await insertRow(tx, orgId, {
    entry,
    actorPersonId: null,
    storeId: input.storeId,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    source: input.source,
    deviceId: input.deviceId,
    occurredAt: input.occurredAt,
  });
  return { id };
}

async function readEventKey(tx: Tx, orgId: string, eventKey: string) {
  const [row] = await tx
    .select({ auditLogId: auditLogEventKeys.auditLogId, payloadSha256: auditLogEventKeys.payloadSha256 })
    .from(auditLogEventKeys)
    .where(and(eq(auditLogEventKeys.orgId, orgId), eq(auditLogEventKeys.eventKey, eventKey)))
    .limit(1);
  return row;
}

function replayOrConflict(
  existing: { auditLogId: string; payloadSha256: string },
  hash: string,
  eventKey: string,
): { id: string; replayed: boolean } {
  if (existing.payloadSha256 === hash) return { id: existing.auditLogId, replayed: true };
  throw refuse(
    `AUDIT_EVENT_KEY_CONFLICT: event key ${eventKey} was already used for a different payload`,
    'That event was already recorded with different details.',
  );
}

/**
 * R10, storage half. One offline event, idempotent on `eventKey`: the same key with the same canonical-JSON hash
 * returns the first row (`replayed: true`) and inserts nothing; the same key with another hash is refused
 * (AUDIT_EVENT_KEY_CONFLICT; S3 writes the `security.event_replay_conflict` row in its own transaction). The action
 * must list `attested.source` in its `clientSources` (AUDIT_SOURCE_NOT_ALLOWED). Reserved is NOT checked here: the
 * allowlist is the gate for this path, and S3 owns the rest (store attestation, verified actor).
 */
export async function appendClientEvent(
  tx: Tx,
  orgId: string,
  envelope: ClientEventEnvelope,
  attested: ClientEventAttested,
): Promise<{ id: string; replayed: boolean }> {
  const entry = lookup(envelope.action);
  if (!(entry.clientSources as readonly string[]).includes(attested.source)) {
    throw refuse(`AUDIT_SOURCE_NOT_ALLOWED: ${entry.action} may not be sent by ${attested.source}`, 'That event could not be recorded in the activity log.');
  }
  checkScope(entry, envelope.storeId);
  const occurredAt = new Date(envelope.occurredAt);
  const hash = createHash('sha256')
    .update(
      canonicalJson({
        action: envelope.action,
        entityId: envelope.entityId,
        storeId: envelope.storeId,
        occurredAt: envelope.occurredAt,
        before: envelope.before,
        after: envelope.after,
      }),
    )
    .digest('hex');
  const existing = await readEventKey(tx, orgId, envelope.eventKey);
  if (existing) return replayOrConflict(existing, hash, envelope.eventKey);
  const inserted = await insertRow(tx, orgId, {
    entry,
    actorPersonId: attested.actorPersonId,
    storeId: envelope.storeId,
    entityId: envelope.entityId,
    before: envelope.before,
    after: envelope.after,
    source: attested.source,
    deviceId: attested.deviceId,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt,
    uploadedByPersonId: attested.uploadedByPersonId,
    eventKey: envelope.eventKey,
  });
  const claimed = await tx
    .insert(auditLogEventKeys)
    .values({
      orgId,
      eventKey: envelope.eventKey,
      payloadSha256: hash,
      auditLogId: inserted.id,
      retentionClass: entry.retention,
      recordedAt: inserted.recordedAt,
    })
    .onConflictDoNothing()
    .returning({ eventKey: auditLogEventKeys.eventKey });
  if (claimed.length === 0) {
    // Lost a race with a concurrent upload of the same key: the other row is the first one.
    const winner = await readEventKey(tx, orgId, envelope.eventKey);
    if (winner) return replayOrConflict(winner, hash, envelope.eventKey);
  }
  return { id: inserted.id, replayed: false };
}

export interface LatestAuditLogEntry {
  readonly actorPersonId: string | null;
  readonly occurredAt: Date;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * T-350 S4/S5 (G2) - the most recent audit row for one entity/action, so a caller can verify a
 * claim ("this just changed") against a real fact instead of trusting a query param. `before` is
 * read alongside `after` (S5) so a caller can tell a FIRST set (`before.moneyAccountId` null) from
 * a later change without a second read or a second guess. Tenancy is the caller's `tx` (RLS
 * confines the read to its own org already); `orgId` is still an explicit filter, the same
 * defence-in-depth every other read in this directory applies. Returns `undefined` when nothing
 * matches - a clean, ordinary answer, never an exception; a caller cannot mistake a genuinely
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

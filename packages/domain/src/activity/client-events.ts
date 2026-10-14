/**
 * T-402 S3 (R10, R10a; contract C1-C3) - `recordClientEvents`: the server half of the offline envelope.
 *
 * The cashier device never writes the log. A POS batch rides WITH the sale in the caller's transaction (`tx` is required:
 * a rollback drops the events with the sale). Every attested value comes from the server: the org and store from the
 * terminal's identity (`resolveTerminalIdentity`), the uploader from the session (`resolveActor`), the source is
 * `'pos'`. The envelope handed to the writer is built by explicit pick of the seven R10 fields, never a spread, so a
 * device that sends an `actorPersonId`, `orgId`, `source`, `category`, `retention` or `deviceId` changes nothing.
 *
 * No `authorize()` (the sale's path is the gate) and no HTTP route: nothing calls this outside tests until the POS v2
 * receipts spec (ADR-015 P2) fills `verifiedActorByEventKey` from a receipt's verified offline session.
 *
 * Throws (whole batch) only for an uploader of another org or another store than the terminal's, a source other than
 * `'pos'` (customer = ADR-015 P3), and database errors. Per event, in input order, it returns `accepted`, `replayed`
 * or `refused` with the writer's code; the refusals happen before any SQL can fail, so the transaction stays usable.
 * Failure events (`security.event_store_mismatch`, `security.event_replay_conflict`) go through the S2 outbox, in their
 * own transaction, so they survive the sale rolling back.
 */
import { auditLogRepo, catalogueEntry, RefusalError, UUID_SHAPE, type Tx } from '@shareat/db';
import { enqueueEventReplayConflict, enqueueEventStoreMismatch, type ResolvedSession, type TerminalIdentity } from '@shareat/auth';
import { refuse } from '../shared/refusal';

/** One event as the device sends it (the R10 envelope) plus the actor the device CLAIMS (never trusted). */
export interface ClientEventIn {
  readonly eventKey: string;
  readonly action: string;
  readonly entityId: string;
  readonly storeId: string | null;
  /** Device ISO time. */
  readonly occurredAt: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly actorClaim: string | null;
}

export type ClientEventResult =
  | { readonly eventKey: string; readonly status: 'accepted' | 'replayed'; readonly id: string }
  | { readonly eventKey: string; readonly status: 'refused'; readonly code: string };

export interface RecordClientEventsInput {
  readonly terminal: TerminalIdentity;
  readonly uploader: ResolvedSession;
  readonly source: 'pos';
  readonly events: readonly ClientEventIn[];
  /** eventKey -> the person whose verified offline session made the sale. Empty until the receipts spec fills it. */
  readonly verifiedActorByEventKey: ReadonlyMap<string, string>;
}

const WHOLE_BATCH = 'These events could not be recorded in the activity log.';

export async function recordClientEvents(tx: Tx, input: RecordClientEventsInput): Promise<ClientEventResult[]> {
  const { terminal, uploader } = input;
  if ((input.source as string) !== 'pos') {
    throw refuse(`AUDIT_SOURCE_NOT_ALLOWED: recordClientEvents takes POS batches only, not ${String(input.source)}`, WHOLE_BATCH);
  }
  if (uploader.actor.orgId !== terminal.orgId) {
    throw refuse('AUDIT_UPLOADER_MISMATCH: the uploading session belongs to another organization than the terminal', WHOLE_BATCH);
  }
  if (uploader.storeId !== terminal.storeId) {
    throw refuse('AUDIT_UPLOADER_MISMATCH: the uploading session is not bound to the terminal\'s store', WHOLE_BATCH);
  }
  const orgId = terminal.orgId;
  const uploaderId = uploader.actor.personId;

  const results: ClientEventResult[] = [];
  for (const e of input.events) {
    const eventKey = e.eventKey;
    // A uuid column would abort the sale's transaction on a non-uuid: refuse first, with SQL never reached.
    if (typeof eventKey !== 'string' || !UUID_SHAPE.test(eventKey) || typeof e.entityId !== 'string' || !UUID_SHAPE.test(e.entityId)) {
      results.push({ eventKey: String(eventKey), status: 'refused', code: 'AUDIT_BAD_ENVELOPE' });
      continue;
    }
    // The store check applies to an event the POS MAY send. An unknown, reserved or server-only action is refused by the
    // writer below with its own code (a security event about a store the device cannot even write to would be noise).
    const entry = catalogueEntry(String(e.action));
    const sendable = entry !== undefined && !entry.reserved && entry.clientSources.includes('pos');
    if (sendable && e.storeId !== terminal.storeId) {
      enqueueEventStoreMismatch(orgId, {
        storeId: terminal.storeId,
        actorPersonId: uploaderId,
        deviceId: terminal.deviceId,
        eventKey,
        action: String(e.action),
        claimedStoreId: typeof e.storeId === 'string' ? e.storeId : null,
      });
      results.push({ eventKey, status: 'refused', code: 'AUDIT_STORE_MISMATCH' });
      continue;
    }
    // R10a: the verified actor, else the uploader. The claim is only ever compared, never stored as the actor.
    const actor = input.verifiedActorByEventKey.get(eventKey) ?? uploaderId;
    const claimMismatch = e.actorClaim !== null && e.actorClaim !== undefined && e.actorClaim !== actor;
    try {
      const r = await auditLogRepo.appendClientEvent(
        tx,
        orgId,
        // Explicit pick of the seven R10 fields (Invariant 21): never a spread of the device's object.
        {
          eventKey,
          action: e.action,
          entityId: e.entityId,
          storeId: e.storeId,
          occurredAt: e.occurredAt,
          before: e.before,
          after: e.after,
        },
        { actorPersonId: actor, deviceId: terminal.deviceId, source: 'pos', uploadedByPersonId: uploaderId, actorClaimMismatch: claimMismatch },
      );
      results.push({ eventKey, status: r.replayed ? 'replayed' : 'accepted', id: r.id });
    } catch (err) {
      if (!(err instanceof RefusalError)) throw err;
      const code = (err.message.split(':')[0] ?? '').trim();
      if (code === 'AUDIT_EVENT_KEY_CONFLICT') {
        enqueueEventReplayConflict(orgId, { actorPersonId: uploaderId, deviceId: terminal.deviceId, eventKey });
      }
      results.push({ eventKey, status: 'refused', code });
    }
  }
  return results;
}

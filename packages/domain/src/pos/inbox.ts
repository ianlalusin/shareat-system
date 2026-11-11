/**
 * T-525 R2-R6 - the POS v2 events inbox: the tablet's outbox drains here. docs/tasks/525-pos-v2-apis.md.
 *
 * Each event runs ONE T-524 function in its OWN top-level transaction (never a savepoint: migration 0240's append guard refuses a receipt child
 * written in one). The `(pairing, seq)` insert comes first, so a replay is a no-op before any domain code runs. A refusal is never dropped: the
 * event is stored `quarantined` with its code and sentence, and a manager replays or discards it (R6). Only a temporary failure or a bug is `retry`:
 * nothing is stored and the batch stops, so the tablet keeps the event and everything after it.
 */
import { authorize, AuthenticationError, AuthorizationError, recordPosApprovalMiss, POS_DEVICE_CLOCK_SKEW_MS, POS_OFFLINE_SIGNIN_WINDOW_MS, POS_SIGNIN_CLOCK_SLACK_MS, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import { accessRepo, auditLogRepo, posV2Repo, RefusalError, withOrgPrincipal, type Tx } from '@shareat/db';
import { canonicalJson } from '../menu/project';
import { gone, refuse } from '../shared/refusal';
import { addLineDiscount, applyPresetToAllLines, removeLineDiscount } from './discounts';
import { addLines, cancelLine, isUniqueViolation, openStand, requestRefill, setHeadsCashier } from './order';
import { completeSale, voidUnpaidSession } from './sale';
import type { PosDeps } from './shared';

export const POS_NOT_SWITCHED_ON = 'The POS is not switched on for this store.';
const ALREADY_HANDLED = 'This event was already handled.';
const REPLAY_VOID = 'Ask the manager to void this table again from the till.';

/** A refusal code that means "not the event's fault": the event is NOT stored, the tablet keeps it and tries again. A missing setup must not bury good sales. (Empty since T-539 wired the rules; the list stays as the one place to add a code.) */
export const RETRYABLE_POS_CODES: readonly string[] = [];

/** True for a refusal code that is a server-side failure, never the event's fault: the closed list above, or any AUDIT_* code (the activity-log writer refusing means a server bug, and quarantining would bury a good sale). */
export const isRetryableRefusal = (code: string): boolean => RETRYABLE_POS_CODES.includes(code) || code.startsWith('AUDIT_') || code.startsWith('UNKNOWN_AUDIT_');

export interface PosPairing {
  pairingId: string;
  orgId: string;
  storeId: string;
}
export interface PosEventIn {
  seq: number;
  kind: string;
  personId: string;
  occurredAtDevice: string;
  payload: Record<string, unknown>;
}
export interface PosEventResult {
  seq: number;
  status: 'applied' | 'duplicate' | 'conflict' | 'quarantined' | 'retry';
  error?: string;
  /** A conflict names the kind already stored under that (pairing, seq). */
  storedKind?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// R3 - strict payload schemas. Unknown keys are refused, so a payload can never name its own store or pairing.
// ---------------------------------------------------------------------------------------------------------------------
type Check = (v: unknown) => boolean;
interface Spec {
  req: Record<string, Check>;
  opt?: Record<string, Check>;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid: Check = (v) => typeof v === 'string' && UUID_RE.test(v);
const int: Check = (v) => typeof v === 'number' && Number.isInteger(v);
const str: Check = (v) => typeof v === 'string';
const bool: Check = (v) => typeof v === 'boolean';
const time: Check = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const oneOf =
  (...xs: string[]): Check =>
  (v) =>
    typeof v === 'string' && xs.includes(v);
const obj =
  (spec: Spec): Check =>
  (v) =>
    isObj(v) && problemOf(spec, v) === null;
const list =
  (item: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(item);

/** The first field that fails, or null. */
function problemOf(spec: Spec, o: Record<string, unknown>): string | null {
  for (const k of Object.keys(o)) if (!Object.hasOwn(spec.req, k) && !Object.hasOwn(spec.opt ?? {}, k)) return `${k} is not allowed in this event`;
  for (const [k, c] of Object.entries(spec.req)) if (!c(o[k])) return `${k} is missing or not valid`;
  for (const [k, c] of Object.entries(spec.opt ?? {})) if (k in o && !c(o[k])) return `${k} is not valid`;
  return null;
}

const MAX_ITEMS = 1000;
const lineSpec: Spec = {
  req: { lineId: uuid, menuItemId: uuid, qty: int, addedAtDevice: time },
  opt: { variantId: uuid, note: str, optionValueIds: list(uuid, MAX_ITEMS) },
};
const refillLineSpec: Spec = { req: { lineId: uuid, menuItemId: uuid, qty: int, addedAtDevice: time } };

type Base = { storeId: string; pairingId: string };
interface Handler {
  spec: Spec;
  /** The payload is already checked against `spec`; the cast only restores the type the schema proves. */
  run: (tx: Tx, actor: Actor, base: Base, p: Record<string, unknown>, deps: PosDeps | undefined) => Promise<unknown>;
}
const HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  [
    'stand.opened',
    {
      spec: { req: { sessionId: uuid, mode: oneOf('dine_in', 'take_out'), headsCashier: int, openedAtDevice: time }, opt: { standId: uuid, lines: list(obj(lineSpec), MAX_ITEMS) } },
      run: (tx, a, b, p) => openStand(tx, a, { ...p, ...b } as unknown as Parameters<typeof openStand>[2]),
    },
  ],
  ['lines.added', { spec: { req: { sessionId: uuid, lines: list(obj(lineSpec), MAX_ITEMS) } }, run: (tx, a, b, p) => addLines(tx, a, { ...p, ...b } as unknown as Parameters<typeof addLines>[2]) }],
  ['heads.set', { spec: { req: { sessionId: uuid, headsCashier: int } }, run: (tx, a, b, p) => setHeadsCashier(tx, a, { ...p, ...b } as unknown as Parameters<typeof setHeadsCashier>[2]) }],
  [
    'refill.requested',
    { spec: { req: { sessionId: uuid, lines: list(obj(refillLineSpec), MAX_ITEMS) } }, run: (tx, a, b, p) => requestRefill(tx, a, { ...p, ...b } as unknown as Parameters<typeof requestRefill>[2]) },
  ],
  ['line.cancelled', { spec: { req: { lineId: uuid, reason: str } }, run: (tx, a, b, p) => cancelLine(tx, a, { ...p, ...b } as unknown as Parameters<typeof cancelLine>[2]) }],
  [
    'discount.added',
    {
      spec: {
        req: { discountId: uuid, lineId: uuid, kind: oneOf('senior', 'pwd', 'preset', 'custom'), qty: int, appliedAtDevice: time },
        opt: { presetId: uuid, valueType: oneOf('percent', 'fixed'), value: str, dinerNo: int },
      },
      run: (tx, a, b, p, d) => addLineDiscount(tx, a, { ...p, ...b } as unknown as Parameters<typeof addLineDiscount>[2], d),
    },
  ],
  [
    'discount.removed',
    { spec: { req: { discountId: uuid, removedAtDevice: time } }, run: (tx, a, b, p) => removeLineDiscount(tx, a, { ...p, ...b } as unknown as Parameters<typeof removeLineDiscount>[2]) },
  ],
  [
    'discount.applied_to_all',
    {
      spec: { req: { sessionId: uuid, presetId: uuid, applyId: uuid, appliedAtDevice: time } },
      run: (tx, a, b, p) => applyPresetToAllLines(tx, a, { ...p, ...b } as unknown as Parameters<typeof applyPresetToAllLines>[2]),
    },
  ],
  [
    'session.voided',
    {
      spec: { req: { sessionId: uuid, reason: str, voidedAtDevice: time, offline: bool }, opt: { approval: obj({ req: { pin: str } }) } },
      run: (tx, a, b, p) => voidUnpaidSession(tx, a, { ...p, ...b } as unknown as Parameters<typeof voidUnpaidSession>[2]),
    },
  ],
  [
    'sale.completed',
    {
      spec: {
        req: {
          sessionId: uuid,
          receiptId: uuid,
          terminalNo: int,
          terminalSeq: int,
          issuedAtDevice: time,
          offline: bool,
          device: obj({ req: { subtotal: str, discountTotal: str, total: str, lines: list(obj({ req: { lineId: uuid, gross: str, discountTotal: str, net: str } }), MAX_ITEMS) } }),
          payments: list(obj({ req: { tenderId: uuid, amount: str, toCheck: bool }, opt: { referenceNo: str } }), MAX_ITEMS),
          seniors: list(obj({ req: { dinerNo: int, kind: oneOf('senior', 'pwd'), idNumber: str, holderName: str } }), MAX_ITEMS),
        },
      },
      run: (tx, a, b, p, d) => completeSale(tx, a, { ...p, ...b } as unknown as Parameters<typeof completeSale>[2], d),
    },
  ],
]);

const MAX_DEPTH = 64;
/** What the safety net stores when the database will not hold an event's own payload. */
const UNSTORABLE: Record<string, unknown> = { unstorable: true };
interface Scrubbed {
  value: Record<string, unknown>;
  /** A reason the event cannot be run (a NUL character in a text, or nesting too deep): it is stored cleaned and quarantined as invalid. */
  problem: string | null;
}
/**
 * What is stored for an event (and compared on a resend): a PIN never lands in a table, so every key whose name matches /pin/i, at any depth and on any
 * kind, is replaced by `pinGiven: true`; and a NUL character or an unpaired UTF-16 surrogate (neither of which Postgres can hold in jsonb), in a key or a value, is replaced by U+FFFD, the event being flagged invalid.
 */
function scrub(payload: Record<string, unknown>): Scrubbed {
  let problem: string | null = null;
  const text = (t: string) => {
    if (!t.includes('\u0000') && t.isWellFormed()) return t;
    problem = t.includes('\u0000') ? 'a text in it contains a NUL character' : 'a text in it contains a broken character';
    return t.replaceAll('\u0000', '\uFFFD').toWellFormed();
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (typeof v !== 'object' || v === null) return v;
    if (depth > MAX_DEPTH) {
      problem = 'it is nested too deeply';
      return '[too deep]';
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (/pin/i.test(k)) out.pinGiven = true;
      else out[text(k)] = walk(x, depth + 1);
    }
    return out;
  };
  return { value: walk(payload, 0) as Record<string, unknown>, problem };
}

// ---------------------------------------------------------------------------------------------------------------------
// R2 - the envelope, checked once for the route (a malformed one is a 400 and nothing is processed)
// ---------------------------------------------------------------------------------------------------------------------
const KIND_SHAPE = /^[a-z]+(\.[a-z_]+)+$/;
export const MAX_EVENTS_PER_BATCH = 100;

export function parsePosEvents(body: unknown): { ok: true; events: PosEventIn[] } | { ok: false; error: string } {
  if (!isObj(body) || !Array.isArray(body.events)) return { ok: false, error: 'Send an object with a list of events.' };
  const n = body.events.length;
  if (n < 1 || n > MAX_EVENTS_PER_BATCH) return { ok: false, error: `Send between 1 and ${MAX_EVENTS_PER_BATCH} events at a time.` };
  const events: PosEventIn[] = [];
  for (const [i, e] of body.events.entries()) {
    const at = `Event ${i + 1}`;
    if (!isObj(e)) return { ok: false, error: `${at} is not an object.` };
    if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1) return { ok: false, error: `${at}: seq must be a whole number from 1.` };
    if (typeof e.kind !== 'string' || !KIND_SHAPE.test(e.kind)) return { ok: false, error: `${at}: kind is missing or not valid.` };
    if (typeof e.personId !== 'string' || !UUID_RE.test(e.personId)) return { ok: false, error: `${at}: personId is missing or not valid.` };
    if (!time(e.occurredAtDevice)) return { ok: false, error: `${at}: occurredAtDevice is not a valid time.` };
    if (!isObj(e.payload)) return { ok: false, error: `${at}: payload must be an object.` };
    events.push({ seq: e.seq, kind: e.kind, personId: e.personId.toLowerCase(), occurredAtDevice: e.occurredAtDevice as string, payload: e.payload });
  }
  return { ok: true, events };
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusal codes
// ---------------------------------------------------------------------------------------------------------------------
class PosEventRefusal extends Error {
  constructor(
    readonly code: string,
    readonly sentence: string,
  ) {
    super(`${code}: ${sentence}`);
  }
}
const invalid = (sentence: string) => new PosEventRefusal('POS_EVENT_INVALID', `The event is not valid: ${sentence}.`);
const personRefused = (sentence: string) => new PosEventRefusal('POS_EVENT_PERSON_REFUSED', sentence);

/** The code a refusal carries: a leading `UPPER_SNAKE:` in its raw message (T-524 `refuse()` calls such as RECORDED_DIFFERENTLY), else null. */
export function refusalCode(err: unknown): string | null {
  return err instanceof RefusalError ? (/^([A-Z][A-Z0-9_]+):/.exec(err.message)?.[1] ?? null) : null;
}

/** The 5-character SQLSTATE an error (or its cause) carries, or null. Node's own codes (ECONNRESET, EPIPE) never start with a digit. */
function sqlstateOf(err: unknown): string | null {
  for (let e: unknown = err, i = 0; e && i < 5; i++, e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9][0-9A-Z]{4}$/.test(code)) return code;
  }
  return null;
}

/** An error that is the EVENT's fault (code + one sentence), or null for a temporary failure or a bug. Rulings 1 and 2. */
export function eventFault(err: unknown): { code: string; sentence: string } | null {
  if (err instanceof PosEventRefusal) return { code: err.code, sentence: err.sentence };
  if (err instanceof AuthorizationError) return { code: 'POS_EVENT_NOT_ALLOWED', sentence: err.userMessage ?? 'That person is not allowed to do this here.' };
  // A wrong PIN or a capped PIN bucket: the error's own sentence is written for a person (it never says which half was wrong).
  if (err instanceof AuthenticationError) return { code: 'POS_EVENT_PIN_REFUSED', sentence: err.message };
  if (err instanceof RefusalError) return { code: refusalCode(err) ?? 'POS_EVENT_REFUSED', sentence: err.userMessage };
  // A database refusal of the event's own data (SQLSTATE class 22 data exception, 23 integrity) is the event's fault; everything else (40001, 40P01, 08, 53, 57, unknown) is not.
  const state = sqlstateOf(err);
  if (state && (state.startsWith('22') || state.startsWith('23'))) return { code: 'POS_EVENT_INVALID', sentence: `The event could not be stored (database error ${state}).` };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// R4 + R3 + the domain call, in the caller's transaction
// ---------------------------------------------------------------------------------------------------------------------
interface Running {
  kind: string;
  personId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  /** From `scrub`: the event is already known to be unrunnable. */
  preProblem?: string | null;
  /** The device time is outside the years 1 to 9999 (or not a time): refused before anything else, and stored with the received time instead. */
  dateProblem?: string | null;
}

/** R4: the four clauses, then the actor the domain's own `authorize()` judges. `serverNow` is the server clock (for a replay, the moment the event arrived). */
async function checkPerson(tx: Tx, pairing: PosPairing, e: Running, serverNow: Date): Promise<Actor> {
  const { orgId, storeId, pairingId } = pairing;
  const person = await posV2Repo.getPersonOfOrg(tx, orgId, e.personId);
  if (!person) throw personRefused(`That person (${e.personId}) is not on this organisation's staff list.`);
  if (!person.isActive) throw personRefused('That person is not active any more.');
  if (!(await accessRepo.personMaySignInAtStore(tx, e.personId, storeId))) throw personRefused('That person may not sign in at this store.');
  if (Math.abs(e.occurredAt.getTime() - serverNow.getTime()) > POS_DEVICE_CLOCK_SKEW_MS) {
    throw personRefused("The tablet's clock is too far from the server's clock. Ask a manager to check the time on the tablet.");
  }
  const from = new Date(e.occurredAt.getTime() - POS_OFFLINE_SIGNIN_WINDOW_MS);
  const to = new Date(e.occurredAt.getTime() + POS_SIGNIN_CLOCK_SLACK_MS);
  if (!(await posV2Repo.hasPinSessionOnPairing(tx, orgId, e.personId, storeId, pairingId, from, to))) {
    throw personRefused('That person has not signed in with a PIN on this tablet in the last week.');
  }
  return { personId: e.personId, orgId };
}

async function runEvent(tx: Tx, pairing: PosPairing, e: Running, deps: PosDeps | undefined, serverNow: Date): Promise<void> {
  if (e.dateProblem) throw invalid(e.dateProblem);
  const actor = await checkPerson(tx, pairing, e, serverNow);
  const handler = HANDLERS.get(e.kind);
  if (!handler) throw new PosEventRefusal('POS_EVENT_UNKNOWN_KIND', `This server does not know the event kind "${e.kind}" yet.`);
  if (e.preProblem) throw invalid(e.preProblem);
  const problem = problemOf(handler.spec, e.payload);
  if (problem) throw invalid(problem);
  await handler.run(tx, actor, { storeId: pairing.storeId, pairingId: pairing.pairingId }, e.payload, deps);
}

// ---------------------------------------------------------------------------------------------------------------------
// R2/R5 - a batch
// ---------------------------------------------------------------------------------------------------------------------
async function classifyExisting(pairing: PosPairing, e: PosEventIn, stored: Record<string, unknown>): Promise<PosEventResult> {
  const row = await withOrgPrincipal(pairing.orgId, (tx) => posV2Repo.getPosEventByPairingSeq(tx, pairing.orgId, pairing.storeId, pairing.pairingId, e.seq));
  if (!row) return { seq: e.seq, status: 'retry' }; // the first copy rolled back while we looked: send it again
  if (row.kind === e.kind && (canonicalJson(row.payload) === canonicalJson(stored) || canonicalJson(row.payload) === canonicalJson(UNSTORABLE))) return { seq: e.seq, status: 'duplicate' };
  return { seq: e.seq, status: 'conflict', storedKind: row.kind };
}

async function applyOne(pairing: PosPairing, e: PosEventIn, deps: PosDeps | undefined): Promise<PosEventResult> {
  const { orgId, storeId, pairingId } = pairing;
  const occurredAt = new Date(e.occurredAtDevice);
  const received = new Date();
  const year = occurredAt.getUTCFullYear();
  const dateProblem = year >= 1 && year <= 9999 ? null : `the time ${JSON.stringify(e.occurredAtDevice.slice(0, 40))} is outside the years 1 to 9999`;
  const scrubbed = scrub(e.payload);
  const stored = scrubbed.value;
  const row = { orgId, storeId, pairingId, seq: e.seq, kind: e.kind, payload: stored, personId: e.personId, occurredAtDevice: dateProblem ? received : occurredAt };
  try {
    await withOrgPrincipal(orgId, async (tx) => {
      await posV2Repo.insertPosEvent(tx, { ...row, status: 'applied', error: null });
      await runEvent(tx, pairing, { kind: e.kind, personId: e.personId, payload: e.payload, occurredAt, preProblem: scrubbed.problem, dateProblem }, deps, deps?.now?.() ?? new Date());
    });
    return { seq: e.seq, status: 'applied' };
  } catch (err) {
    if (isUniqueViolation(err, 'pos_events_pairing_seq_unique')) return classifyExisting(pairing, e, stored);
    const fault = eventFault(err);
    if (!fault || isRetryableRefusal(fault.code)) {
      // A bug or a temporary failure: never the event's fault, never dropped. No payload in the log (it can carry a card number).
      const code = fault?.code ?? sqlstateOf(err) ?? (err instanceof Error ? err.name : 'unknown');
      logger.warn({ code, pairingId, seq: e.seq, kind: e.kind }, 'pos inbox: retry, the event stays on the tablet');
      return { seq: e.seq, status: 'retry' };
    }
    const error = `${fault.code}: ${fault.sentence}`;
    const writeQuarantine = (r: typeof row, text: string) =>
      withOrgPrincipal(orgId, async (tx) => {
        await posV2Repo.insertPosEvent(tx, { ...r, status: 'quarantined', error: text });
        // A wrong manager PIN counts even though the event rolled back: charge the miss HERE, in the transaction that commits (once: the first charge rolled back with the event).
        if (err instanceof AuthenticationError) {
          const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, orgId, storeId);
          if (terminalPersonId) await recordPosApprovalMiss(tx, { orgId, terminalPersonId });
        }
      });
    try {
      await writeQuarantine(row, error);
    } catch (err2) {
      if (isUniqueViolation(err2, 'pos_events_pairing_seq_unique')) return classifyExisting(pairing, e, stored);
      const state = sqlstateOf(err2);
      // The safety net: an event whose own data the database will not hold must never wedge the queue. Store it once more with no payload and the received time.
      if (state?.startsWith('22')) {
        const fallback = `${error} (stored without its payload: database error ${state})`;
        try {
          await writeQuarantine({ ...row, payload: UNSTORABLE, occurredAtDevice: received }, fallback);
          return { seq: e.seq, status: 'quarantined', error: fallback };
        } catch (err3) {
          if (isUniqueViolation(err3, 'pos_events_pairing_seq_unique')) return classifyExisting(pairing, e, stored);
          logger.warn({ code: sqlstateOf(err3) ?? 'unknown', pairingId, seq: e.seq, kind: e.kind }, 'pos inbox: retry, could not store even a bare quarantined event');
          return { seq: e.seq, status: 'retry' };
        }
      }
      logger.warn({ code: state ?? 'unknown', pairingId, seq: e.seq, kind: e.kind }, 'pos inbox: retry, could not store a quarantined event');
      return { seq: e.seq, status: 'retry' };
    }
    return { seq: e.seq, status: 'quarantined', error };
  }
}

/**
 * Runs the events in ascending seq, each in its own transaction. A `retry` stops the batch (later events get no result). The store's POS switch is
 * checked first: `off` (or no switch row) refuses the whole batch with POS_NOT_SWITCHED_ON and the device keeps its outbox.
 */
export async function applyPosEvents(input: { pairing: PosPairing; events: PosEventIn[] }, deps?: PosDeps): Promise<{ stateVersion: number; results: PosEventResult[] }> {
  const { pairing } = input;
  const store = await withOrgPrincipal(pairing.orgId, (tx) => posV2Repo.getPosStore(tx, pairing.orgId, pairing.storeId));
  if (!store || store.mode === 'off') throw refuse('pos: store switched off', POS_NOT_SWITCHED_ON);
  const results: PosEventResult[] = [];
  for (const e of [...input.events].sort((a, b) => a.seq - b.seq)) {
    const r = await applyOne(pairing, e, deps);
    results.push(r);
    if (r.status === 'retry') break;
  }
  const stateVersion = await withOrgPrincipal(pairing.orgId, (tx) => posV2Repo.getStateVersion(tx, pairing.orgId, pairing.storeId));
  return { stateVersion: stateVersion ?? 0, results };
}

// ---------------------------------------------------------------------------------------------------------------------
// R6 - quarantine review (the screen is T-526 / T-533)
// ---------------------------------------------------------------------------------------------------------------------
export async function listPosQuarantine(tx: Tx, actor: Actor, input: { storeId: string }) {
  await authorize(tx, actor, 'approve_pos_correction', { storeId: input.storeId });
  const rows = await posV2Repo.listQuarantinedEvents(tx, actor.orgId, input.storeId);
  const names = await posV2Repo.listPersonNames(tx, actor.orgId, rows.flatMap((r) => (r.personId ? [r.personId] : [])));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    kind: r.kind,
    personName: r.personId ? (names.get(r.personId) ?? null) : null,
    occurredAtDevice: r.occurredAtDevice,
    receivedAt: r.receivedAt,
    error: r.error,
    payload: r.payload,
  }));
}

/** The manager's row, locked, and still waiting. A row of another store reads as absent. */
async function openQuarantineRow(tx: Tx, actor: Actor, input: { storeId: string; eventId: string }) {
  const row = await posV2Repo.getPosEvent(tx, actor.orgId, input.storeId, input.eventId, { forUpdate: true });
  if (!row) throw gone('pos: event not found', 'event');
  if (row.resolvedAt !== null || row.status !== 'quarantined') throw refuse('pos: event already handled', ALREADY_HANDLED);
  return row;
}

async function auditResolution(tx: Tx, actor: Actor, row: { id: string; seq: number; kind: string }, storeId: string, resolution: 'replayed' | 'discarded', extra: Record<string, unknown>) {
  // Both actions are written by a manager in the ERP, not by the tablet: source 'web'.
  // the T-402 S1a scan reads every quoted token on an action: line, so the resolution word stays off it
  const isReplay = resolution === 'replayed';
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: isReplay ? 'pos.event_replayed' : 'pos.event_discarded',
    storeId,
    entityId: row.id,
    before: null,
    after: { seq: row.seq, kind: row.kind, ...extra },
    source: 'web',
  });
}

/**
 * Re-runs a quarantined event as its ORIGINAL person (R4 and the domain call again; the arrival time stands in for "now" in the clock check). Success resolves
 * the row `replayed`; a refusal leaves it open and returns the new sentence. A stored online void cannot be replayed: its PIN was never stored.
 */
export async function replayQuarantinedEvent(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; eventId: string },
  deps?: PosDeps,
): Promise<{ replayed: true } | { replayed: false; error: string }> {
  await authorize(tx, actor, 'approve_pos_correction', { storeId: input.storeId });
  const row = await openQuarantineRow(tx, actor, input);
  const payload = row.payload as Record<string, unknown>;
  if (row.kind === 'session.voided' && isObj(payload.approval) && payload.approval.pinGiven === true) return { replayed: false, error: REPLAY_VOID };
  if (row.error?.startsWith('POS_EVENT_INVALID:')) return { replayed: false, error: 'This event was not valid as sent. Discard it and re-enter the sale on the till.' };
  if (row.personId === null) return { replayed: false, error: 'The person on this event is not on the staff list, so it cannot be replayed. Discard it.' };
  const pairing = { pairingId: row.pairingId, orgId: actor.orgId, storeId: input.storeId };
  const run = (t: Tx) => runEvent(t, pairing, { kind: row.kind, personId: row.personId!, payload, occurredAt: row.occurredAtDevice }, deps, row.receivedAt);
  try {
    // A refusal must leave nothing behind, so the run is a savepoint - except a sale: migration 0240's append guard refuses a receipt child written in one.
    // (A sale throws only before its first write, or on a database error that aborts this transaction whole.)
    if (row.kind === 'sale.completed') await run(tx);
    else await tx.transaction(run);
  } catch (err) {
    // A sale is never half-replayed: its refusal propagates, so the manager's whole transaction aborts (the row stays unresolved) and the caller shows the sentence.
    const fault = eventFault(err);
    if (!fault || row.kind === 'sale.completed') throw err;
    return { replayed: false, error: fault.sentence };
  }
  await posV2Repo.resolvePosEvent(tx, actor.orgId, input.storeId, row.id, { resolvedBy: actor.personId, resolution: 'replayed' });
  await auditResolution(tx, actor, row, input.storeId, 'replayed', { originalPersonId: row.personId });
  return { replayed: true };
}

/** Gives up on a quarantined event, with a reason of 1 to 200 characters. The row is kept: nothing is ever deleted. */
export async function discardQuarantinedEvent(tx: Tx, actor: Actor, input: { storeId: string; eventId: string; reason: string }): Promise<{ discarded: true }> {
  await authorize(tx, actor, 'approve_pos_correction', { storeId: input.storeId });
  const row = await openQuarantineRow(tx, actor, input);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > 200) throw refuse('pos: discard reason length', 'Give a reason of 1 to 200 characters.');
  await posV2Repo.resolvePosEvent(tx, actor.orgId, input.storeId, row.id, { resolvedBy: actor.personId, resolution: 'discarded' });
  await auditResolution(tx, actor, row, input.storeId, 'discarded', { reason });
  return { discarded: true };
}

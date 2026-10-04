/**
 * Is the lane actually working, and what is stuck? T-183.
 * `docs/tasks/183-quarantine-and-lane-health.md`, bible §5.4 rule 5.
 *
 * ## The failure this module exists to end
 *
 * Landmine #14 is the only landmine in bible §12 whose structural fix is **a screen**. v1's entire
 * recovery path is `OfflineBanner.tsx:33` telling staff *"N failed — tell a manager"*, and discovery
 * 05 §6 confirms there is nothing for the manager to then open:
 *
 * > *"**no admin/manager UI was found anywhere in the app that reads dead-lettered punches** out of
 * > a device's IndexedDB, inspects them, or lets a manager manually re-file the underlying
 * > attendance session. Recovery today appears to be entirely informal."*
 *
 * ⭐ **A quarantine nobody can read is a dead letter with better manners.**
 *
 * ## Two questions, in this order
 *
 * The health answer comes **above** the stuck list, because a manager who only ever sees a list of
 * failures cannot tell a bad hour from a broken week. Three empty rows on a Tuesday is noise; three
 * empty rows while the outbox has not moved since breakfast is an outage.
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { humanDate } from '../shared/refusal';
import { authorize, type Actor } from '@shareat/auth';
import {
  clockTerminalsRepo,
  inboxQuarantineRepo,
  mirrorOutboxRepo,
  type ClockTerminalRow,
  type InboxQuarantineRow,
  type ReasonCount,
  type Tx,
} from '@shareat/db';
import type { QuarantineReason } from '@shareat/db/schema';
import { ingestEvents, type IngestReport } from './ingestor';

export class LaneHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneHealthError';
  }
}

/**
 * ⚠️ **First cuts, and they are exported constants so they can be argued with rather than found.**
 *
 * `26` is deliberate and is the only one of the three with a story: 24 would fire every time a store
 * closed an hour early, which would train a manager to ignore the panel within a week.
 */
export const LANE_HEALTH = {
  outboxLagWarnMinutes: 15,
  inboxUnprocessedWarnMinutes: 15,
  terminalSilentWarnHours: 26,
} as const;

/** How far back `healedRecently` looks. A week is long enough to cover a quiet weekend. */
const HEAL_WINDOW_DAYS = 7;

export type LaneStatus = 'ok' | 'warn' | 'unknown';

export interface OutboxHealth {
  status: LaneStatus;
  pending: number;
  oldestEnqueuedAt: Date | null;
  lagMinutes: number | null;
  worstAttempts: number;
  lastError: string | null;
}

export interface InboxHealth {
  /** ⚠️ `unknown` whenever the relay has not reported — see `laneHealth`'s `inbox` parameter. */
  status: LaneStatus;
  oldestUnprocessedAt: Date | null;
  lagMinutes: number | null;
  reportedAt: Date | null;
}

export interface TerminalHealth {
  id: string;
  label: string;
  status: 'ok' | 'silent' | 'never_paired' | 'no_punches_yet';
  lastSeenAt: Date | null;
  silentHours: number | null;
}

export interface LaneHealthReport {
  storeId: string;
  observedAt: Date;
  outbox: OutboxHealth;
  inbox: InboxHealth;
  terminals: TerminalHealth[];
  /** Open quarantine rows for this store, grouped by reason. */
  quarantineByReason: ReasonCount[];
  quarantineOpen: number;
  quarantineOldestAt: Date | null;
  /** Org-wide open rows that name no store at all. See `listQuarantine`. */
  unattributedOpen: number;
  /** ⭐ Stuck events that came back on their own in the last week. */
  healedRecently: number;
  /** True when anything above is `warn`. The one boolean a banner needs. */
  needsAttention: boolean;
}

/**
 * What the relay knows and Postgres cannot.
 *
 * ⚠️ **The inbox lives in Firestore.** Postgres has no way to see a document the relay has not
 * reached yet, so this figure is *supplied* rather than computed — and when nothing supplies it the
 * panel says `unknown` instead of `ok`. ⛔ An unmeasured lane must never render as a healthy one;
 * that is precisely how v1's dead letter stayed invisible for two years.
 */
export interface InboxLagReport {
  oldestUnprocessedAt: Date | null;
  reportedAt: Date;
}

export async function laneHealth(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; inbox?: InboxLagReport | null; now?: Date },
): Promise<LaneHealthReport> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });
  const now = input.now ?? new Date();

  const [lag, terminals, byReason, oldestOpen, unattributed, healed] = await Promise.all([
    mirrorOutboxRepo.outboxLag(tx, input.storeId),
    clockTerminalsRepo.listForStore(tx, input.storeId),
    inboxQuarantineRepo.countOpenByReason(tx, input.storeId),
    inboxQuarantineRepo.oldestOpenAt(tx, input.storeId),
    inboxQuarantineRepo.countOpenByReason(tx, null),
    inboxQuarantineRepo.countHealedSince(
      tx,
      input.storeId,
      new Date(now.getTime() - HEAL_WINDOW_DAYS * 86_400_000),
    ),
  ]);

  const outboxLagMinutes = minutesSince(lag.oldestEnqueuedAt, now);
  const outbox: OutboxHealth = {
    status:
      outboxLagMinutes !== null && outboxLagMinutes > LANE_HEALTH.outboxLagWarnMinutes
        ? 'warn'
        : 'ok',
    pending: lag.pending,
    oldestEnqueuedAt: lag.oldestEnqueuedAt,
    lagMinutes: outboxLagMinutes,
    worstAttempts: lag.worstAttempts,
    lastError: lag.lastError,
  };

  const inbox = readInbox(input.inbox ?? null, now);
  const terminalHealth = terminals.map((t) => terminalStatus(t, now));

  const quarantineOpen = byReason.reduce((sum, r) => sum + r.count, 0);
  const needsAttention =
    outbox.status === 'warn' ||
    inbox.status === 'warn' ||
    terminalHealth.some((t) => t.status === 'silent') ||
    quarantineOpen > 0;

  return {
    storeId: input.storeId,
    observedAt: now,
    outbox,
    inbox,
    terminals: terminalHealth,
    quarantineByReason: byReason,
    quarantineOpen,
    quarantineOldestAt: oldestOpen,
    unattributedOpen: unattributed.reduce((sum, r) => sum + r.count, 0),
    healedRecently: healed,
    needsAttention,
  };
}

function readInbox(report: InboxLagReport | null, now: Date): InboxHealth {
  if (!report) {
    // ⭐ Not "ok". Nothing has measured this, and saying so is the honest answer.
    return { status: 'unknown', oldestUnprocessedAt: null, lagMinutes: null, reportedAt: null };
  }
  const lagMinutes = minutesSince(report.oldestUnprocessedAt, now);
  return {
    status:
      lagMinutes !== null && lagMinutes > LANE_HEALTH.inboxUnprocessedWarnMinutes ? 'warn' : 'ok',
    oldestUnprocessedAt: report.oldestUnprocessedAt,
    lagMinutes,
    reportedAt: report.reportedAt,
  };
}

/**
 * ⚠️ Three ways of being quiet, and only one of them is a fault.
 *
 * A terminal that was never paired is a provisioning job somebody has not finished. A terminal
 * paired this morning that nobody has clocked in on yet is a normal Tuesday. Only a terminal that
 * *used* to report and has now stopped is an outage — and the 26-hour bar means a store that shut
 * an hour early does not trip it.
 */
function terminalStatus(terminal: ClockTerminalRow, now: Date): TerminalHealth {
  const base = { id: terminal.id, label: terminal.label, lastSeenAt: terminal.lastSeenAt };
  if (!terminal.activatedAt) {
    return { ...base, status: 'never_paired', silentHours: null };
  }
  if (!terminal.lastSeenAt) {
    return { ...base, status: 'no_punches_yet', silentHours: null };
  }
  const hours = (now.getTime() - terminal.lastSeenAt.getTime()) / 3_600_000;
  return {
    ...base,
    status: hours > LANE_HEALTH.terminalSilentWarnHours ? 'silent' : 'ok',
    silentHours: Math.floor(hours),
  };
}

function minutesSince(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
}

// ─── What is stuck ────────────────────────────────────────────────────────────────────────

export interface QuarantineView extends InboxQuarantineRow {
  /** The reason as a sentence a manager can act on. A code is for the database. */
  sentence: string;
  /** ⛔ False where a retry is provably pointless — see `REASON_COPY`. */
  retryable: boolean;
}

export interface QuarantineList {
  open: QuarantineView[];
  /**
   * Org-wide rows that name no store. ⚠️ Empty for an actor without `provision_clock_terminal` —
   * absence here means "not yours to see", not "none exist".
   */
  unattributed: QuarantineView[];
  /** The audit tail: what was resolved, and how. */
  resolved: QuarantineView[];
}

const RESOLVED_TAIL = 25;

/**
 * ⚠️ `retryable: false` is claimed for exactly one reason, and only because the fact is fixed.
 *
 * A `malformed` body will fail the same shape check forever — nothing about the world can change to
 * make it readable. Every other reason CAN come good: a `future_timestamp` heals as real time
 * catches up to the device's wrong clock, and the rest heal when somebody fixes the thing named in
 * the sentence.
 */
const REASON_COPY: Record<QuarantineReason, { sentence: string; retryable: boolean }> = {
  unknown_credential: {
    sentence:
      'No open employment at this store matches this staffer. Enrol them (or check they have not ' +
      'left), then Retry.',
    retryable: true,
  },
  unknown_device: {
    sentence:
      'No clock terminal with this id was ever provisioned here. Provision the device, or discard ' +
      'the event.',
    retryable: true,
  },
  revoked_device: {
    sentence: 'This terminal was revoked. Provision a replacement and Retry, or discard the event.',
    retryable: true,
  },
  method_disabled: {
    sentence:
      'That way of clocking in was switched off for this store on the day of the punch. Turn it ' +
      'back on and Retry, or discard.',
    retryable: true,
  },
  store_mismatch: {
    sentence:
      'This terminal belongs to a different store than the event claims. The punch was probably ' +
      'taken on the wrong device.',
    retryable: true,
  },
  future_timestamp: {
    sentence:
      "This device's clock is ahead of the server. Fix the clock on the terminal, then Retry.",
    retryable: true,
  },
  malformed: {
    sentence:
      'This device sent something we could not read. ⛔ Retrying cannot help — the body will not ' +
      'change. Show the raw event, then discard.',
    retryable: false,
  },
  internal_error: {
    sentence:
      'Something failed on our side while reading this event. Retry; if it sticks, show the raw ' +
      'event.',
    retryable: true,
  },
};

/** The reason as a sentence, with the ingestor's own specifics appended when it wrote any. */
export function quarantineSentence(row: InboxQuarantineRow): string {
  const copy = REASON_COPY[row.reasonCode];
  const base = copy?.sentence ?? `Quarantined as ${row.reasonCode}.`;
  return row.reasonDetail ? `${base} (${row.reasonDetail})` : base;
}

function view(row: InboxQuarantineRow): QuarantineView {
  return {
    ...row,
    sentence: quarantineSentence(row),
    retryable: REASON_COPY[row.reasonCode]?.retryable ?? true,
  };
}

/**
 * Everything stuck at one store, plus the org-wide rows nobody could file.
 *
 * ⚠️ The unattributed list is gated on `provision_clock_terminal` rather than `manage_attendance`,
 * and it fails **soft**: a manager without that capability sees an empty list rather than an error,
 * because the rest of the screen is theirs to use.
 */
export async function listQuarantine(
  tx: Tx,
  actor: Actor,
  input: { storeId: string },
): Promise<QuarantineList> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });

  const [open, resolved] = await Promise.all([
    inboxQuarantineRepo.listOpenForStore(tx, input.storeId),
    inboxQuarantineRepo.listResolvedForStore(tx, input.storeId, RESOLVED_TAIL),
  ]);

  let unattributed: InboxQuarantineRow[] = [];
  if (await mayProvision(tx, actor, input.storeId)) {
    unattributed = await inboxQuarantineRepo.listOpenUnattributed(tx);
  }

  return {
    open: open.map(view),
    unattributed: unattributed.map(view),
    resolved: resolved.map(view),
  };
}

async function mayProvision(tx: Tx, actor: Actor, storeId: string): Promise<boolean> {
  try {
    await authorize(tx, actor, 'provision_clock_terminal', { storeId });
    return true;
  } catch {
    return false;
  }
}

// ─── The two operator actions ─────────────────────────────────────────────────────────────

export interface RetryResult {
  /** ⭐ True when the event went through and is now a punch. */
  ingested: boolean;
  punchId: string | null;
  /** When it is still stuck, why it is stuck NOW — which may differ from why it was. */
  stillStuckBecause: QuarantineReason | null;
  report: IngestReport;
}

/**
 * ⭐ **Retry re-runs the real ingest path** — `ingestEvents` on the stored raw body, not a
 * reimplementation of the checks.
 *
 * That matters more than it looks. A second code path that decides whether an event is acceptable
 * is a second place for the rules to drift, and the rule that drifts here is the one that decides
 * whether somebody gets paid. It also means a retry that succeeds heals the row through exactly the
 * same code an ordinary re-delivery would, with `resolved_by` left null because nobody decided it —
 * pressing Retry only asks the question again; it does not answer it.
 */
export async function retryQuarantined(
  tx: Tx,
  actor: Actor,
  input: { quarantineId: string; storeId: string },
): Promise<RetryResult> {
  const row = await requireOpen(tx, input.quarantineId);
  await gate(tx, actor, row, input.storeId, 'manage_attendance');

  const report = await ingestEvents(tx, [row.rawEvent]);
  const punchId = Object.values(report.processed)[0] ?? null;
  const stillStuck = (Object.keys(report.byReason) as QuarantineReason[])[0] ?? null;

  return {
    ingested: report.ingested > 0,
    punchId,
    stillStuckBecause: report.ingested > 0 ? null : stillStuck,
    report,
  };
}

/**
 * ⛔ The one action here that can lose a real shift.
 *
 * It needs a reason, it names who pressed it, and **it never deletes the row** — the
 * `inbox_quarantine_discard_attribution_check` constraint refuses either half on its own, so this
 * cannot become an unattributed disappearance even by mistake.
 *
 * ⚠️ It is gated on `provision_clock_terminal`, not `manage_attendance`. Naming the harder
 * capability rather than defaulting to the same one as everything else: discarding sits with
 * whoever is trusted with the terminals, because it is the only button on this screen that destroys
 * information a person cannot get back.
 */
export async function discardQuarantined(
  tx: Tx,
  actor: Actor,
  input: { quarantineId: string; storeId: string; reason: string },
): Promise<InboxQuarantineRow> {
  const row = await requireOpen(tx, input.quarantineId);
  await gate(tx, actor, row, input.storeId, 'provision_clock_terminal');

  const reason = input.reason.trim();
  if (!reason) {
    throw new LaneHealthError(
      'Discarding an event needs a reason — a lost shift nobody can explain is not an audit trail.',
    );
  }

  const discarded = await inboxQuarantineRepo.markDiscarded(tx, {
    id: row.id,
    by: actor.personId,
    reason,
  });
  if (!discarded) {
    // Somebody else resolved it between the read and the write. Their reason stands.
    throw new LaneHealthError('That event was already resolved by somebody else.');
  }
  return discarded;
}

async function requireOpen(tx: Tx, id: string): Promise<InboxQuarantineRow> {
  const row = await inboxQuarantineRepo.getQuarantine(tx, id);
  if (!row) throw new LaneHealthError(`No quarantined event ${id}.`);
  if (row.resolvedAt) {
    throw new LaneHealthError(
      `That event was already resolved (${row.resolution}) on ` +
        `${humanDate(toBusinessDate(row.resolvedAt))}. A resolved row is history, not a queue item.`,
    );
  }
  return row;
}

/**
 * ⚠️ A row with a store is authorized against **that** store, never the one the screen happens to
 * be showing — otherwise a manager scoped to Lipa could act on a Malvar event by changing a query
 * string. A row with no store is a provisioning problem, so it takes the provisioning capability at
 * the store being viewed.
 */
async function gate(
  tx: Tx,
  actor: Actor,
  row: InboxQuarantineRow,
  viewStoreId: string,
  capability: 'manage_attendance' | 'provision_clock_terminal',
): Promise<void> {
  if (row.storeId) {
    await authorize(tx, actor, capability, { storeId: row.storeId });
    return;
  }
  await authorize(tx, actor, 'provision_clock_terminal', { storeId: viewStoreId });
}

/**
 * T-529 R3 - the outage print for orders that were saved while the poll still thought we were online. The tablet takes about 6 s (two missed polls) to
 * say Offline, and an order sent in that window must still reach the kitchen on paper. So when the shell is offline it prints EVERY pending outbox
 * `stand.opened`, `lines.added` and `refill.requested` that has not been printed yet. `app.outagePrinted` (T-530a meta) holds the seqs already printed,
 * holds the seqs already printed. T-561: a seq is marked only AFTER `printOutageForEvent` returned; while it prints it sits in `app.outageInflight`. A print that
 * throws is cleared and retried next replay. A seq still in flight at the start of a replay was cut off by a crash: its paper may or may not be out, so it is
 * never printed again by itself, it goes to the Reprint list for staff to choose. Both sets are pruned when the outbox drops an event. Plain logic: the device
 * store, the printer and the menu are injected (see `printOutageForEvent`).
 */
import { PRINT_FAILED_NOTE, printOutageForEvent, type OutageDeps, type OutageResult, type PrintJob } from './outage-print';

export const OUTAGE_PRINTED_KEY = 'app.outagePrinted';
export const OUTAGE_REPRINT_KEY = 'app.outageReprint';
export const OUTAGE_INFLIGHT_KEY = 'app.outageInflight';
export const PRINT_RETRY_NOTE = 'A kitchen ticket did not print. It will retry; tell the kitchen.';
const PRINTABLE = new Set(['stand.opened', 'lines.added', 'refill.requested']);

export interface OutageEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}
type Meta = Pick<OutageDeps, 'getMeta' | 'setMeta'>;

// The printed and in-flight sets are read, changed and written back: calls that overlap (the direct path and the shell's replay) queue here so none loses an update.
let ledgerQueue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = ledgerQueue.then(fn);
  ledgerQueue = run.catch(() => undefined);
  return run;
}
const readSet = async (m: Meta, key: string): Promise<Set<number>> => new Set((await m.getMeta<number[]>(key)) ?? []);
const writeSet = (m: Meta, key: string, s: Set<number>) => m.setMeta(key, [...s].sort((a, b) => a - b));
// The seqs THIS page is printing right now: they sit in the in-flight key too, but are not crash leftovers. shortcut: per page load, not per tab; two tabs
// of one till would see each other's in-flight seq as a leftover (it then goes to Reprint, never prints twice), upgrade if a till ever runs two tabs.
const active = new Set<number>();
const CAPTURE = async (): Promise<'failed'> => 'failed'; // a printer that prints nothing: the jobs come back as `failed`, ready for the Reprint list

/** Prints what is pending and not yet printed. Online: prints nothing and marks nothing (the event waits for an offline switch). */
export async function printUnprinted(deps: OutageDeps, pending: readonly OutageEvent[]): Promise<OutageResult> {
  const total: OutageResult = { printed: 0, failed: [], message: null };
  if (deps.online) return total;
  const todo = pending.filter((e) => PRINTABLE.has(e.kind)).sort((a, b) => a.seq - b.seq);
  if (todo.length === 0) return total;
  // A table opened by a pending event is not in the polled list yet: its label comes from the event itself.
  const tableLabels = { ...deps.tableLabels };
  for (const e of todo) {
    const p = e.payload as { sessionId?: unknown; mode?: unknown; standId?: unknown };
    if (e.kind === 'stand.opened' && typeof p.sessionId === 'string') {
      const n = p.mode === 'take_out' ? undefined : deps.stands.find((s) => s.id === p.standId)?.number;
      tableLabels[p.sessionId] = n === undefined ? null : String(n);
    }
  }
  const full = { ...deps, tableLabels };
  const mine = await locked(async () => {
    const printed = await readSet(deps, OUTAGE_PRINTED_KEY);
    const inflight = await readSet(deps, OUTAGE_INFLIGHT_KEY);
    // Leftovers of a crash: never printed again by itself. The paper it would print is captured (not sent) and offered on the Reprint list; then it counts as printed.
    for (const e of todo.filter((x) => inflight.has(x.seq) && !active.has(x.seq))) {
      if (!printed.has(e.seq)) {
        try {
          total.failed.push(...(await printOutageForEvent({ ...full, printLines: CAPTURE }, e)).failed);
        } catch {
          continue; // could not build the paper: stays in flight and is offered again next replay
        }
        printed.add(e.seq);
        await writeSet(deps, OUTAGE_PRINTED_KEY, printed);
      }
      inflight.delete(e.seq);
      await writeSet(deps, OUTAGE_INFLIGHT_KEY, inflight);
    }
    const fresh = todo.filter((e) => !printed.has(e.seq) && !inflight.has(e.seq));
    if (fresh.length > 0) {
      for (const e of fresh) {
        inflight.add(e.seq);
        active.add(e.seq);
      }
      await writeSet(deps, OUTAGE_INFLIGHT_KEY, inflight);
    }
    return fresh;
  });
  let threw = false;
  for (const e of mine) {
    let done = false;
    try {
      const r = await printOutageForEvent(full, e);
      total.printed += r.printed;
      total.failed.push(...r.failed);
      done = true;
    } catch {
      threw = true; // no PrintJob exists: leave it unmarked so the next replay retries it
    }
    try {
      await locked(async () => {
        if (done) {
          const printed = await readSet(deps, OUTAGE_PRINTED_KEY);
          printed.add(e.seq);
          await writeSet(deps, OUTAGE_PRINTED_KEY, printed);
        }
        const inflight = await readSet(deps, OUTAGE_INFLIGHT_KEY);
        inflight.delete(e.seq);
        await writeSet(deps, OUTAGE_INFLIGHT_KEY, inflight);
      });
    } finally {
      active.delete(e.seq);
    }
  }
  return { ...total, message: threw ? PRINT_RETRY_NOTE : total.failed.length > 0 ? PRINT_FAILED_NOTE : null };
}

/** The outbox dropped these events (sent): forget them. */
export function pruneOutagePrinted(m: Meta, removed: readonly number[]): Promise<void> {
  if (removed.length === 0) return Promise.resolve();
  return pruneBoth(m, (s) => !removed.includes(s));
}

/** After a reload: keep only the seqs that are still in the outbox. Run once, when the outbox has been read for the first time. */
export function pruneOutagePrintedToPending(m: Meta, pendingSeqs: readonly number[]): Promise<void> {
  const live = new Set(pendingSeqs);
  return pruneBoth(m, (s) => live.has(s));
}

/** Both sets lose the seqs `keep` rejects; a set that did not change is not written. */
function pruneBoth(m: Meta, keep: (seq: number) => boolean): Promise<void> {
  return locked(async () => {
    for (const key of [OUTAGE_PRINTED_KEY, OUTAGE_INFLIGHT_KEY]) {
      const had = await readSet(m, key);
      const kept = new Set([...had].filter(keep));
      if (kept.size !== had.size) await writeSet(m, key, kept);
    }
  });
}

/** Tickets that did not print wait for Reprint, and survive a reload: the order is saved, and so is the paper that was lost. */
export async function readReprintJobs(m: Meta): Promise<PrintJob[]> {
  const saved = await m.getMeta<PrintJob[]>(OUTAGE_REPRINT_KEY);
  return Array.isArray(saved) ? saved.filter((j) => Array.isArray(j?.lines) && typeof j.copies === 'number') : [];
}
export function writeReprintJobs(m: Meta, jobs: readonly PrintJob[]): Promise<void> {
  return locked(() => m.setMeta(OUTAGE_REPRINT_KEY, [...jobs]));
}

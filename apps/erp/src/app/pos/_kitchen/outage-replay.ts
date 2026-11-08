/**
 * T-529 R3 - the outage print for orders that were saved while the poll still thought we were online. The tablet takes about 6 s (two missed polls) to
 * say Offline, and an order sent in that window must still reach the kitchen on paper. So when the shell is offline it prints EVERY pending outbox
 * `stand.opened`, `lines.added` and `refill.requested` that has not been printed yet. `app.outagePrinted` (T-530a meta) holds the seqs already printed,
 * written BEFORE the paper goes out, so an event never prints twice, not across a second offline switch and not across a reload. Pruned when the outbox
 * drops an event. Plain logic: the device store, the printer and the menu are injected (see `printOutageForEvent`).
 */
import { PRINT_FAILED_NOTE, printOutageForEvent, type OutageDeps, type OutageResult, type PrintJob } from './outage-print';

export const OUTAGE_PRINTED_KEY = 'app.outagePrinted';
export const OUTAGE_REPRINT_KEY = 'app.outageReprint';
const PRINTABLE = new Set(['stand.opened', 'lines.added', 'refill.requested']);

export interface OutageEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}
type Meta = Pick<OutageDeps, 'getMeta' | 'setMeta'>;

// The printed-set is read, changed and written back: calls that overlap (the direct path and the shell's replay) queue here so none loses an update.
let ledgerQueue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = ledgerQueue.then(fn);
  ledgerQueue = run.catch(() => undefined);
  return run;
}
const readSet = async (m: Meta): Promise<Set<number>> => new Set((await m.getMeta<number[]>(OUTAGE_PRINTED_KEY)) ?? []);
const writeSet = (m: Meta, s: Set<number>) => m.setMeta(OUTAGE_PRINTED_KEY, [...s].sort((a, b) => a - b));

/** Prints what is pending and not yet printed. Online: prints nothing and marks nothing (the event waits for an offline switch). */
export async function printUnprinted(deps: OutageDeps, pending: readonly OutageEvent[]): Promise<OutageResult> {
  const total: OutageResult = { printed: 0, failed: [], message: null };
  if (deps.online) return total;
  const todo = pending.filter((e) => PRINTABLE.has(e.kind)).sort((a, b) => a.seq - b.seq);
  if (todo.length === 0) return total;
  const mine = await locked(async () => {
    const printed = await readSet(deps);
    const fresh = todo.filter((e) => !printed.has(e.seq));
    if (fresh.length > 0) {
      for (const e of fresh) printed.add(e.seq);
      await writeSet(deps, printed);
    }
    return fresh;
  });
  // A table opened by a pending event is not in the polled list yet: its label comes from the event itself.
  const tableLabels = { ...deps.tableLabels };
  for (const e of todo) {
    const p = e.payload as { sessionId?: unknown; mode?: unknown; standId?: unknown };
    if (e.kind === 'stand.opened' && typeof p.sessionId === 'string') {
      const n = p.mode === 'take_out' ? undefined : deps.stands.find((s) => s.id === p.standId)?.number;
      tableLabels[p.sessionId] = n === undefined ? null : String(n);
    }
  }
  for (const e of mine) {
    const r = await printOutageForEvent({ ...deps, tableLabels }, e);
    total.printed += r.printed;
    total.failed.push(...r.failed);
  }
  return { ...total, message: total.failed.length > 0 ? PRINT_FAILED_NOTE : null };
}

/** The outbox dropped these events (sent): forget them. */
export function pruneOutagePrinted(m: Meta, removed: readonly number[]): Promise<void> {
  if (removed.length === 0) return Promise.resolve();
  return locked(async () => {
    const printed = await readSet(m);
    const had = printed.size;
    for (const seq of removed) printed.delete(seq);
    if (printed.size !== had) await writeSet(m, printed);
  });
}

/** After a reload: keep only the seqs that are still in the outbox. Run once, when the outbox has been read for the first time. */
export function pruneOutagePrintedToPending(m: Meta, pendingSeqs: readonly number[]): Promise<void> {
  return locked(async () => {
    const live = new Set(pendingSeqs);
    const printed = await readSet(m);
    const kept = new Set([...printed].filter((s) => live.has(s)));
    if (kept.size !== printed.size) await writeSet(m, kept);
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

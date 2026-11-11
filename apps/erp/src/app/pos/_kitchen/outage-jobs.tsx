'use client';

/**
 * T-529 R3 - the outage tickets that did not print. They live at module level (not in one tab's state) so a cashier who moves from Orders to Refills still
 * sees "Kitchen ticket did not print. Tap Reprint." until it is printed. The order itself is already saved; this is only the paper. The waiting jobs are
 * also kept in the device store (`app.outageReprint`), so a reload does not lose the paper that never came out.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Banner } from '@/components/ui';
import { getMeta, setMeta } from '@/lib/pos-device';
import { printLines } from '@/lib/pos-print/adapter';
import { PRINT_FAILED_NOTE, reprintOutage, type OutageResult, type PrintJob } from './outage-print';
import { PRINT_RETRY_NOTE, readReprintJobs, writeReprintJobs } from './outage-replay';

const EMPTY: PrintJob[] = [];
let jobs: PrintJob[] = EMPTY;
const listeners = new Set<() => void>();
const meta = { getMeta, setMeta };
const set = (next: PrintJob[], persist = true) => {
  jobs = next.length === 0 ? EMPTY : next;
  for (const l of listeners) l();
  if (persist) void writeReprintJobs(meta, jobs).catch(() => undefined);
};
let restored = false;
const same = (a: PrintJob, b: PrintJob) => JSON.stringify(a) === JSON.stringify(b);
/** Once per page load: the jobs a previous session left in the device store join the list (a job already here is not added twice). */
async function restore(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = (await readReprintJobs(meta).catch(() => [])).filter((s) => !jobs.some((j) => same(j, s)));
  if (saved.length > 0) set([...saved, ...jobs], false);
}
export const addFailedPrintJobs = (more: PrintJob[]) => set([...jobs, ...more]);
// T-561: a message with no paper behind it (a ticket that threw before a job existed). The next replay that finishes clean clears it.
let notice: string | null = null;
export const outageNotice = () => notice;
export function showOutageNotice(text: string | null): void {
  if (notice === text) return;
  notice = text;
  for (const l of listeners) l();
}
/** What a replay or a direct print came back with: failed paper goes to the Reprint list, any other message to the notice. */
export function reportOutage(r: OutageResult): void {
  if (r.failed.length > 0) addFailedPrintJobs(r.failed);
  showOutageNotice(r.message === PRINT_FAILED_NOTE ? null : r.message);
}
/** The replay or print itself blew up (the device store failed): say so, the order is saved and the paper is retried. */
export const reportOutageError = () => showOutageNotice(PRINT_RETRY_NOTE);
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The failed-ticket notice with its Reprint action. Draws nothing while every ticket printed. */
export function OutageBanner() {
  const waiting = useSyncExternalStore(subscribe, () => jobs, () => EMPTY);
  const note = useSyncExternalStore(subscribe, outageNotice, () => null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void restore(), []);
  if (waiting.length === 0 && note === null) return null;
  const reprint = async () => {
    setBusy(true);
    try {
      const result = await reprintOutage({ printLines }, waiting);
      set(result.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner tone="warning">
      {note ?? PRINT_FAILED_NOTE}{' '}
      {waiting.length > 0 && (
        <button type="button" data-erp-size="free" disabled={busy} onClick={() => void reprint()} className="min-h-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-5 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50">
          Reprint
        </button>
      )}
    </Banner>
  );
}

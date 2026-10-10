import { formatBusinessDateTime } from '@shareat/core/datetime';
import { reopenPinSignInAction } from './actions';

export interface PinSignInPanelStatus {
  stopped: boolean;
  stoppedAt: Date | null;
  paused: boolean;
  pausedUntil: Date | null;
  missesLast24h: number;
  missesBeforeStop: number;
}

const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';

/**
 * T-395 S2 - the PIN sign-in panel on /staff. Shown only to someone who holds `enrol_staff` at the
 * store (the page decides). Three states: normal, paused (tier 1, clears itself), stopped (tier 2,
 * only a manager's reopen clears it).
 */
export function PinSignInPanel({ storeId, status }: { storeId: string; status: PinSignInPanelStatus }) {
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="font-medium">PIN sign-in</h2>
      {status.stopped ? (
        <>
          <p className="text-sm text-red-800 dark:text-red-300">
            Stopped since {status.stoppedAt ? formatBusinessDateTime(status.stoppedAt) : 'earlier'} after {status.missesBeforeStop} wrong PINs in a day. Nobody can sign in
            by PIN at this store until a manager reopens it. Email sign-in still works.
          </p>
          <form action={reopenPinSignInAction}>
            <input type="hidden" name="storeId" value={storeId} />
            <button type="submit" className={BTN}>
              Reopen PIN sign-in
            </button>
          </form>
        </>
      ) : status.paused ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Paused until {status.pausedUntil ? formatBusinessDateTime(status.pausedUntil) : 'shortly'} after several wrong
          PINs in a row. It resumes by itself.
        </p>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Normal.</p>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Wrong PINs in the last 24 hours: {status.missesLast24h}
      </p>
    </section>
  );
}

import type { LobbyMyEntry } from '@/data/http-lobby-data';
import type { LobbyData } from '@/data/lobby-data';
import { createLobbyPoll, type PollDoc } from './lobby-poll';
import { waitView, type WaitView } from './lobby-view';

/**
 * T-455 S4 - runs the wait screen without a browser: reads the place in line now, then every 10 s while visible; a failed read keeps the last view;
 * a terminal entry stops the poll; and a seated entry hands the phone to the server's link EXACTLY once (location.replace, so Back does not return here).
 */
interface WaitControllerOptions {
  data: LobbyData;
  storeCode: string;
  doc: PollDoc;
  loc: { replace(url: string): void };
  onView(view: WaitView): void;
  /** The server has no place in line for this phone (404/401) and nothing has been shown yet. */
  onMissing?(message: string): void;
  /** A cancel the server refused. The place in line is unchanged. */
  onCancelError?(message: string): void;
}

export function createWaitController(o: WaitControllerOptions): { start(): void; stop(): void; cancel(): Promise<void> } {
  let stopped = false;
  let handedOff = false;
  let last: LobbyMyEntry | null = null;
  const poll = createLobbyPoll({ poll: () => refresh(), doc: o.doc });

  const finish = () => {
    stopped = true;
    poll.stop();
  };

  async function refresh(): Promise<void> {
    if (stopped) return;
    const r = await o.data.myEntry(o.storeCode);
    if (stopped) return;
    if (!r.ok) {
      if (last === null && (r.status === 404 || r.status === 401)) {
        finish();
        o.onMissing?.(r.error);
      }
      return; // any other failure: keep the last view and try again next tick
    }
    last = r.value;
    const view = waitView(r.value);
    o.onView(view);
    if (view.kind === 'closed') {
      finish();
    } else if (view.kind === 'handoff') {
      finish();
      if (view.handoffUrl && !handedOff) {
        handedOff = true;
        o.loc.replace(view.handoffUrl);
      }
    }
  }

  return {
    start() {
      stopped = false;
      poll.start();
      void refresh();
    },
    stop() {
      finish();
    },
    async cancel() {
      if (stopped) return;
      finish();
      const r = await o.data.cancel(o.storeCode);
      if (!r.ok) {
        o.onCancelError?.(r.error);
        stopped = false;
        poll.start();
        return;
      }
      o.onView(waitView({ ...(last ?? { entryId: r.value.entryId, code: '', partiesAhead: 0, displayName: null, partySize: 0, standLabel: null }), status: 'cancelled', handoffUrl: null }));
    },
  };
}

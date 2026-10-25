/** T-455 S4 - the live-position poll: every 10 s, only while the page is visible (3.1 "Live position"). The browser document is injected. */
export const LOBBY_POLL_MS = 10_000;

export interface PollDoc {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function createLobbyPoll({ poll, doc }: { poll: () => unknown; doc: PollDoc }): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const clear = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const arm = () => {
    if (timer !== null) return; // one timer only
    timer = setInterval(() => {
      void Promise.resolve()
        .then(poll)
        .catch(() => undefined);
    }, LOBBY_POLL_MS);
  };
  const onVisibility = () => {
    if (!running) return;
    if (doc.visibilityState === 'visible') arm();
    else clear();
  };

  return {
    start() {
      if (running) return;
      running = true;
      doc.addEventListener('visibilitychange', onVisibility);
      if (doc.visibilityState === 'visible') arm();
    },
    stop() {
      running = false;
      doc.removeEventListener('visibilitychange', onVisibility);
      clear();
    },
  };
}

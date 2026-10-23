"use client";

/**
 * T-425 S3 - reachability (Ruling 4; DEF-017). ONE shared store tells every screen whether the POS server is really reachable.
 * `navigator.onLine` says "a network exists", not "the internet works": a hotel/captive-portal Wi-Fi answers every request with an HTML 200.
 * So the store PROBES `GET {apiBase}/api/pos2/health` and believes only a JSON body `{"ok": true, ...}`:
 *   - interval 30 s while online, 10 s while offline, and at once after any `/api` network error (`reportNetworkError`);
 *   - TWO consecutive failures -> offline; ONE success -> online. It starts optimistic (online) with no failures.
 * The pure store and the probe have no React and never read the browser's online flag; only `useConnectivity` is React.
 * Ship precondition (runbook): the pos2 health route must be live before any tablet runs a v2 APK, or every tablet reads offline.
 */
import { useEffect, useSyncExternalStore } from "react";
import { API_BASE, POS2_API_BASE } from "@/lib/api-base";

export const HEALTH_PATH = "/api/pos2/health";
export const PROBE_TIMEOUT_MS = 4000;
export const ONLINE_INTERVAL_MS = 30_000;
export const OFFLINE_INTERVAL_MS = 10_000;
export const FAILURES_TO_OFFLINE = 2;

/** One probe. Never throws. ok === true ONLY for a 2xx answer whose JSON body has `ok` exactly `true`. */
export async function probeHealth(fetchFn: typeof fetch, apiBase: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; version?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${apiBase}${HEALTH_PATH}`, { method: "GET", cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ok?: unknown; version?: unknown } | null;
    if (!body || body.ok !== true) return { ok: false };
    return typeof body.version === "string" ? { ok: true, version: body.version } : { ok: true };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectivityState {
  online: boolean;
  consecutiveFailures: number;
  lastCheckedMs: number | null;
  version: string | null;
}

export interface ConnectivityStore {
  getState(): ConnectivityState;
  subscribe(listener: () => void): () => void;
  probe(): Promise<void>;
  start(): void;
  stop(): void;
  reportNetworkError(): void;
}

const INITIAL: ConnectivityState = { online: true, consecutiveFailures: 0, lastCheckedMs: null, version: null };

export function createConnectivityStore(d: { fetch: typeof fetch; apiBase?: string }): ConnectivityStore {
  const apiBase = d.apiBase ?? "";
  let state: ConnectivityState = INITIAL;
  const listeners: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight: Promise<void> | null = null;

  const set = (next: ConnectivityState) => {
    const changed = next.online !== state.online || next.version !== state.version || next.consecutiveFailures !== state.consecutiveFailures;
    state = next;
    if (changed) for (const l of [...listeners]) l();
  };

  const probe = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const r = await probeHealth(d.fetch, apiBase);
      const lastCheckedMs = Date.now();
      if (r.ok) set({ online: true, consecutiveFailures: 0, lastCheckedMs, version: r.version ?? state.version });
      else {
        const failures = state.consecutiveFailures + 1;
        set({ ...state, consecutiveFailures: failures, online: failures >= FAILURES_TO_OFFLINE ? false : state.online, lastCheckedMs });
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    timer = setTimeout(() => { void tick(); }, state.online ? ONLINE_INTERVAL_MS : OFFLINE_INTERVAL_MS);
  };

  const tick = async () => {
    await probe();
    schedule();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    probe,
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    reportNetworkError() {
      if (running) void tick(); // probes now and restarts the interval from here
      else void probe();
    },
  };
}

let singleton: ConnectivityStore | null = null;

/** The app's store: real fetch; the base is the POS v2 server in the APK and the same origin on the web. */
export function getConnectivityStore(): ConnectivityStore {
  if (!singleton) {
    const fetchNow: typeof fetch = (input, init) => fetch(input, init);
    singleton = createConnectivityStore({ fetch: fetchNow, apiBase: API_BASE ? POS2_API_BASE : "" });
  }
  return singleton;
}

let mounted = 0;
let browserHint: (() => void) | null = null;

/** Starts the singleton while at least one component uses it; stops it when the last one goes. */
function acquire(): () => void {
  const store = getConnectivityStore();
  if (mounted++ === 0) {
    store.start();
    if (typeof window !== "undefined") {
      // The browser's own events are only a HINT to probe now; the answer always comes from the probe.
      browserHint = () => { void store.probe(); };
      window.addEventListener("online", browserHint);
      window.addEventListener("offline", browserHint);
    }
  }
  return () => {
    if (--mounted === 0) {
      store.stop();
      if (typeof window !== "undefined" && browserHint) {
        window.removeEventListener("online", browserHint);
        window.removeEventListener("offline", browserHint);
        browserHint = null;
      }
    }
  };
}

export function useConnectivity(): ConnectivityState {
  useEffect(() => acquire(), []);
  const store = getConnectivityStore();
  return useSyncExternalStore(store.subscribe, store.getState, () => INITIAL);
}

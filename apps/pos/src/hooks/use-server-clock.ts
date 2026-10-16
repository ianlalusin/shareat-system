"use client";

import { useEffect, useSyncExternalStore } from "react";
import { clientAheadFromSample } from "@/lib/kitchen/server-clock";

/**
 * How far this device's clock runs ahead of the server's.
 *
 * A module-level singleton rather than a context: every ticket card asks for
 * it, and the answer is a property of the device, not of any subtree. One
 * sampler serves the whole app however many cards mount, and nothing has to be
 * threaded through a provider that two separate pages would each need.
 *
 * Null until the first sample lands, which callers read as "no correction" —
 * exactly the behaviour the KDS had before, so a failed or slow sample degrades
 * to the old rendering rather than to a wrong one.
 */

let clientAheadMs: number | null = null;
let sampling = false;
let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;
const listeners = new Set<() => void>();

/** Re-measure periodically: a device can drift, and tablets are left on for days. */
const RESAMPLE_MS = 5 * 60 * 1000;

async function sample(): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    const sentAtMs = Date.now();
    const res = await fetch("/api/kds/time", { cache: "no-store" });
    const receivedAtMs = Date.now();
    if (!res.ok) return;

    const json = (await res.json().catch(() => null)) as { serverMs?: number } | null;
    const next = clientAheadFromSample(sentAtMs, Number(json?.serverMs), receivedAtMs);
    // A rejected sample leaves the last good offset in place; one slow round
    // trip should not throw away a correction that was working.
    if (next == null || next === clientAheadMs) return;

    clientAheadMs = next;
    for (const l of listeners) l();
  } catch {
    // Offline, or the route is unreachable. The KDS keeps running uncorrected.
  } finally {
    sampling = false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  subscribers += 1;
  if (subscribers === 1) {
    void sample();
    timer = setInterval(() => void sample(), RESAMPLE_MS);
  }
  return () => {
    listeners.delete(onChange);
    subscribers -= 1;
    if (subscribers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => clientAheadMs;
/** The server renders no clock correction — it has no drift to correct. */
const getServerSnapshot = () => null;

export function useServerClockOffset(): number | null {
  const offset = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // A tablet that slept through the night wakes with a stale offset, and the
  // next resample could be minutes away.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") void sample();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, []);

  return offset;
}

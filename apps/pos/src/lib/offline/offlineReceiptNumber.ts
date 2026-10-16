"use client";

import type { KVStore } from "@/lib/offline/device";

/** Zero-pads a non-negative integer to `width` digits. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Formats an offline receipt number `<storeCode>-OL-<deviceTag>-<HHMM>-<NNN>`.
 * `date` supplies the device wall-clock finalize time; `seq` is the per-device
 * daily sequence. Example: `SHT-OL-AB12-0320-001`.
 */
export function formatOfflineReceiptNumber(args: {
  storeCode: string;
  deviceTag: string;
  date: Date;
  seq: number;
}): string {
  const { storeCode, deviceTag, date, seq } = args;
  const hhmm = pad(date.getHours(), 2) + pad(date.getMinutes(), 2);
  return `${storeCode}-OL-${deviceTag}-${hhmm}-${pad(seq, 3)}`;
}

const SEQ_KEY = "pos_offline_seq";

interface DailySeqState {
  ymd: string; // local calendar day the counter belongs to
  seq: number; // last issued sequence for that day
}

function localYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function isDailySeqState(x: unknown): x is DailySeqState {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).ymd === "string" &&
    typeof (x as Record<string, unknown>).seq === "number" &&
    Number.isFinite((x as Record<string, unknown>).seq as number)
  );
}

/**
 * Allocates the next gapless per-device sequence for the local day of `date`,
 * resetting to 1 when the calendar day changes. Persisted via `KVStore` so it
 * survives reloads.
 * NOTE: within a single webview (the Capacitor APK target) this synchronous
 * read-modify-write is race-free because JS is single-threaded. A multi-tab web
 * context could interleave two tabs; that would need an IndexedDB single-writer,
 * intentionally deferred since the shipping target is the single-webview APK.
 * Cross-DEVICE uniqueness is handled by the device tag in the receipt number,
 * not by this per-device counter.
 *
 * Persisted state is validated before use: unparseable or malformed state
 * throws rather than silently reissuing a receipt number, since a silent
 * reset or garbage sequence could produce a duplicate receipt number for the
 * same day.
 */
export function nextDailySeq(store: KVStore, date: Date): number {
  const ymd = localYmd(date);
  const raw = store.getItem(SEQ_KEY);

  if (raw === null) {
    const seq = 1;
    store.setItem(SEQ_KEY, JSON.stringify({ ymd, seq }));
    return seq;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "offline receipt sequence state is corrupt (unparseable); refusing to reissue numbers",
    );
  }

  if (!isDailySeqState(parsed)) {
    throw new Error(
      "offline receipt sequence state is corrupt (unexpected shape); refusing to reissue numbers",
    );
  }

  const seq = parsed.ymd === ymd ? parsed.seq + 1 : 1;
  store.setItem(SEQ_KEY, JSON.stringify({ ymd, seq }));
  return seq;
}

/** Convenience: allocate the next daily sequence and format it in one call. */
export function allocateOfflineReceiptNumber(
  store: KVStore,
  storeCode: string,
  deviceTag: string,
  date: Date,
): string {
  const seq = nextDailySeq(store, date);
  return formatOfflineReceiptNumber({ storeCode, deviceTag, date, seq });
}

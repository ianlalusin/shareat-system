import { Timestamp } from "firebase/firestore";

/**
 * Safely converts a value that might be a Firestore Timestamp, a plain object
 * representing a timestamp, a standard Date object, or a string/number into a
 * JavaScript Date object.
 *
 * This utility is crucial for components that render on both the server (Next.js SSR)
 * and the client, as Firestore Timestamps are serialized into plain objects during
 * server-side rendering.
 *
 * @param v The value to convert.
 * @returns A Date object, or null if the conversion is not possible.
 */
export function toJsDate(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v instanceof Timestamp) return v.toDate();
  // Check for Firestore Timestamp-like objects after SSR
  if (typeof v === 'object' && 'seconds' in v && 'nanoseconds' in v) {
    const d = new Date(v.seconds * 1000 + v.nanoseconds / 1000000);
    // Validate the created date
    return isNaN(d.getTime()) ? null : d;
  }
  // Handle string or number representations of a date
  if (typeof v === "number" || typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  // Handle other Firestore Timestamp-like objects (e.g., from different SDK versions)
  if (typeof v?.toDate === "function") return v.toDate();

  return null;
}

export function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
export function isSameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export function fmtDate(d: Date): string { return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }); }

export function formatDuration(ms: number, fallback = "00:00:00"): string {
  if (isNaN(ms) || ms <= 0) return fallback;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function formatDurationHuman(ms: number, fallback = ""): string {
  if (isNaN(ms) || ms <= 0) return fallback;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatDurationVerbose(ms: number, fallback = "less than a minute"): string {
  if (isNaN(ms) || ms <= 0) return fallback;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hPart = hours > 0 ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "";
  const mPart = minutes > 0 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "";
  if (hPart && mPart) return `${hPart} and ${mPart}`;
  if (hPart) return hPart;
  if (mPart) return mPart;
  return fallback;
}

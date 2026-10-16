"use client";

import { collection, documentId, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { ActivityLog, KitchenTicket, Receipt, SessionDoc } from "@/lib/types";

/**
 * Turning actor UIDs into names.
 *
 * Kitchen tickets record only `createdByUid` / `cancelledByUid` / `servedByUid`
 * with no name alongside, which is why session views used to print a raw 28-char
 * UID next to an event whose neighbouring activity log showed a real name — same
 * person, different source. Three tiers, cheapest first:
 *
 *   1. Names already in hand. Every activity log carries `actorName` /
 *      `serverProfileName` for its own actor, and the session/receipt/ticket docs
 *      carry names for verify, close, payment and serve. Cross-referencing by UID
 *      resolves most events at zero read cost.
 *   2. A `staff` lookup for whatever tier 1 missed, chunked ten at a time and
 *      memoised for the page's lifetime.
 *   3. A shortened UID with the full value on hover — never a bare UID.
 */

export type ActorNameMap = Map<string, string>;

export type ActorLabel = {
  /** What to render. */
  name: string;
  /** False when this is a shortened UID rather than a real name. */
  resolved: boolean;
  /** Full UID, for a title attribute. */
  uid: string | null;
};

function put(map: ActorNameMap, uid: unknown, name: unknown) {
  if (typeof uid !== "string" || !uid) return;
  if (typeof name !== "string") return;
  const trimmed = name.trim();
  if (!trimmed) return;
  // First writer wins: activity logs are the most specific attribution we have
  // (they name the device profile that acted, not just the login account).
  if (!map.has(uid)) map.set(uid, trimmed);
}

/**
 * Tier 1 — build a UID → name map from documents already fetched. No reads.
 */
export function collectLocalActorNames(sources: {
  session?: SessionDoc | null;
  receipt?: Receipt | null;
  tickets?: KitchenTicket[];
  activityLogs?: ActivityLog[];
}): ActorNameMap {
  const map: ActorNameMap = new Map();

  for (const log of sources.activityLogs ?? []) {
    put(map, log.actorUid, log.serverProfileName ?? log.actorName);
  }

  for (const t of sources.tickets ?? []) {
    put(map, (t as any).servedByUid, (t as any).servedByProfileName);
    for (const entry of (t as any).serveLog ?? []) {
      put(map, entry?.servedByUid, entry?.servedByProfileName);
    }
  }

  const session = sources.session as any;
  if (session) {
    put(map, session.verifiedByUid, session.verifiedByServerProfileName);
    put(map, session.closedByUid, session.closedByUsername);
  }

  const receipt = sources.receipt as any;
  if (receipt) {
    put(map, receipt.createdByUid, receipt.createdByUsername);
  }

  return map;
}

// Tier 2. Module-level so every expanded row and every drawer on the page share
// one cache; `inflight` keeps concurrent callers from firing duplicate queries
// for the same UID.
const staffNameCache: ActorNameMap = new Map();
const inflight = new Map<string, Promise<void>>();

async function fetchStaffChunk(uids: string[]): Promise<void> {
  const snap = await getDocs(query(collection(db, "staff"), where(documentId(), "in", uids)));
  snap.forEach((d) => {
    const data = d.data() as any;
    const name = data?.name ?? data?.displayName ?? data?.username;
    if (typeof name === "string" && name.trim()) staffNameCache.set(d.id, name.trim());
  });
  // Remember the misses too, as an empty string, so a deleted or unreadable
  // staff doc is not re-queried on every expansion.
  for (const uid of uids) if (!staffNameCache.has(uid)) staffNameCache.set(uid, "");
}

/**
 * Tier 2 — look up whatever tier 1 could not resolve. Safe to call with UIDs
 * already cached or already in flight; those are skipped.
 */
export async function resolveStaffNames(uids: string[]): Promise<ActorNameMap> {
  const wanted = Array.from(new Set(uids.filter((u): u is string => !!u)));
  const missing = wanted.filter((u) => !staffNameCache.has(u) && !inflight.has(u));

  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10);
    const p = fetchStaffChunk(chunk).catch(() => {
      // A failed lookup must not break the timeline — tier 3 covers it. Clear
      // the markers so a later expansion can retry.
      for (const uid of chunk) inflight.delete(uid);
    });
    for (const uid of chunk) inflight.set(uid, p);
  }

  await Promise.all(wanted.map((u) => inflight.get(u)).filter(Boolean));
  for (const uid of wanted) inflight.delete(uid);

  const out: ActorNameMap = new Map();
  for (const uid of wanted) {
    const name = staffNameCache.get(uid);
    if (name) out.set(uid, name);
  }
  return out;
}

export function shortUid(uid: string): string {
  return uid.length > 8 ? `${uid.slice(0, 6)}…` : uid;
}

/**
 * Resolve one actor for display. `preferred` is a name the event itself carried
 * (a log's `serverProfileName`), which always wins over any lookup.
 */
export function actorLabel(
  uid: string | null | undefined,
  maps: ActorNameMap[],
  preferred?: string | null
): ActorLabel {
  const direct = preferred?.trim();
  if (direct) return { name: direct, resolved: true, uid: uid ?? null };

  if (uid) {
    for (const map of maps) {
      const hit = map.get(uid);
      if (hit) return { name: hit, resolved: true, uid };
    }
    return { name: shortUid(uid), resolved: false, uid };
  }

  return { name: "—", resolved: false, uid: null };
}

/** UIDs referenced by a set of session documents, for a tier-2 lookup. */
export function collectActorUids(sources: {
  session?: SessionDoc | null;
  receipt?: Receipt | null;
  tickets?: KitchenTicket[];
  activityLogs?: ActivityLog[];
}): string[] {
  const uids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v) uids.add(v); };

  for (const log of sources.activityLogs ?? []) add(log.actorUid);
  for (const t of sources.tickets ?? []) {
    add((t as any).createdByUid);
    add((t as any).servedByUid);
    add((t as any).cancelledByUid);
    for (const entry of (t as any).serveLog ?? []) add(entry?.servedByUid);
  }
  const session = sources.session as any;
  if (session) {
    add(session.startedByUid);
    add(session.verifiedByUid);
    add(session.closedByUid);
    add(session.guestCountChange?.requestedByUid);
    add(session.guestCountChange?.approvedByUid);
    add(session.packageChange?.requestedByUid);
    add(session.packageChange?.approvedByUid);
  }
  add((sources.receipt as any)?.createdByUid);

  return Array.from(uids);
}

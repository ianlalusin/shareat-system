"use client";

/**
 * T-471 S3 - the tablet's calls for the day close. The Z is a POST through the same `postPos2` as refunds (token + device id + plain refusal sentences);
 * the X-reading is a read. The server decides every figure; this only carries the request.
 */
import { auth } from "@/lib/firebase/client";
import { getConnectivityStore } from "@/hooks/useConnectivity";
import { Pos2Error, POS2_UNREACHABLE, postPos2 } from "@/lib/pos2/client";
import type { ZReading, ZWindow } from "@/lib/cash/z-reading";

export type ZClose = { zNo: string; replayed: boolean; window: ZWindow; reading: ZReading; printedBy: { uid: string; name: string; role: string }; approvedByPersonId: string };
export type XRead = { window: ZWindow; reading: ZReading; lastZ: { zNo: string; toMs: number } | null };

/** `requestId` is kept by the caller until the Z is saved, so a retry after a lost answer returns the same Z instead of closing twice. */
export function closeDay(i: { storeId: string; requestId: string; pin: string; unsentCount: number }): Promise<ZClose & { ok: true }> {
  return postPos2<ZClose>("z-readings", { storeId: i.storeId, requestId: i.requestId, pin: i.pin, unsentCount: i.unsentCount });
}

export async function readX(storeId: string): Promise<XRead> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Pos2Error(401, "Sign in again to continue.");
  let res: Response;
  try {
    res = await fetch(`/api/pos2/x-reading?storeId=${encodeURIComponent(storeId)}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    getConnectivityStore().reportNetworkError();
    throw new Pos2Error(0, POS2_UNREACHABLE);
  }
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Partial<XRead>) | null;
  if (!res.ok || !data || data.ok !== true || !data.reading || !data.window) {
    throw new Pos2Error(res.status, data?.error || (res.status === 503 ? "The POS server is not ready yet. Ask a manager." : "Could not read the day so far. Try again."));
  }
  return { window: data.window, reading: data.reading, lastZ: data.lastZ ?? null };
}

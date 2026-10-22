"use client";

/**
 * T-424 S9 - the tablet's one way to call the POS v2 server (`/api/pos2/*`): refunds, tender corrections, unpaid-session voids.
 * Sends the Firebase ID token and this tablet's device id. The server decides everything that matters (who may do this, the manager PIN,
 * the amounts); this only carries the request and turns a refusal into a plain sentence. In the APK the fetch shim in `lib/api-base.ts` sends
 * `/api/pos2/...` to NEXT_PUBLIC_POS2_API_BASE.
 */
import { auth } from "@/lib/firebase/client";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { getConnectivityStore } from "@/hooks/useConnectivity";

export class Pos2Error extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "Pos2Error";
  }
}

export const POS2_UNREACHABLE = "Cannot confirm the POS server's response. Check the internet connection, then retry the same request or check the record before entering it again.";

export async function postPos2<T extends Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T & { ok: true }> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Pos2Error(401, "Sign in again to continue.");
  let res: Response;
  try {
    res = await fetch(`/api/pos2/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, deviceId: getBrowserDeviceId() }),
    });
  } catch {
    getConnectivityStore().reportNetworkError(); // T-425: probe the server now instead of waiting for the interval
    throw new Pos2Error(0, POS2_UNREACHABLE);
  }
  const data = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & Record<string, unknown>) | null;
  if (!res.ok || !data || data.ok !== true) {
    throw new Pos2Error(res.status, data?.error || (res.status === 503 ? "The POS server is not ready yet. Ask a manager." : "Could not confirm the result. Retry the same request or check the record before entering it again."));
  }
  return data as T & { ok: true };
}

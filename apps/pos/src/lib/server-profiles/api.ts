"use client";

import { auth } from "@/lib/firebase/client";

/**
 * Client helper for /api/server-profiles.
 *
 * All local-profile writes and passcode verification run server-side — the
 * passcode hash protects a 6-digit code and must never reach a client.
 */
export async function postServerProfileOp(payload: Record<string, unknown>): Promise<any> {
  const current = auth.currentUser;
  if (!current) throw new Error("Not signed in.");
  const idToken = await current.getIdToken();

  const res = await fetch("/api/server-profiles", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    const err: any = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

"use client";

/**
 * T-455 S5 - the customer lobby line on /cashier (replaces the Firestore waitlist card). The list comes from POST /api/pos2/lobby/list,
 * polled every 10 s (the poll is also what tells the diners' check-in that this POS is up). Code search is an on-screen number pad:
 * no free typing. Seat hands the party to the Start Session form; once the session exists `linkSeat` fetches its join link and tells the
 * lobby, and if that fails the row keeps a "Retry link" button until it works or the cashier dismisses it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Delete, Link2, Loader2, Pause, Phone, Play, Plus, Users, X } from "lucide-react";
import { ParkWalkInModal } from "./ParkWalkInModal";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { auth } from "@/lib/firebase/client";
import { postPos2 } from "@/lib/pos2/client";
import {
  LOBBY_RETRY_LABEL,
  LOBBY_UNAVAILABLE,
  filterByCode,
  keypadPress,
  linkSeatedSession,
  lobbyFailure,
  lobbyRowSummary,
  type LobbyEntry,
} from "@/lib/pos2/lobby";
import { addPendingLink, clearPendingLink, readPendingLinks, type PendingLink } from "@/lib/pos2/lobbyPending";

const POLL_MS = 10_000;
export const LOBBY_REFRESH_EVENT = "pos-lobby-refresh";

/** The session's join link, fetched the same way the PIN slip does. Throws when it cannot be had. */
async function fetchJoinUrl(storeId: string, sessionId: string): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("not signed in");
  const res = await fetch(`/api/pins/join-url?storeId=${encodeURIComponent(storeId)}&sessionId=${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json.ok || !json.joinUrl) throw new Error("no join link");
  return json.joinUrl as string;
}

/**
 * After the POS session exists: link it to the waiting lobby entry. Never throws, never undoes the session. A failure is remembered so the
 * row shows "Retry link" (also after the screen changes); success clears it.
 */
export async function linkSeat(storeId: string, link: PendingLink): Promise<boolean> {
  const r = await linkSeatedSession({
    ...link,
    fetchJoinUrl: () => fetchJoinUrl(storeId, link.sessionId),
    seat: (b) => postPos2("lobby/seat", { storeId, ...b }),
  });
  if (r.linked) clearPendingLink(storeId, link.entryId);
  else addPendingLink(storeId, link);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOBBY_REFRESH_EVENT));
  return r.linked;
}

interface Props {
  storeId: string;
  onSeat: (entry: LobbyEntry) => void;
  activeSeatingId?: string | null;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;
type Err = { status?: unknown; message?: unknown };

export function LobbyCard({ storeId, onSeat, activeSeatingId }: Props) {
  const [entries, setEntries] = useState<LobbyEntry[]>([]);
  const [lobbyEnabled, setLobbyEnabled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [digits, setDigits] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<Record<string, PendingLink>>({});
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    if (!storeId) return;
    try {
      const r = await postPos2<{ lobbyEnabled: boolean; paused: boolean; entries: LobbyEntry[] }>("lobby/list", { storeId });
      setEntries(r.entries);
      setLobbyEnabled(r.lobbyEnabled);
      setPaused(r.paused);
      setUnavailable(null);
    } catch (err) {
      // 503 / no answer: the one waiting-list sentence. Any other failure keeps the last list and says why in plain words.
      const f = lobbyFailure(err as Err);
      setUnavailable(f.kind === "unavailable" ? LOBBY_UNAVAILABLE : f.message);
    } finally {
      setPending(readPendingLinks(storeId));
      setNow(Date.now());
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onRefresh = () => void refresh();
    window.addEventListener(LOBBY_REFRESH_EVENT, onRefresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(LOBBY_REFRESH_EVENT, onRefresh);
    };
  }, [refresh]);

  const shown = useMemo(() => filterByCode(entries, digits), [entries, digits]);

  const act = async (entry: LobbyEntry, run: () => Promise<unknown>, done: string) => {
    setBusyId(entry.entryId);
    try {
      await run();
      toast({ title: done, description: entry.displayName ?? entry.code });
    } catch (err) {
      toast({ variant: "destructive", title: "Could not do that", description: lobbyFailure(err as Err).message });
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  const handleCall = (e: LobbyEntry) => act(e, () => postPos2("lobby/call", { storeId, entryId: e.entryId }), "Called");

  const handleRemove = async (e: LobbyEntry) => {
    if (!(await confirm({
      title: `Remove ${e.displayName ?? e.code} from the line?`,
      description: "They will no longer appear on this list.",
      confirmText: "Remove",
    }))) return;
    await act(e, () => postPos2("lobby/remove", { storeId, entryId: e.entryId }), "Removed");
  };

  const handleRetry = async (e: LobbyEntry, link: PendingLink) => {
    setBusyId(e.entryId);
    const ok = await linkSeat(storeId, link);
    setBusyId(null);
    toast(ok ? { title: "Linked", description: e.displayName ?? e.code } : { variant: "destructive", title: "Could not link yet", description: "The table session is fine. Try again." });
  };

  // Dismiss: the party is recorded as seated; only the phone hand-off is lost.
  const handleDismiss = (e: LobbyEntry, link: PendingLink) =>
    act(
      e,
      async () => {
        await postPos2("lobby/seat", { storeId, entryId: e.entryId, sessionId: link.sessionId, standLabel: link.standLabel, joinUrl: null });
        clearPendingLink(storeId, e.entryId);
      },
      "Dismissed",
    );

  const handlePause = async () => {
    try {
      await postPos2("lobby/pause", { storeId, paused: !paused });
      toast({ title: paused ? "Lobby resumed" : "Lobby paused" });
    } catch (err) {
      toast({ variant: "destructive", title: "Could not change the lobby", description: lobbyFailure(err as Err).message });
    } finally {
      void refresh();
    }
  };

  const count = entries.length;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 p-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" />
              Waiting line
              {count > 0 && <Badge variant="secondary">{count}</Badge>}
              {lobbyEnabled && paused && <Badge variant="outline">Paused</Badge>}
            </CardTitle>
            <CardDescription className="text-xs">Walk-ins and diners checked in on their phones.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {lobbyEnabled && (
              <Button size="sm" variant="outline" onClick={handlePause}>
                {paused ? <Play className="h-4 w-4 mr-1" /> : <Pause className="h-4 w-4 mr-1" />}
                {paused ? "Resume lobby" : "Pause lobby"}
              </Button>
            )}
            <Button size="sm" onClick={() => setModalOpen(true)} disabled={isLoading}>
              <Plus className="h-4 w-4 mr-1" /> Add walk-in
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 px-4 pb-4 space-y-3">
          {unavailable && <p className="text-xs text-muted-foreground text-center py-2">{unavailable}</p>}

          {count > 0 && (
            <div className="space-y-2">
              <div className="rounded-md border px-3 h-10 flex items-center text-lg tabular-nums tracking-widest" aria-label="Code search">
                {digits || <span className="text-sm text-muted-foreground tracking-normal">Tap the code</span>}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {KEYS.map((k) => (
                  <Button
                    key={k}
                    type="button"
                    variant="outline"
                    className="h-11 text-lg"
                    onClick={() => setDigits((d) => keypadPress(d, k))}
                    aria-label={k === "back" ? "Delete last digit" : k === "clear" ? "Clear code" : `Digit ${k}`}
                  >
                    {k === "back" ? <Delete className="h-4 w-4" /> : k === "clear" ? "C" : k}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : count === 0 ? (
            !unavailable && <p className="text-xs text-muted-foreground text-center py-4">No one in the line.</p>
          ) : shown.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No one with that code.</p>
          ) : (
            <ul className="space-y-2">
              {shown.map((e) => {
                const isActive = activeSeatingId === e.entryId;
                const link = pending[e.entryId];
                const busy = busyId === e.entryId;
                const unmapped = e.lines.filter((l) => !l.posItemKey);
                return (
                  <li key={e.entryId} className={`rounded-lg border p-2 space-y-1 ${isActive ? "bg-primary/5 border-primary/50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <p className="flex-1 min-w-0 font-bold truncate">{lobbyRowSummary(e, now)}</p>
                      {e.status === "called" && <Badge variant="secondary" className="text-[10px]">Called</Badge>}
                    </div>
                    {(e.phone || e.note || unmapped.length > 0) && (
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                        {e.phone && (
                          <span className="flex items-center gap-0.5">
                            <Phone className="h-3 w-3" /> {e.phone}
                          </span>
                        )}
                        {e.note && <span className="truncate">{e.note}</span>}
                        {unmapped.map((l) => (
                          <span key={l.variantId + l.label}>{l.qty} x {l.label} (tap in by hand)</span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {link ? (
                        <>
                          <Button size="sm" className="h-8" disabled={busy} onClick={() => handleRetry(e, link)}>
                            <Link2 className="h-4 w-4 mr-1" /> {LOBBY_RETRY_LABEL}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => handleDismiss(e, link)}>
                            Dismiss
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" className="h-8" disabled={busy || e.status === "called"} onClick={() => handleCall(e)}>
                            Call
                          </Button>
                          <Button size="sm" variant={isActive ? "default" : "outline"} className="h-8" disabled={busy} onClick={() => onSeat(e)}>
                            Seat
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 ml-auto text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            onClick={() => handleRemove(e)}
                            aria-label={`Remove ${e.displayName ?? e.code} from the line`}
                          >
                            <X className="h-4 w-4 mr-1" /> Remove
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ParkWalkInModal open={modalOpen} onOpenChange={setModalOpen} storeId={storeId} onParked={() => void refresh()} />
      {ConfirmDialog}
    </>
  );
}

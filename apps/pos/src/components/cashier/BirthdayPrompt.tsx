"use client";

/**
 * T-455 S6b - the birthday request prompt on /cashier. A diner's birthday song request arrives through POST /api/pos2/lobby/birthday/list
 * (polled every 10 s, the same beat as the lobby card), one request at a time, oldest first. The cashier taps Accept with a time (default Now) or
 * one of three Decline reasons (no free typing). An accepted request is handed to the tablet scheduler: at its time a 10 s countdown shows
 * with a Stop button, then the song plays and the server is told. Only the request id, time and store are kept in localStorage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Cake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { postPos2 } from "@/lib/pos2/client";
import { BIRTHDAY_DECLINE_PRESETS } from "@/lib/pos2/birthdayPresets";
import { lobbyFailure } from "@/lib/pos2/lobby";
import { playBirthdayLoop } from "@/lib/birthday/player";
import { createBirthdayScheduler, type Scheduler, type SchedulerState } from "@/lib/birthday/scheduler";

const POLL_MS = 10_000;

interface BirthdayRow {
  requestId: string;
  code: string;
  displayName: string | null;
  standLabel: string | null;
  celebrantName: string | null;
  status: "requested" | "accepted";
  createdAt: string;
}

/** "HH:MM" today (local); a time already gone today means tomorrow. */
function timeToEpoch(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(nowMs);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime() < nowMs ? d.getTime() + 24 * 3_600_000 : d.getTime();
}

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

export function BirthdayPrompt({ storeId }: { storeId: string | undefined }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<BirthdayRow[]>([]);
  const [answered, setAnswered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [time, setTime] = useState("12:00");
  const [sched, setSched] = useState<SchedulerState>({ countdown: null, pending: [] });
  const scheduler = useRef<Scheduler | null>(null);

  useEffect(() => {
    if (!storeId) return;
    let storage: Storage | ReturnType<typeof memoryStorage>;
    try {
      storage = window.localStorage;
    } catch {
      storage = memoryStorage();
    }
    const s = createBirthdayScheduler({
      storage,
      storeId,
      playSong: playBirthdayLoop,
      markPlayed: async (requestId) => {
        await postPos2("lobby/birthday/play", { storeId, requestId });
      },
    });
    scheduler.current = s;
    const off = s.subscribe(() => setSched(s.state()));
    s.restore();
    setSched(s.state());
    return () => {
      off();
      scheduler.current = null;
    };
  }, [storeId]);

  const refresh = useCallback(async () => {
    if (!storeId) return;
    try {
      const r = await postPos2<{ birthdays: BirthdayRow[] }>("lobby/birthday/list", { storeId });
      setRows(r.birthdays);
    } catch {
      /* offline or server down: keep the last answer; the next poll tries again */
    }
    await scheduler.current?.flushPlayed();
  }, [storeId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const current = rows.find((r) => r.status === "requested" && !answered.includes(r.requestId)) ?? null;

  const fail = (err: unknown) => toast({ variant: "destructive", title: "Could not do that", description: lobbyFailure(err as { status?: unknown; message?: unknown }).message });

  const accept = async () => {
    if (!current || !storeId) return;
    const at = when === "now" ? Date.now() : timeToEpoch(time, Date.now());
    setBusy(true);
    try {
      await postPos2("lobby/birthday/accept", { storeId, requestId: current.requestId, scheduledAt: new Date(at).toISOString() });
      setAnswered((a) => [...a, current.requestId]);
      scheduler.current?.accept({ requestId: current.requestId, scheduledAt: at });
      toast({ title: "Birthday song accepted", description: when === "now" ? "Plays now." : `Plays at ${time}.` });
      setWhen("now");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const decline = async (reason: string) => {
    if (!current || !storeId) return;
    setBusy(true);
    try {
      await postPos2("lobby/birthday/decline", { storeId, requestId: current.requestId, reason });
      setAnswered((a) => [...a, current.requestId]);
      setDeclining(false);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  if (sched.countdown) {
    const { requestId, secondsLeft } = sched.countdown;
    return (
      <Dialog open>
        <DialogContent className="sm:max-w-sm" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Cake className="h-5 w-5" /> Birthday song in {secondsLeft}...</DialogTitle>
            <DialogDescription>The song will play on this tablet. Tap Stop to cancel it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" size="lg" onClick={() => scheduler.current?.stop(requestId)}>Stop</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!current) return null;
  return (
    <Dialog open>
      <DialogContent className="sm:max-w-sm" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Cake className="h-5 w-5" /> Birthday song request</DialogTitle>
          <DialogDescription>
            {current.code} {current.displayName ? `· ${current.displayName}` : ""} {current.standLabel ? `· ${current.standLabel}` : ""}
            {current.celebrantName ? ` · for ${current.celebrantName}` : ""}
          </DialogDescription>
        </DialogHeader>
        {declining ? (
          <div className="grid gap-2">
            {BIRTHDAY_DECLINE_PRESETS.map((p) => (
              <Button key={p} variant="outline" size="lg" disabled={busy} onClick={() => void decline(p)}>{p}</Button>
            ))}
            <Button variant="ghost" onClick={() => setDeclining(false)}>Back</Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex gap-2">
              <Button variant={when === "now" ? "default" : "outline"} onClick={() => setWhen("now")}>Now</Button>
              <Button variant={when === "later" ? "default" : "outline"} onClick={() => setWhen("later")}>At a time</Button>
              {when === "later" && (
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-md border px-2 text-base" aria-label="Birthday song time" />
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="lg" disabled={busy} onClick={() => setDeclining(true)}>Decline</Button>
              <Button size="lg" disabled={busy || (when === "later" && time === "")} onClick={() => void accept()}>Accept</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquare, Loader2, ArrowLeft, Check, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { fireKitchenAlert, primeKitchenAudio } from "@/lib/notifications/kitchenAlert";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { getLastLoggedProfile, setLastLoggedProfile } from "@/lib/chat/chatPresenceTracker";
import { ChatThreadPane } from "./ChatThreadPane";
import type { ChatThread } from "./chat-types";
import {
  countAwaitingReply,
  countOpenFollowUp,
  fmtStamp,
  threadIsOpenFollowUp,
  threadNeedsReply,
} from "./chat-utils";

// A customer message left unreplied longer than this makes the red dot pulse.
const STALE_UNREAD_MS = 5 * 60 * 1000;

// Order threads (id `order_{orderId}`, source: "order") are surfaced inside
// the order card instead of here, so they must never show up in the
// site-wide chat FAB — otherwise two staff could answer the same customer.
//
// Pure so it's trivially testable without rendering the component.
export function excludeOrderThreads(threads: ChatThread[]): ChatThread[] {
  return threads.filter((t) => t.source !== "order");
}

export function ChatInbox({ storeId }: { storeId: string | null | undefined }) {
  const { appUser } = useAuthContext();
  const { currentProfile } = useLocalProfile();

  // Presence log for chat on-duty attribution. Scoped to THIS component
  // (mounted only on cashier-station views) so a KDS/server device's local
  // profile never pollutes "who's on duty for chat". Logs a signout for the
  // previous profile immediately followed by a signin for the new one.
  //
  // The "previous profile" lives in module state (chatPresenceTracker), NOT a
  // useRef: ChatInbox is mounted on five pages, so navigating between any two
  // of them destroys this instance and builds a fresh one. With a ref, that
  // remount started from null and re-logged a signout+signin pair — every
  // navigation looked like a shift change, which both reset the cashier's
  // "on duty since" to the moment they clicked a nav link (making a genuinely
  // slow reply score as instant) and could land both halves of the pair on the
  // same millisecond. The tracker survives the remount, so a navigation with
  // an unchanged profile writes nothing at all.
  //
  // There is deliberately NO signout-on-unmount: an unmount cannot tell a route
  // change apart from the cashier actually leaving, and writing a signout for
  // the former is precisely the bug above. Real transitions come through this
  // same effect — signing out via the profile switcher sets currentProfile to
  // null, which logs the signout here. A tab closed without signing out leaves
  // the last signin standing, so resolveOnDutyAt keeps attributing to the last
  // known cashier until the next real transition; that is the same fail-safe
  // direction the rest of the app already takes for local-profile lifetime.
  useEffect(() => {
    if (!storeId) return;
    const prev = getLastLoggedProfile(storeId);
    const next = currentProfile ? { profileId: currentProfile.profileId, profileName: currentProfile.name } : null;
    if (prev?.profileId === next?.profileId) return;
    // Claim the transition synchronously, before awaiting anything: two
    // ChatInbox instances can briefly overlap during a route change, and the
    // second must see the transition as already handled.
    setLastLoggedProfile(storeId, next);
    const now = Date.now();
    const logRef = collection(db, `stores/${storeId}/chatPresenceLog`);
    (async () => {
      try {
        if (prev) {
          await addDoc(logRef, { profileId: prev.profileId, profileName: prev.profileName, event: "signout", atClientMs: now, atServer: serverTimestamp() });
        }
        if (next) {
          await addDoc(logRef, { profileId: next.profileId, profileName: next.profileName, event: "signin", atClientMs: now, atServer: serverTimestamp() });
        }
      } catch (e) {
        console.error("[ChatInbox] presence log write failed:", e);
      }
    })();
  }, [storeId, currentProfile]);

  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
  const [open, setOpen] = useState(false);
  const [listTab, setListTab] = useState<"open" | "closed">("open");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [closedThreads, setClosedThreads] = useState<ChatThread[]>([]);
  const [closedLoading, setClosedLoading] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // Drives the red "stale unread" dot so it appears after 5 min even with no
  // new activity. Cheap re-render, no extra reads.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const prevUnread = useRef<number | null>(null);

  useEffect(() => { primeKitchenAudio(); }, []);

  // Live open threads for this store (equality query → no composite index).
  //
  // Deliberately NOT filtering source!="order" in this query: a Firestore
  // inequality filter excludes documents that lack the field entirely, which
  // would hide every walk-in thread created before order-chat existed. Order
  // threads are excluded client-side instead — see excludeOrderThreads().
  useEffect(() => {
    if (!storeId) { setThreads([]); return; }
    const q = query(collection(db, `stores/${storeId}/chatThreads`), where("status", "==", "open"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }) as ChatThread)
          .sort((a, b) => (b.lastMessageAtClientMs || 0) - (a.lastMessageAtClientMs || 0));
        setThreads(rows);
      },
      (err) => console.error("[ChatInbox] threads snapshot error:", err),
    );
    return () => unsub();
  }, [storeId]);

  // Closed threads are historical — no live listener (that would accrue reads
  // forever). Fetch once on demand whenever the Closed tab is opened.
  useEffect(() => {
    if (!open || listTab !== "closed" || !storeId) return;
    let cancelled = false;
    setClosedLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, `stores/${storeId}/chatThreads`), where("status", "==", "closed")));
        if (cancelled) return;
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }) as ChatThread)
          .sort((a, b) => (b.lastMessageAtClientMs || 0) - (a.lastMessageAtClientMs || 0));
        setClosedThreads(rows);
      } catch (e) {
        console.error("[ChatInbox] closed threads fetch error:", e);
      } finally {
        if (!cancelled) setClosedLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, listTab, storeId]);

  // Filtered views used everywhere this list feeds the UI (render, badge,
  // count) so order threads never surface here in any form.
  const filteredThreads = useMemo(() => excludeOrderThreads(threads), [threads]);
  const filteredClosedThreads = useMemo(() => excludeOrderThreads(closedThreads), [closedThreads]);

  // RED: customers waiting on us. Survives opening/closing the panel because
  // it reads lastMessageBy, which only an actual staff reply can clear.
  const awaitingReply = useMemo(() => countAwaitingReply(filteredThreads), [filteredThreads]);
  // GREEN: live conversations we answered last — nudge to follow up.
  const openFollowUp = useMemo(() => countOpenFollowUp(filteredThreads), [filteredThreads]);

  // Still message-grained: drives the per-thread count chip inside the list.
  const totalUnread = useMemo(
    () => filteredThreads.reduce((n, t) => n + (t.unreadForStaff || 0), 0),
    [filteredThreads],
  );

  // Chime when the staff-unread total rises (a new customer message arrived),
  // unless the cashier is already in a conversation (avoid chiming while typing).
  useEffect(() => {
    if (prevUnread.current != null && totalUnread > prevUnread.current) {
      const activelyChatting = open && activeThreadId != null;
      if (!activelyChatting) void fireKitchenAlert({ title: "New website chat", body: "A customer messaged on the website." });
    }
    prevUnread.current = totalUnread;
  }, [totalUnread, open, activeThreadId]);

  // --- Auto-open the panel when a customer message lands -------------------
  //
  // Gated on the till being idle. A right-side Sheet that appears while the
  // cashier is taking payment steals taps mid-transaction, so a rise in
  // awaitingReply only ARMS the intent; the panel opens on the first tick where
  // nothing else is on screen. `isTillBusy` deliberately probes the DOM rather
  // than any one page's state: ChatInbox is mounted on five different pages
  // (cashier, pins, online orders, dashboard, reservations) and every blocking
  // surface on all of them is a Radix dialog/alertdialog, so one check covers
  // them without threading a "busy" prop through five call sites.
  const prevAwaiting = useRef<number | null>(null);
  const [autoOpenArmed, setAutoOpenArmed] = useState(false);

  useEffect(() => {
    if (prevAwaiting.current != null && awaitingReply > prevAwaiting.current) setAutoOpenArmed(true);
    prevAwaiting.current = awaitingReply;
  }, [awaitingReply]);

  useEffect(() => {
    if (!autoOpenArmed) return;
    // Nothing left to answer (someone else replied first) — stand down.
    if (awaitingReply === 0) { setAutoOpenArmed(false); return; }
    if (open) { setAutoOpenArmed(false); return; }

    const isTillBusy = () => {
      if (typeof document === "undefined") return true;
      // Any open modal/sheet/confirm — payment, order edit, PIN entry, etc.
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return true;
      // Mid-keystroke in a form (tendered amount, discount, search).
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return true;
      return false;
    };

    if (!isTillBusy()) { setOpen(true); setAutoOpenArmed(false); return; }
    const id = setInterval(() => {
      if (!isTillBusy()) { setOpen(true); setAutoOpenArmed(false); }
    }, 1000);
    return () => clearInterval(id);
  }, [autoOpenArmed, awaitingReply, open]);

  const activeThread =
    filteredThreads.find((t) => t.id === activeThreadId) ??
    filteredClosedThreads.find((t) => t.id === activeThreadId) ??
    null;
  const isActiveClosed = activeThread?.status === "closed";
  const displayedThreads = listTab === "open" ? filteredThreads : filteredClosedThreads;

  // Opening a thread is NOT the same as answering it. This used to write
  // `unreadForStaff: 0` here, which is the root cause of the missed Malvar
  // message: a cashier who read a thread and walked away silently cleared the
  // badge, the ping, the bounce and the stale dot while the customer was still
  // waiting. Only ChatThreadPane's send paths clear the counter now.
  function openThread(t: ChatThread) {
    setActiveThreadId(t.id);
  }

  async function closeThreadInternal() {
    if (!storeId || !activeThreadId) return;
    try {
      await updateDoc(doc(db, `stores/${storeId}/chatThreads/${activeThreadId}`), {
        status: "closed",
        closedAt: serverTimestamp(),
        closedByUid: appUser?.uid ?? null,
        closedByName: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      });
      setActiveThreadId(null);
    } catch (e) {
      console.error("[ChatInbox] closeThread failed:", e);
    }
  }

  async function endChat() {
    if (!storeId || !activeThreadId) return;
    const ok = await confirm({
      title: "End this chat?",
      description: "This closes the conversation. The visitor will see it as closed.",
      confirmText: "End chat",
    });
    if (ok) await closeThreadInternal();
  }

  return (
    <>
      {/* Floating button — stacked above the weather FAB (bottom-6).
          Two mutually exclusive counters:
            RED   = customers waiting on a reply (urgent, pulses)
            GREEN = answered-but-open conversations (follow-up nudge, calm)
          Red wins when both apply, so the till is never shown a soothing green
          while someone is actually waiting. The badge itself is NOT gated on
          the panel being shut — closing the sheet no longer dismisses it. */}
      <div className="fixed bottom-24 right-6 z-40">
        {awaitingReply > 0 && !open && (
          <span aria-hidden className="absolute inset-0 rounded-full bg-destructive/60 animate-ping" />
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "relative h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-2xl",
            "flex items-center justify-center hover:scale-105 active:scale-95 transition-transform ring-4 ring-primary/20",
            awaitingReply > 0 && !open && "animate-bounce",
          )}
          aria-label={
            awaitingReply > 0
              ? `Website chats — ${awaitingReply} awaiting reply`
              : openFollowUp > 0
              ? `Website chats — ${openFollowUp} open conversation(s)`
              : "Website chats"
          }
          title={
            awaitingReply > 0
              ? `${awaitingReply} conversation(s) awaiting your reply`
              : openFollowUp > 0
              ? `${openFollowUp} open conversation(s) — follow up?`
              : "Website chats"
          }
        >
          <MessageSquare className="h-6 w-6" />
          {awaitingReply > 0 ? (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-6 min-w-6 px-1.5 justify-center text-xs font-bold"
            >
              {awaitingReply}
            </Badge>
          ) : openFollowUp > 0 ? (
            <Badge
              className="absolute -top-1 -right-1 h-6 min-w-6 px-1.5 justify-center text-xs font-bold border-transparent bg-emerald-500 text-white hover:bg-emerald-500"
            >
              {openFollowUp}
            </Badge>
          ) : null}
        </button>
      </div>

      <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) setActiveThreadId(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-[420px] p-0 flex flex-col">
          {!activeThread ? (
            <>
              <SheetHeader className="p-4 pb-2 border-b">
                <SheetTitle className="flex items-center gap-2"><MessageSquare className="h-5 w-5" /> Website Chats</SheetTitle>
                <SheetDescription>
                  {listTab === "open" ? "Live messages from the website. Tap one to reply." : "Previously closed conversations."}
                </SheetDescription>
                <div className="inline-flex rounded-md border p-0.5 mt-2 w-fit">
                  <Button variant={listTab === "open" ? "secondary" : "ghost"} size="sm" className="h-7 px-3 text-xs" onClick={() => setListTab("open")}>
                    Open{filteredThreads.length > 0 ? ` (${filteredThreads.length})` : ""}
                  </Button>
                  <Button variant={listTab === "closed" ? "secondary" : "ghost"} size="sm" className="h-7 px-3 text-xs" onClick={() => setListTab("closed")}>
                    Closed
                  </Button>
                </div>
              </SheetHeader>
              <ScrollArea className="flex-1 px-3 py-3">
                {listTab === "closed" && closedLoading ? (
                  <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
                ) : displayedThreads.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    {listTab === "open" ? "No open chats." : "No closed chats."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {displayedThreads.map((t) => {
                      const needsReply = threadNeedsReply(t);
                      const followUp = threadIsOpenFollowUp(t);
                      const stale = needsReply && nowTick - (t.lastMessageAtClientMs || 0) > STALE_UNREAD_MS;
                      const pendingMsgs = t.unreadForStaff || 0;
                      return (
                      <button
                        key={t.id}
                        onClick={() => openThread(t)}
                        className="w-full text-left rounded-lg border bg-background p-3 hover:bg-muted/50 transition"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {(needsReply || followUp) && (
                              <span
                                className={cn(
                                  "h-2.5 w-2.5 rounded-full shrink-0",
                                  needsReply
                                    ? stale
                                      ? "bg-red-500 animate-pulse"
                                      : "bg-red-500"
                                    : "bg-emerald-500",
                                )}
                                title={
                                  needsReply
                                    ? stale
                                      ? "Waiting over 5 minutes — needs a reply"
                                      : "Waiting for your reply"
                                    : "Open conversation — follow up?"
                                }
                              />
                            )}
                            <div className="font-semibold text-sm truncate">{t.customerName || "Website visitor"}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] text-muted-foreground">{fmtStamp(t.lastMessageAtClientMs, nowTick)}</span>
                            {needsReply && pendingMsgs > 0 && (
                              <Badge variant="destructive" className="h-5 min-w-5 px-1.5 justify-center text-xs">{pendingMsgs}</Badge>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {t.lastMessageBy === "staff" ? "You: " : ""}{t.lastMessageText || "…"}
                        </div>
                      </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </>
          ) : (
            <>
              <SheetHeader className="p-3 border-b">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setActiveThreadId(null)}>
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="text-base truncate">{activeThread.customerName || "Website visitor"}</SheetTitle>
                    {activeThread.phone && (
                      <SheetDescription className="flex items-center gap-1 text-xs"><Phone className="h-3 w-3" /> {activeThread.phone}</SheetDescription>
                    )}
                  </div>
                  {isActiveClosed ? (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">Closed</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive" onClick={() => void endChat()}>
                      <Check className="h-4 w-4 mr-1" /> End chat
                    </Button>
                  )}
                </div>
              </SheetHeader>
              {storeId && activeThreadId && (
                <ChatThreadPane
                  storeId={storeId}
                  threadId={activeThreadId}
                  isClosed={isActiveClosed}
                  onClosed={() => setActiveThreadId(null)}
                />
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
      {ConfirmDialog}
    </>
  );
}

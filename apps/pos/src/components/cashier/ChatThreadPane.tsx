"use client";

import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import { useLocalProfile } from "@/context/local-profile-context";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import type { ChatMessage } from "./chat-types";
import { fmtStamp } from "./chat-utils";

const CLOSING_SPIEL =
  "Thank you for reaching out to us! We'll be closing this chat for now. You can reach us anytime through our phone, our Facebook page, or right here — we're always happy to help.";

// Renders a chat thread's transcript and reply composer. Does not own the
// thread list, the Sheet chrome, or the header's "End chat" flow — those stay
// in ChatInbox. `onClosed` is an opt-in hook for the "send closing message &
// end chat" quick action, which also lives here because it is structurally
// part of the composer card; omit it to get a bare transcript + composer.
export function ChatThreadPane({
  storeId,
  threadId,
  isClosed,
  onClosed,
}: {
  storeId: string;
  threadId: string;
  isClosed?: boolean;
  onClosed?: () => void;
}) {
  const { appUser, user } = useAuthContext();
  const { currentProfile } = useLocalProfile();
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  // Conversation listener for the selected thread.
  useEffect(() => {
    if (!storeId || !threadId) { setMessages([]); return; }
    const q = query(
      collection(db, `stores/${storeId}/chatThreads/${threadId}/messages`),
      orderBy("createdAtClientMs", "asc"),
    );
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as ChatMessage));
    });
    return () => unsub();
  }, [storeId, threadId]);

  // Tells the server a staff reply just landed so it can score the customer
  // messages that were still waiting. Fire-and-forget for the UI: a failure
  // here costs a metric, never the reply itself, so it is logged and swallowed.
  //
  // No timestamp is sent — the route derives the scoring instant server-side so
  // a forged or skewed client clock can't move anyone's score.
  async function notifyChatResponse(pendingIds: string[]) {
    if (pendingIds.length === 0 || !currentProfile || !user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/analytics/chat-response", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          storeId, threadId,
          respondedByProfileId: currentProfile.profileId,
          respondedByName: currentProfile.name,
          pendingMessageIds: pendingIds,
        }),
      });
      if (!res.ok) {
        console.error("[ChatThreadPane] chat-response analytics call rejected:", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      console.error("[ChatThreadPane] chat-response analytics call failed:", e);
    }
  }

  function pendingCustomerMessageIds(): string[] {
    return messages.filter((m) => m.sender === "customer" && m.respondedAtClientMs == null).map((m) => m.id);
  }

  async function sendReply() {
    const text = reply.trim();
    if (!storeId || !threadId || !text || sending) return;
    setSending(true);
    try {
      const staffName = currentProfile?.name || appUser?.displayName || appUser?.name || "Staff";
      const now = Date.now();
      await addDoc(collection(db, `stores/${storeId}/chatThreads/${threadId}/messages`), {
        sender: "staff",
        text,
        staffName,
        createdAt: serverTimestamp(),
        createdAtClientMs: now,
      });
      await updateDoc(doc(db, `stores/${storeId}/chatThreads/${threadId}`), {
        lastMessageText: text,
        lastMessageBy: "staff",
        lastMessageAtClientMs: now,
        unreadForStaff: 0,
        updatedAt: serverTimestamp(),
      });
      await notifyChatResponse(pendingCustomerMessageIds());
      setReply("");
    } catch (e) {
      console.error("[ChatThreadPane] sendReply failed:", e);
    } finally {
      setSending(false);
    }
  }

  // Sends a polite closing message to the visitor, then closes the chat.
  async function sendClosingAndEnd() {
    if (!storeId || !threadId || sending) return;
    const ok = await confirm({
      title: "Send closing message & end?",
      description: "Sends a polite closing note to the visitor, then closes this chat.",
      confirmText: "Send & end",
    });
    if (!ok) return;
    setSending(true);
    try {
      const staffName = currentProfile?.name || appUser?.displayName || appUser?.name || "Staff";
      const now = Date.now();
      await addDoc(collection(db, `stores/${storeId}/chatThreads/${threadId}/messages`), {
        sender: "staff",
        text: CLOSING_SPIEL,
        staffName,
        createdAt: serverTimestamp(),
        createdAtClientMs: now,
      });
      await updateDoc(doc(db, `stores/${storeId}/chatThreads/${threadId}`), {
        lastMessageText: CLOSING_SPIEL,
        lastMessageBy: "staff",
        lastMessageAtClientMs: now,
        unreadForStaff: 0,
        updatedAt: serverTimestamp(),
      });
      await notifyChatResponse(pendingCustomerMessageIds());
      await updateDoc(doc(db, `stores/${storeId}/chatThreads/${threadId}`), {
        status: "closed",
        closedAt: serverTimestamp(),
        closedByUid: appUser?.uid ?? null,
        closedByName: currentProfile?.name || appUser?.displayName || appUser?.name || null,
      });
      onClosed?.();
    } catch (e) {
      console.error("[ChatThreadPane] sendClosingAndEnd failed:", e);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <ScrollArea className="flex-1 px-3 py-3">
        <div className="space-y-2">
          {messages.map((m) => {
            const staff = m.sender === "staff";
            return (
              <div key={m.id} className={staff ? "flex justify-end" : "flex justify-start"}>
                <div className={cn(
                  "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                  staff ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted",
                )}>
                  {staff && m.staffName && <div className="text-[10px] font-semibold opacity-70 mb-0.5">{m.staffName}</div>}
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className="text-[10px] opacity-60 mt-0.5 text-right">{fmtStamp(m.createdAtClientMs)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {isClosed ? (
        <div className="border-t p-3 text-center text-xs text-muted-foreground">
          This chat is closed. A new message from the visitor reopens it under the Open tab.
        </div>
      ) : (
        <div className="border-t p-2 space-y-2">
          {onClosed && (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs"
              onClick={() => void sendClosingAndEnd()}
              disabled={sending}
            >
              <CheckCheck className="h-3.5 w-3.5 mr-1" /> Send closing message &amp; end chat
            </Button>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendReply(); } }}
              rows={1}
              maxLength={500}
              placeholder="Type a reply…"
              className="resize-none min-h-[40px] text-sm"
            />
            <Button size="icon" className="shrink-0" onClick={() => void sendReply()} disabled={sending || reply.trim().length === 0}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </>
  );
}

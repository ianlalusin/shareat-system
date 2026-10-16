import type { ChatThread } from "./chat-types";

/**
 * Reply-state helpers for the cashier chat surfaces.
 *
 * WHY THESE EXIST: the FAB badge used to be driven by `unreadForStaff`, which
 * is a READ counter — ChatInbox.openThread() and OnlineOrdersClient's thread
 * listener both zeroed it the moment a cashier *looked* at a thread, before any
 * reply existed. A customer who was read-but-never-answered therefore lost
 * every signal in the UI (badge, ping, bounce, and the 5-minute stale dot,
 * which is itself gated on unread > 0). That is how an open message goes missed.
 *
 * `lastMessageBy` is the authoritative reply-state instead: only an actual staff
 * reply flips it to "staff" (ChatThreadPane.sendReply / sendClosingAndEnd), so
 * merely opening a panel cannot clear it.
 */

/** A customer is waiting: the thread is open and the last word was theirs. */
export function threadNeedsReply(t: ChatThread): boolean {
  return t.status === "open" && t.lastMessageBy === "customer";
}

/**
 * An open thread whose last message was ours — nobody is blocked, but the
 * conversation is still live and worth a follow-up.
 *
 * Deliberately requires lastMessageBy === "staff" rather than "not customer":
 * the website creates order threads up front with no messages at all, and
 * PROGRESS.md pins the invariant that an untouched thread must never badge the
 * POS. A null lastMessageBy counts as neither red nor green.
 */
export function threadIsOpenFollowUp(t: ChatThread): boolean {
  return t.status === "open" && t.lastMessageBy === "staff";
}

/** RED counter: how many customers are waiting on us. */
export function countAwaitingReply(threads: ChatThread[]): number {
  return threads.filter(threadNeedsReply).length;
}

/** GREEN counter: how many live conversations are answered but still open. */
export function countOpenFollowUp(threads: ChatThread[]): number {
  return threads.filter(threadIsOpenFollowUp).length;
}

/**
 * Timestamp with a date attached, so a message left overnight cannot be
 * mistaken for one from an hour ago. Same-day keeps the bare clock to avoid
 * noise; anything older is explicitly dated.
 */
export function fmtStamp(ms?: number | null, now: number = Date.now()): string {
  if (!ms) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, today)) return time;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;

  const datePart = d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${datePart}, ${time}`;
}

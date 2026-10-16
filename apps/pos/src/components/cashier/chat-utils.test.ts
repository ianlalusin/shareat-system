import { describe, it, expect } from "vitest";
import {
  threadNeedsReply,
  threadIsOpenFollowUp,
  countAwaitingReply,
  countOpenFollowUp,
  fmtStamp,
} from "./chat-utils";
import type { ChatThread } from "./chat-types";

function thread(over: Partial<ChatThread> & { id: string }): ChatThread {
  return { customerName: "Test Customer", status: "open", createdAtClientMs: 0, ...over } as ChatThread;
}

describe("threadNeedsReply", () => {
  it("is true for an open thread whose last message came from the customer", () => {
    expect(threadNeedsReply(thread({ id: "a", lastMessageBy: "customer" }))).toBe(true);
  });

  it("REGRESSION: stays true even after unreadForStaff was zeroed by merely viewing", () => {
    // The exact missed-message shape: a cashier tapped the thread (which used
    // to write unreadForStaff: 0) and never replied.
    const viewedButUnanswered = thread({ id: "a", lastMessageBy: "customer", unreadForStaff: 0 });
    expect(threadNeedsReply(viewedButUnanswered)).toBe(true);
  });

  it("is false once staff replied", () => {
    expect(threadNeedsReply(thread({ id: "a", lastMessageBy: "staff" }))).toBe(false);
  });

  it("is false for a closed thread even if the customer spoke last", () => {
    expect(threadNeedsReply(thread({ id: "a", status: "closed", lastMessageBy: "customer" }))).toBe(false);
  });

  it("is false for a thread with no messages yet", () => {
    expect(threadNeedsReply(thread({ id: "a" }))).toBe(false);
  });
});

describe("threadIsOpenFollowUp", () => {
  it("is true for an open thread we answered last", () => {
    expect(threadIsOpenFollowUp(thread({ id: "a", lastMessageBy: "staff" }))).toBe(true);
  });

  it("is false when the customer is still waiting", () => {
    expect(threadIsOpenFollowUp(thread({ id: "a", lastMessageBy: "customer" }))).toBe(false);
  });

  it("is false for an untouched thread (website pre-creates order threads with no messages)", () => {
    expect(threadIsOpenFollowUp(thread({ id: "order_1", source: "order" }))).toBe(false);
  });

  it("is false once closed", () => {
    expect(threadIsOpenFollowUp(thread({ id: "a", status: "closed", lastMessageBy: "staff" }))).toBe(false);
  });
});

describe("counters", () => {
  const threads = [
    thread({ id: "waiting1", lastMessageBy: "customer" }),
    thread({ id: "waiting2", lastMessageBy: "customer", unreadForStaff: 0 }),
    thread({ id: "answered", lastMessageBy: "staff" }),
    thread({ id: "empty" }),
    thread({ id: "closed", status: "closed", lastMessageBy: "customer" }),
  ];

  it("counts conversations awaiting a reply, not messages", () => {
    expect(countAwaitingReply(threads)).toBe(2);
  });

  it("counts answered-but-open conversations for the green badge", () => {
    expect(countOpenFollowUp(threads)).toBe(1);
  });

  it("the two counters never double-count the same thread", () => {
    const overlap = threads.filter((t) => threadNeedsReply(t) && threadIsOpenFollowUp(t));
    expect(overlap).toEqual([]);
  });
});

describe("fmtStamp", () => {
  const now = new Date(2026, 8, 10, 14, 30).getTime(); // Sep 10 2026, 2:30pm

  it("returns empty for a missing timestamp", () => {
    expect(fmtStamp(null, now)).toBe("");
    expect(fmtStamp(0, now)).toBe("");
  });

  it("shows bare clock for today", () => {
    const out = fmtStamp(new Date(2026, 8, 10, 9, 5).getTime(), now);
    expect(out).not.toMatch(/Sep|Yesterday/);
    expect(out).toMatch(/9|09/);
  });

  it("labels yesterday explicitly", () => {
    expect(fmtStamp(new Date(2026, 8, 9, 9, 5).getTime(), now)).toMatch(/^Yesterday /);
  });

  it("dates an older message from the same year without the year", () => {
    const out = fmtStamp(new Date(2026, 7, 3, 9, 5).getTime(), now);
    expect(out).toMatch(/Aug/);
    expect(out).not.toMatch(/2026/);
  });

  it("includes the year for a message from a previous year", () => {
    const out = fmtStamp(new Date(2025, 11, 24, 9, 5).getTime(), now);
    expect(out).toMatch(/2025/);
  });

  it("REGRESSION: an overnight message is not mistaken for a fresh one", () => {
    const lastNight = new Date(2026, 8, 9, 22, 15).getTime();
    const thisAfternoon = new Date(2026, 8, 10, 13, 15).getTime();
    expect(fmtStamp(lastNight, now)).not.toBe(fmtStamp(thisAfternoon, now));
  });
});

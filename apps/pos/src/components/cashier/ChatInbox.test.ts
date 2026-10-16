import { describe, it, expect, vi } from "vitest";

/**
 * Pure-function tests for excludeOrderThreads().
 *
 * ChatInbox.tsx is a "use client" component that pulls in Firestore, React
 * contexts, Radix UI, and the kitchen-alert notification module — none of
 * which are needed to exercise the filter, and several of which blow up at
 * import time under vitest's node environment. Everything below is mocked
 * out purely so the module can be imported; the test itself only calls the
 * exported pure function.
 */

vi.mock("@/lib/firebase/client", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
}));

vi.mock("@/context/auth-context", () => ({ useAuthContext: () => ({ appUser: null }) }));
vi.mock("@/context/local-profile-context", () => ({ useLocalProfile: () => ({ currentProfile: null }) }));
vi.mock("@/components/global/confirm-dialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), Dialog: null }),
}));
vi.mock("@/lib/notifications/kitchenAlert", () => ({
  fireKitchenAlert: vi.fn(),
  primeKitchenAudio: vi.fn(),
}));
vi.mock("./ChatThreadPane", () => ({ ChatThreadPane: () => null }));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetHeader: () => null,
  SheetTitle: () => null,
  SheetDescription: () => null,
}));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: () => null }));

import { excludeOrderThreads } from "./ChatInbox";
import type { ChatThread } from "./chat-types";

function thread(over: Partial<ChatThread> & { id: string }): ChatThread {
  return {
    customerName: "Test Customer",
    status: "open",
    createdAtClientMs: 0,
    ...over,
  } as ChatThread;
}

describe("excludeOrderThreads", () => {
  it("drops a thread with source: 'order'", () => {
    const orderThread = thread({ id: "order_1", source: "order", orderId: "1" });
    expect(excludeOrderThreads([orderThread])).toEqual([]);
  });

  it("keeps a thread with no source field at all (regression: naive Firestore != would drop it)", () => {
    const legacyThread = thread({ id: "legacy_1" });
    expect("source" in legacyThread).toBe(false);
    expect(excludeOrderThreads([legacyThread])).toEqual([legacyThread]);
  });

  it("keeps a thread with source: 'walkin' (or any other non-order value)", () => {
    const walkinThread = thread({ id: "walkin_1", source: "walkin" });
    expect(excludeOrderThreads([walkinThread])).toEqual([walkinThread]);
  });

  it("preserves ordering of the surviving threads", () => {
    const a = thread({ id: "a" });
    const orderThread = thread({ id: "order_2", source: "order" });
    const b = thread({ id: "b", source: "walkin" });
    const c = thread({ id: "c" });

    expect(excludeOrderThreads([a, orderThread, b, c])).toEqual([a, b, c]);
  });
});

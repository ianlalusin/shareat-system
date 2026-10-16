import { describe, it, expect, vi } from "vitest";

/**
 * Pure-function tests for buildTrustSignal().
 *
 * OnlineOrdersClient.tsx is a "use client" component with heavy imports
 * (firebase client + firestore, auth/store contexts, several Radix-backed UI
 * primitives, ChatThreadPane) — none of which are needed to exercise the
 * trust-signal string builder, and several of which blow up at import time
 * under vitest's node environment. Everything below is mocked out purely so
 * the module can be imported; the test itself only calls the exported pure
 * function.
 */

vi.mock("@/lib/firebase/client", () => ({ db: {} }));

vi.mock("firebase/auth", () => ({
  getAuth: () => ({ currentUser: null }),
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  limit: vi.fn(),
  onSnapshot: vi.fn(),
  orderBy: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/context/auth-context", () => ({ useAuthContext: () => ({ user: null, appUser: null }) }));
vi.mock("@/context/store-context", () => ({ useStoreContext: () => ({ activeStore: null }) }));
vi.mock("@/hooks/useStoreConfigDoc", () => ({ useStoreConfigDoc: () => ({ config: null, isLoading: false, error: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/guards/RoleGuard", () => ({ RoleGuard: () => null }));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/admin/online-orders/OnlineAvailabilityControl", () => ({ OnlineAvailabilityControl: () => null }));
vi.mock("@/components/cashier/ChatThreadPane", () => ({ ChatThreadPane: () => null }));

vi.mock("@/components/ui/card", () => ({ Card: () => null, CardContent: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));
vi.mock("@/components/ui/label", () => ({ Label: () => null }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: () => null }));
vi.mock("@/components/ui/select", () => ({
  Select: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("@/components/ui/tabs", () => ({ Tabs: () => null, TabsList: () => null, TabsTrigger: () => null }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

import { buildTrustSignal } from "./OnlineOrdersClient";

describe("buildTrustSignal", () => {
  it("renders 'No phone on file' and ignores order/visit data when the phone is unparseable", () => {
    expect(
      buildTrustSignal({
        normalizedPhone: null,
        priorOrders: [{ status: "completed" }, { status: "completed" }],
        visitCount: 42,
      })
    ).toBe("No phone on file");
  });

  it("first order, known customer with dine-in visits", () => {
    expect(
      buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: 12 })
    ).toBe("First online order · 12 dine-in visits");
  });

  it("first order, known customer with exactly one dine-in visit (singular)", () => {
    expect(
      buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: 1 })
    ).toBe("First online order · 1 dine-in visit");
  });

  it("first order, unknown customer (no customers/{phone} doc)", () => {
    expect(
      buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: null })
    ).toBe("First online order · not a known customer");
  });

  it("Nth order shows completed/cancelled outcome counts, not the visit count", () => {
    expect(
      buildTrustSignal({
        normalizedPhone: "+639171234567",
        priorOrders: [
          { status: "completed" },
          { status: "completed" },
          { status: "completed" },
        ],
        visitCount: 5,
      })
    ).toBe("4th online order · 3 completed, 0 cancelled");
  });

  it("mixes completed and cancelled outcomes, and other statuses count toward the ordinal but not either bucket", () => {
    expect(
      buildTrustSignal({
        normalizedPhone: "+639171234567",
        priorOrders: [
          { status: "completed" },
          { status: "cancelled" },
          { status: "cancelled" },
          { status: "rejected" },
        ],
        visitCount: null,
      })
    ).toBe("5th online order · 1 completed, 2 cancelled");
  });

  it("uses correct ordinal suffixes across the 11th-13th exception range", () => {
    const priorOrders = Array.from({ length: 12 }, () => ({ status: "completed" }));
    expect(
      buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders, visitCount: null })
    ).toBe("13th online order · 12 completed, 0 cancelled");
  });

  // Three distinct visitCount states: a number (known visit count), null (a
  // genuine miss — the customers/{phone} read succeeded and no doc exists),
  // and undefined (the loyalty status is unknown — the read failed, or
  // hasn't completed yet). null and undefined must render DIFFERENT strings:
  // collapsing them back together would print "not a known customer" about
  // someone whose read simply failed, on the exact line a cashier uses to
  // decide whether to cook before payment.
  describe("visitCount tri-state (first order only — the only branch that reads it)", () => {
    it("number renders the dine-in visit count", () => {
      expect(
        buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: 7 })
      ).toBe("First online order · 7 dine-in visits");
    });

    it("null (successful read, no doc) renders 'not a known customer'", () => {
      expect(
        buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: null })
      ).toBe("First online order · not a known customer");
    });

    it("undefined (unknown/failed read) omits the loyalty clause entirely", () => {
      expect(
        buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: undefined })
      ).toBe("First online order");
    });

    it("null and undefined produce DIFFERENT strings", () => {
      const withNull = buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: null });
      const withUndefined = buildTrustSignal({ normalizedPhone: "+639171234567", priorOrders: [], visitCount: undefined });
      expect(withNull).not.toBe(withUndefined);
    });
  });
});

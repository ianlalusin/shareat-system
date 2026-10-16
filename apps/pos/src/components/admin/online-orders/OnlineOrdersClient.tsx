"use client";

import { useEffect, useMemo, useState } from "react";
import { getAuth } from "firebase/auth";
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { useStoreConfigDoc } from "@/hooks/useStoreConfigDoc";
import { useToast } from "@/hooks/use-toast";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, ShoppingBag, MapPin, Phone, Mail, Truck, Store as StoreIcon, MessageCircle, Settings2 } from "lucide-react";
import { computeOnlineAvailability, type OnlineAvailabilityInput } from "@/lib/storefront/online-hours";
import { OnlineAvailabilityControl } from "@/components/admin/online-orders/OnlineAvailabilityControl";
import { DeliveryAvailabilityControl } from "@/components/admin/online-orders/DeliveryAvailabilityControl";
import { DeliveryPricingSettings } from "@/components/admin/online-orders/DeliveryPricingSettings";
import { ChatThreadPane } from "@/components/cashier/ChatThreadPane";
import { ChatInbox } from "@/components/cashier/ChatInbox";
import { normalizePhone } from "@/lib/phone";
import { paymentLabel } from "@/lib/payment-label";

type Modifier = { groupName?: string; valueName?: string; priceDelta?: number };
type OrderLine = {
  productId: string;
  variantId?: string;
  name: string;
  unitPrice: number;
  qty: number;
  modifiers?: Modifier[];
  modifiersTotal?: number;
  lineTotal?: number;
  note?: string;
};
type OnlineOrder = {
  id: string;
  status: string;
  createdAtClientMs?: number;
  contact?: { name?: string; phone?: string | null; email?: string | null };
  fulfillment?: { type?: "pickup" | "delivery"; address?: string; addressNotes?: string; geo?: { lat: number; lng: number; accuracy?: number } | null };
  lines?: OrderLine[];
  subtotal?: number;
  deliveryFee?: number;
  grandTotal?: number;
  currency?: string;
  notes?: string | null;
  payment?: {
    method?: string;
    paid?: boolean;
    ref?: string;
    methodLabel?: string;
    settledAtMs?: number;
    confirmedByUid?: string;
    confirmedByName?: string;
    confirmedVia?: string;
  };
  receiptNumber?: string;
  statusHistory?: any[];
};

const peso = (n: number) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_LABEL: Record<string, string> = {
  pending_payment: "Awaiting payment",
  pending: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  ready_for_pickup: "Ready for pickup",
  out_for_delivery: "Out for delivery",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected",
  expired: "Expired",
};

type TabKey = "new" | "awaiting" | "active" | "completed" | "cancelled";
const TAB_STATES: Record<TabKey, string[]> = {
  new: ["pending"],
  awaiting: ["pending_payment"],
  active: ["accepted", "preparing", "ready", "ready_for_pickup", "out_for_delivery"],
  completed: ["completed"],
  cancelled: ["cancelled", "rejected", "expired"],
};

function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// Pure string-builder for the "trust signal" line shown above the action
// buttons. Kept side-effect-free (no hooks, no Firestore) so it is unit
// testable without dragging in the rest of this "use client" module.
export function buildTrustSignal(input: {
  normalizedPhone: string | null;
  priorOrders: { status: string }[];
  // number: the customer's dine-in visit count. null: the customers/{phone}
  // read SUCCEEDED and no such doc exists — a genuine "not a known customer"
  // miss. undefined: the loyalty status is unknown (the read failed, or
  // hasn't completed yet) — distinct from null, and must NOT be rendered as
  // if it were a miss.
  visitCount: number | null | undefined;
}): string {
  const { normalizedPhone, priorOrders, visitCount } = input;
  if (!normalizedPhone) return "No phone on file";

  const ordinal = priorOrders.length + 1;
  const orderLabel = ordinal === 1 ? "First online order" : `${ordinalSuffix(ordinal)} online order`;

  if (priorOrders.length === 0) {
    // Unknown loyalty status: omit the clause entirely rather than guessing.
    if (visitCount === undefined) return orderLabel;
    if (visitCount === null) return `${orderLabel} · not a known customer`;
    const visits = `${visitCount} dine-in visit${visitCount === 1 ? "" : "s"}`;
    return `${orderLabel} · ${visits}`;
  }

  const completed = priorOrders.filter((o) => o.status === "completed").length;
  const cancelled = priorOrders.filter((o) => o.status === "cancelled").length;
  return `${orderLabel} · ${completed} completed, ${cancelled} cancelled`;
}

// Available forward actions given the current status + fulfillment type.
function actionsFor(order: OnlineOrder): Array<{ to: string; label: string; needsReason?: boolean; variant?: "default" | "destructive" | "outline" }> {
  const isDelivery = order.fulfillment?.type === "delivery";
  switch (order.status) {
    case "pending":
      return [
        { to: "accepted", label: "Accept" },
        { to: "rejected", label: "Reject", needsReason: true, variant: "destructive" },
      ];
    case "accepted":
      return [
        { to: "preparing", label: "Start preparing" },
        { to: "cancelled", label: "Cancel", needsReason: true, variant: "outline" },
      ];
    case "preparing":
      return [
        { to: "ready", label: "Mark ready" },
        { to: "cancelled", label: "Cancel", needsReason: true, variant: "outline" },
      ];
    case "ready":
      return [
        isDelivery
          ? { to: "out_for_delivery", label: "Out for delivery" }
          : { to: "ready_for_pickup", label: "Ready for pickup" },
        { to: "completed", label: "Complete" },
        { to: "cancelled", label: "Cancel", needsReason: true, variant: "outline" },
      ];
    case "ready_for_pickup":
    case "out_for_delivery":
      return [
        { to: "completed", label: "Complete" },
        { to: "cancelled", label: "Cancel", needsReason: true, variant: "outline" },
      ];
    case "pending_payment":
      return [{ to: "cancelled", label: "Cancel", needsReason: true, variant: "outline" }];
    case "expired":
      // Cancel is deliberately not offered here — an expired order already
      // sits in the Cancelled tab.
      return [{ to: "pending", label: "Reopen order" }];
    default:
      return [];
  }
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "pending") return "default";
  if (["cancelled", "rejected", "expired"].includes(status)) return "destructive";
  if (status === "completed") return "secondary";
  return "outline";
}

export default function OnlineOrdersClient() {
  const { user, appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const { toast } = useToast();
  const storeId = activeStore?.id || "";
  // Both switches below are day-to-day on/off flips (close early, pause
  // delivery when no rider is around) — cashiers are allowed, same as the
  // server-side gate in the storefront-catalog route.
  const canToggleAvailability = appUser?.role === "admin" || appUser?.role === "manager" || appUser?.role === "cashier";
  const isManagerOrAbove = appUser?.role === "admin" || appUser?.role === "manager";

  const [orders, setOrders] = useState<OnlineOrder[]>([]);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("new");
  const [selected, setSelected] = useState<OnlineOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");

  // Payment-confirmation panel (Task 2 — "Payment received…").
  const [payConfirmOpen, setPayConfirmOpen] = useState(false);
  const [payMethodId, setPayMethodId] = useState("");
  const [payNote, setPayNote] = useState("");
  // "Un-mark as paid" panel — only ever offered before a receipt exists.
  const [unpayOpen, setUnpayOpen] = useState(false);
  const [unpayReason, setUnpayReason] = useState("");

  const { config: storeConfig } = useStoreConfigDoc(storeId);
  const activeModes = useMemo(
    () =>
      (storeConfig?.modesOfPayment ?? [])
        .filter((m) => m.isActive && !m.isArchived)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [storeConfig]
  );

  // Does an order-bound chat thread exist for the selected order? The website
  // creates the thread (deterministic id order_{orderId}), never the cashier —
  // ChatThreadPane.sendReply calls updateDoc on the thread doc, which throws
  // if it doesn't exist yet.
  //
  // This listener used to ALSO write `unreadForStaff: 0` whenever it saw a
  // non-zero count — meaning merely selecting an order card silently cleared
  // the customer's unread badge before anyone had replied. That is the same
  // read-state-as-reply-state bug that lost the Malvar message, in its most
  // aggressive form (no chat interaction required at all). The counter is now
  // cleared only by an actual reply, in ChatThreadPane's send paths.
  const [threadExists, setThreadExists] = useState<boolean | null>(null);
  useEffect(() => {
    if (!selected || !storeId) { setThreadExists(null); return; }
    const threadRef = doc(db, `stores/${storeId}/chatThreads/order_${selected.id}`);
    const unsub = onSnapshot(
      threadRef,
      (snap) => setThreadExists(snap.exists()),
      () => setThreadExists(false)
    );
    return () => unsub();
  }, [storeId, selected?.id]);

  // Red badge on an order's card while the customer is still awaiting a reply.
  // One listener for the whole collection (mirrors ChatInbox.tsx's pattern)
  // rather than one per card — cheaper, and consistent with how the site-wide
  // chat inbox already reads this same collection.
  const [unreadByOrderId, setUnreadByOrderId] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!storeId) { setUnreadByOrderId({}); return; }
    const unsub = onSnapshot(
      collection(db, `stores/${storeId}/chatThreads`),
      (snap) => {
        const map: Record<string, number> = {};
        snap.docs.forEach((d) => {
          const data = d.data() as any;
          const unread = Number(data?.unreadForStaff) || 0;
          // Reply-state, not read-state: an order whose last word was the
          // customer's keeps its badge until staff actually answers.
          if (unread <= 0 || data?.status !== "open" || data?.lastMessageBy !== "customer") return;
          const orderId =
            typeof data?.orderId === "string" && data.orderId
              ? data.orderId
              : d.id.startsWith("order_")
              ? d.id.slice("order_".length)
              : null;
          if (orderId) map[orderId] = unread;
        });
        setUnreadByOrderId(map);
      },
      () => {} // non-fatal — badges just won't show
    );
    return () => unsub();
  }, [storeId]);

  // Trust signal ("First online order · not a known customer", etc).
  // normalizedPhone / priorOrders are cheap, synchronous derivations from
  // state already in memory — no read involved. The customer's dine-in
  // visitCount is the only actual Firestore read, fired once per distinct
  // phone (not on every `orders` snapshot tick) and never allowed to break
  // the card — see the tri-state note on the state below for how a failed
  // read is kept distinct from a genuine miss.
  const normalizedPhone = selected ? normalizePhone(selected.contact?.phone || "") : null;
  const priorOrders = useMemo(() => {
    if (!selected || !normalizedPhone) return [];
    return orders
      .filter((o) => o.id !== selected.id && normalizePhone(o.contact?.phone || "") === normalizedPhone)
      .map((o) => ({ status: o.status }));
  }, [orders, selected, normalizedPhone]);

  // undefined = loyalty status unknown (not yet read, or the read failed);
  // null = read succeeded, no customers/{phone} doc exists; number = visit
  // count. The initial/loading state is undefined, never null, so a card
  // that hasn't finished reading never renders "not a known customer" as if
  // it were a confirmed fact.
  const [visitCount, setVisitCount] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!normalizedPhone) { setVisitCount(undefined); return; }
    let cancelled = false;
    setVisitCount(undefined);
    (async () => {
      try {
        const snap = await getDoc(doc(db, "customers", normalizedPhone));
        const vc = snap.exists() ? Number((snap.data() as any)?.visitCount ?? 0) : null;
        if (!cancelled) setVisitCount(vc);
      } catch (e) {
        console.error("[OnlineOrdersClient] customer lookup failed:", e);
        // A failed read is not the same fact as "no record exists" — leave
        // visitCount at undefined so the card omits the loyalty clause
        // instead of asserting a miss about someone who may be a regular.
        if (!cancelled) setVisitCount(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, [normalizedPhone]);

  const trustSignal = selected ? buildTrustSignal({ normalizedPhone, priorOrders, visitCount }) : null;

  // Online-ordering availability (the open/closed switch). Read live from the
  // store doc (every role may read it; stays correct across store-switches and
  // external edits). Admin/manager set it via the server set-availability op.
  const [avail, setAvail] = useState<OnlineAvailabilityInput>({});
  const [savingAvail, setSavingAvail] = useState(false);
  // Re-evaluate the schedule window so the live status flips at open/close time
  // even with no user action (only matters in "auto" mode).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!storeId) return;
    const unsub = onSnapshot(
      doc(db, "stores", storeId),
      (snap) => {
        const d = (snap.data() as any) || {};
        setAvail({
          acceptsOnlineOrders: d.acceptsOnlineOrders,
          onlineOrderMode: d.onlineOrderMode,
          onlineOrderManualOpen: d.onlineOrderManualOpen,
          openingTime: d.openingTime,
          closingTime: d.closingTime,
        });
      },
      () => {} // non-fatal: keep the last known value
    );
    return () => unsub();
  }, [storeId]);

  const availability = useMemo(
    () => computeOnlineAvailability(avail, new Date(nowTick)),
    [avail, nowTick]
  );

  // selectedMode is the picked control state (Auto / Open / Closed), distinct
  // from openNow which is what customers actually see right now.
  const selectedMode: "auto" | "open" | "closed" =
    availability.mode === "auto" ? "auto" : avail.onlineOrderManualOpen === false ? "closed" : "open";

  const setAvailability = async (mode: "auto" | "open" | "closed") => {
    if (savingAvail || !storeId || mode === selectedMode) return;
    setSavingAvail(true);
    const body =
      mode === "auto"
        ? { op: "set-availability", storeId, mode: "auto" }
        : { op: "set-availability", storeId, mode: "manual", manualOpen: mode === "open" };
    // optimistic (enrollment itself — acceptsOnlineOrders — is a separate
    // switch on the store-edit dialog now; this op never touches it)
    setAvail((p) => ({
      ...p,
      onlineOrderMode: mode === "auto" ? "auto" : "manual",
      onlineOrderManualOpen: mode === "auto" ? p.onlineOrderManualOpen : mode === "open",
    }));
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();
      const res = await fetch("/api/admin/storefront-catalog", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Update failed (${res.status})`);
      toast({
        title:
          mode === "auto"
            ? "Online ordering set to Auto"
            : mode === "open"
            ? "Store forced OPEN for online orders"
            : "Store forced CLOSED for online orders",
        description:
          mode === "auto"
            ? "It now opens and closes with the store's hours."
            : "Change reflects on the SharEat website within a minute.",
      });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not change availability", description: e?.message });
      // the live snapshot will re-sync the true state
    } finally {
      setSavingAvail(false);
    }
  };

  // Delivery pause switch — reads storefrontConfig/main.deliveryEnabled live.
  // Absent doc/field defaults to true (mirrors the website's opt-out default;
  // there is otherwise no admin UI at all that has ever written this field).
  const [deliveryEnabled, setDeliveryEnabledState] = useState(true);
  const [savingDelivery, setSavingDelivery] = useState(false);
  useEffect(() => {
    if (!storeId) return;
    const unsub = onSnapshot(
      doc(db, `stores/${storeId}/storefrontConfig/main`),
      (snap) => {
        const d = (snap.data() as any) || {};
        setDeliveryEnabledState(d.deliveryEnabled !== false);
      },
      () => {} // non-fatal: keep the last known value
    );
    return () => unsub();
  }, [storeId]);

  const setDeliveryEnabled = async (next: boolean) => {
    if (savingDelivery || !storeId || next === deliveryEnabled) return;
    setSavingDelivery(true);
    setDeliveryEnabledState(next); // optimistic
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();
      const res = await fetch("/api/admin/storefront-catalog", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "set-delivery-enabled", storeId, deliveryEnabled: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Update failed (${res.status})`);
      toast({
        title: next ? "Delivery resumed" : "Delivery paused",
        description: next
          ? "This branch is offering delivery again on the website."
          : "Pickup keeps working; delivery is hidden until you turn this back on.",
      });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not change delivery availability", description: e?.message });
      // the live snapshot will re-sync the true state
    } finally {
      setSavingDelivery(false);
    }
  };

  useEffect(() => {
    if (!storeId) return;
    setIsLoading(true);
    const q = query(collection(db, `stores/${storeId}/onlineOrders`), orderBy("createdAtClientMs", "desc"), limit(200));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setOrders(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
        setIsLoading(false);
      },
      (err) => {
        console.error(err);
        toast({ variant: "destructive", title: "Failed to load orders", description: err.message });
        setIsLoading(false);
      }
    );
    return () => unsub();
  }, [storeId, toast]);

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { new: 0, awaiting: 0, active: 0, completed: 0, cancelled: 0 };
    for (const o of orders) {
      for (const k of Object.keys(TAB_STATES) as TabKey[]) {
        if (TAB_STATES[k].includes(o.status)) c[k]++;
      }
    }
    return c;
  }, [orders]);

  const visible = useMemo(() => orders.filter((o) => TAB_STATES[tab].includes(o.status)), [orders, tab]);

  // Keep the open detail dialog in sync with live snapshots.
  useEffect(() => {
    if (!selected) return;
    const fresh = orders.find((o) => o.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [orders, selected]);

  const transition = async (order: OnlineOrder, toStatus: string, reason?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();
      const res = await fetch("/api/admin/online-orders", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "transition", storeId, orderId: order.id, toStatus, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Update failed (${res.status})`);
      const ticketNote =
        typeof json.ticketsCreated === "number" && (json.ticketsCreated > 0 || json.itemsSkipped > 0)
          ? ` — ${json.ticketsCreated} kitchen ticket${json.ticketsCreated === 1 ? "" : "s"} created` +
            (json.itemsSkipped > 0 ? `, ${json.itemsSkipped} item${json.itemsSkipped === 1 ? "" : "s"} skipped (no station configured)` : "")
          : "";
      toast({ title: `Order ${STATUS_LABEL[toStatus] || toStatus}${ticketNote}` });
      setReasonFor(null);
      setReasonText("");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Update failed", description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  // Mirrors transition() above: same fetch / Bearer-token / toast / error
  // pattern. Payment state is never written to Firestore directly from this
  // client — it always goes through this server op, which is the source of
  // truth for status revival on pending_payment/expired orders too. The live
  // order snapshot (see the effect above) re-renders `selected` afterward;
  // this function does not hand-patch local state.
  const confirmPayment = async (order: OnlineOrder, methodLabel: string, note: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();
      const res = await fetch("/api/admin/online-orders", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "confirm-payment", storeId, orderId: order.id, methodLabel, note }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Update failed (${res.status})`);
      toast({ title: "Payment confirmed", description: `Marked paid via ${methodLabel}.` });
      setPayConfirmOpen(false);
      setPayMethodId("");
      setPayNote("");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not confirm payment", description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  const unconfirmPayment = async (order: OnlineOrder, reason: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const u = user || getAuth().currentUser;
      if (!u) throw new Error("Not signed in.");
      const idToken = await u.getIdToken();
      const res = await fetch("/api/admin/online-orders", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ op: "unconfirm-payment", storeId, orderId: order.id, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Update failed (${res.status})`);
      toast({ title: "Payment un-marked" });
      setUnpayOpen(false);
      setUnpayReason("");
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not un-mark payment", description: e?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      <div className="container mx-auto py-6 space-y-6">
        <PageHeader title="Online Orders" description={`Website storefront orders${activeStore?.name ? ` · ${activeStore.name}` : ""}.`}>
          {storeId && (
            <OnlineAvailabilityControl
              availability={availability}
              selectedMode={selectedMode}
              canEdit={canToggleAvailability}
              saving={savingAvail}
              openingTime={avail.openingTime}
              closingTime={avail.closingTime}
              onSelect={setAvailability}
            />
          )}
          {storeId && (activeStore?.deliveryRadiusKm || 0) > 0 && (
            <DeliveryAvailabilityControl
              deliveryEnabled={deliveryEnabled}
              canEdit={canToggleAvailability}
              saving={savingDelivery}
              onToggle={setDeliveryEnabled}
            />
          )}
          {storeId && isManagerOrAbove && (
            <Button variant="outline" size="sm" onClick={() => setPricingOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" /> Delivery & Pricing
            </Button>
          )}
          <ShoppingBag className="h-6 w-6 text-muted-foreground" />
        </PageHeader>

        {!storeId ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground">Select a store to view its online orders.</CardContent></Card>
        ) : (
          <>
            <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
              <TabsList>
                {(Object.keys(TAB_STATES) as TabKey[]).map((k) => (
                  <TabsTrigger key={k} value={k} className="capitalize">
                    {k === "awaiting" ? "Awaiting payment" : k}
                    {counts[k] > 0 && <Badge variant="secondary" className="ml-2">{counts[k]}</Badge>}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : visible.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-muted-foreground">No orders here.</CardContent></Card>
            ) : (
              <div className="grid gap-3">
                {visible.map((o) => (
                  <Card key={o.id} className="cursor-pointer hover:border-primary/40 transition-colors" onClick={() => setSelected(o)}>
                    <CardContent className="flex items-center justify-between gap-4 py-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold truncate">{o.contact?.name || "Guest"}</span>
                          <Badge variant={statusBadgeVariant(o.status)}>{STATUS_LABEL[o.status] || o.status}</Badge>
                          {unreadByOrderId[o.id] > 0 && (
                            <Badge variant="destructive" className="inline-flex items-center gap-1">
                              <MessageCircle className="h-3 w-3" /> {unreadByOrderId[o.id]}
                            </Badge>
                          )}
                          {o.fulfillment?.type === "delivery" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Truck className="h-3 w-3" /> Delivery</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><StoreIcon className="h-3 w-3" /> Pickup</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {(o.lines?.length || 0)} item{(o.lines?.length || 0) === 1 ? "" : "s"}
                          {" · "}{o.payment?.paid ? `Paid · ${paymentLabel(o)}` : o.payment?.method === "paymongo" ? "Online (unpaid)" : "Pay on " + (o.fulfillment?.type === "delivery" ? "delivery" : "pickup")}
                          {o.createdAtClientMs ? ` · ${new Date(o.createdAtClientMs).toLocaleString("en-PH")}` : ""}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold">{peso(o.grandTotal || 0)}</div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setReasonFor(null);
            setReasonText("");
            setPayConfirmOpen(false);
            setPayMethodId("");
            setPayNote("");
            setUnpayOpen(false);
            setUnpayReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {selected.contact?.name || "Guest"}
                  <Badge variant={statusBadgeVariant(selected.status)}>{STATUS_LABEL[selected.status] || selected.status}</Badge>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="space-y-1">
                  {selected.contact?.phone && <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground" /> {selected.contact.phone}</div>}
                  {selected.contact?.email && <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-muted-foreground" /> {selected.contact.email}</div>}
                  <div className="flex items-center gap-2">
                    {selected.fulfillment?.type === "delivery" ? <Truck className="h-3.5 w-3.5 text-muted-foreground" /> : <StoreIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                    {selected.fulfillment?.type === "delivery" ? "Delivery" : "Pickup"}
                  </div>
                  {selected.fulfillment?.type === "delivery" && selected.fulfillment?.address && (
                    <div className="flex items-start gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5" /><span>{selected.fulfillment.address}{selected.fulfillment.addressNotes ? ` — ${selected.fulfillment.addressNotes}` : ""}</span></div>
                  )}
                  {selected.fulfillment?.type === "delivery" && selected.fulfillment?.geo && (
                    <a
                      href={`https://www.google.com/maps?q=${selected.fulfillment.geo.lat},${selected.fulfillment.geo.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary underline"
                    >
                      <MapPin className="h-3.5 w-3.5" /> View pinned location{selected.fulfillment.geo.accuracy ? ` (±${selected.fulfillment.geo.accuracy}m)` : ""}
                    </a>
                  )}
                </div>

                {selected.notes && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">
                    <span className="font-semibold">Customer note:</span> {selected.notes}
                  </div>
                )}

                <div className="rounded-md border divide-y">
                  {(selected.lines || []).map((ln, i) => (
                    <div key={i} className="flex justify-between gap-3 p-2">
                      <div className="min-w-0">
                        <div className="font-medium">{ln.qty}× {ln.name}</div>
                        {Array.isArray(ln.modifiers) && ln.modifiers.length > 0 && (
                          <div className="text-xs text-muted-foreground">{ln.modifiers.map((m) => m.valueName).filter(Boolean).join(", ")}</div>
                        )}
                        {ln.note && <div className="text-xs italic text-muted-foreground">“{ln.note}”</div>}
                      </div>
                      <div className="text-right whitespace-nowrap">{peso((ln.lineTotal ?? (ln.unitPrice + (ln.modifiersTotal || 0)) * ln.qty))}</div>
                    </div>
                  ))}
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{peso(selected.subtotal || 0)}</span></div>
                  {(selected.deliveryFee || 0) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Delivery fee</span><span>{peso(selected.deliveryFee || 0)}</span></div>}
                  <div className="flex justify-between font-semibold text-base"><span>Total</span><span>{peso(selected.grandTotal || 0)}</span></div>
                </div>

                <div className="rounded-md border p-3 space-y-2">
                  {selected.payment?.paid === true ? (
                    <>
                      <div className="font-medium">Paid · {paymentLabel(selected)}</div>
                      <div className="text-xs text-muted-foreground space-y-0.5">
                        {selected.payment?.confirmedByName && <div>Confirmed by {selected.payment.confirmedByName}</div>}
                        {selected.payment?.settledAtMs && <div>{new Date(selected.payment.settledAtMs).toLocaleString("en-PH")}</div>}
                        {selected.receiptNumber && <div>Receipt {selected.receiptNumber}</div>}
                      </div>
                      {!selected.receiptNumber && (
                        unpayOpen ? (
                          <div className="space-y-2 border-t pt-2">
                            <Textarea
                              value={unpayReason}
                              onChange={(e) => setUnpayReason(e.target.value)}
                              rows={2}
                              placeholder="Why are you un-marking this payment? (required)"
                            />
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setUnpayOpen(false); setUnpayReason(""); }}>Back</Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={busy || !unpayReason.trim()}
                                onClick={() => unconfirmPayment(selected, unpayReason.trim())}
                              >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline underline-offset-2"
                            onClick={() => setUnpayOpen(true)}
                          >
                            Un-mark as paid
                          </button>
                        )
                      )}
                    </>
                  ) : (
                    <>
                      <div className="font-medium">Not yet paid</div>
                      <div className="text-xs text-muted-foreground">
                        {selected.fulfillment?.type === "delivery" ? "Rider collects on delivery" : "Pay at counter"}
                      </div>
                      {payConfirmOpen ? (
                        <div className="space-y-2 border-t pt-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Where did the money land?</Label>
                            <Select value={payMethodId} onValueChange={setPayMethodId} disabled={busy || activeModes.length === 0}>
                              <SelectTrigger>
                                <SelectValue placeholder={activeModes.length === 0 ? "No modes configured" : "Select mode of payment"} />
                              </SelectTrigger>
                              <SelectContent>
                                {activeModes.map((m) => (
                                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {activeModes.length === 0 && (
                              <div className="text-xs text-destructive">No modes of payment configured for this store.</div>
                            )}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
                            <Textarea
                              value={payNote}
                              onChange={(e) => setPayNote(e.target.value.slice(0, 200))}
                              rows={2}
                              placeholder="Anything to remember"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Only tick this if you have seen the money in the wallet app itself. A screenshot is not proof.
                          </p>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => { setPayConfirmOpen(false); setPayMethodId(""); setPayNote(""); }}
                            >
                              Back
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy || !payMethodId || activeModes.length === 0}
                              onClick={() => {
                                const method = activeModes.find((m) => m.id === payMethodId);
                                if (!method) return;
                                confirmPayment(selected, method.name, payNote.trim());
                              }}
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setPayConfirmOpen(true)}>
                          Payment received…
                        </Button>
                      )}
                    </>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="text-sm font-medium">Conversation</div>
                  {threadExists ? (
                    <div className="flex h-[40vh] max-h-[40vh] flex-col overflow-hidden rounded-md border">
                      <ChatThreadPane storeId={storeId} threadId={`order_${selected.id}`} isClosed={false} />
                    </div>
                  ) : (
                    <div className="rounded-md border p-3 text-sm text-muted-foreground">
                      The customer hasn&apos;t started a chat for this order yet.
                    </div>
                  )}
                </div>

                {trustSignal && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                    <span>{trustSignal}</span>
                    {selected.status === "pending" && selected.payment?.paid !== true && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => transition(selected, "accepted")}
                      >
                        Accept &amp; start prep anyway
                      </Button>
                    )}
                  </div>
                )}

                {reasonFor ? (
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="text-sm font-medium">Reason for {STATUS_LABEL[reasonFor]?.toLowerCase()}</div>
                    <Textarea value={reasonText} onChange={(e) => setReasonText(e.target.value)} rows={2} placeholder="Required…" />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setReasonFor(null); setReasonText(""); }} disabled={busy}>Back</Button>
                      <Button variant="destructive" size="sm" disabled={busy || !reasonText.trim()} onClick={() => transition(selected, reasonFor, reasonText.trim())}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2 pt-1">
                    {actionsFor(selected).map((a) => (
                      <Button
                        key={a.to}
                        size="sm"
                        variant={a.variant || "default"}
                        disabled={busy}
                        onClick={() => (a.needsReason ? setReasonFor(a.to) : transition(selected, a.to))}
                      >
                        {busy && !a.needsReason ? <Loader2 className="h-4 w-4 animate-spin" /> : a.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {storeId && (
        <DeliveryPricingSettings storeId={storeId} open={pricingOpen} onClose={() => setPricingOpen(false)} />
      )}

      {activeStore?.id && <ChatInbox storeId={activeStore.id} />}
    </RoleGuard>
  );
}

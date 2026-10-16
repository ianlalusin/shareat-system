import type { ActivityLog } from "@/lib/types";

/**
 * The single place an `ActivityLog` becomes readable text.
 *
 * Two near-identical copies of this used to exist — one in the session timeline
 * drawer, one in the deleted session-audit hook — and they had drifted: the
 * drawer had finer-grained change-request types and better wording, the hook
 * knew how to pull a monetary amount out of `meta`. This is the union, and it is
 * the only copy. Anything rendering an activity log goes through it.
 *
 * Pure: no React, no Firestore, no formatting of dates.
 */

/**
 * Event vocabulary. These strings are consumed by the drawer's badge/icon/dot
 * maps, so they are a contract — renaming one changes three live screens.
 */
export type TimelineEventType =
  | "session"
  | "kitchen"
  | "refill_order"
  | "payment"
  | "billing"
  | "void"
  | "free"
  | "discount"
  | "adjustment"
  | "change_request"
  | "change_approval"
  | "change_rejection"
  | "customer";

export type DescribedLog = {
  type: TimelineEventType;
  title: string;
  detail?: string;
  /** Signed where the sign is meaningful (a discount delta); otherwise absolute. */
  amount?: number | null;
  /**
   * True when a caller that also walks the session document would render this
   * event twice. The drawer skips these; a raw audit list keeps them.
   */
  redundantWithSessionDoc?: boolean;
};

const peso = (n: unknown) => `₱${Number(n).toFixed(2)}`;

/** Short label for a table cell or badge — not a sentence. */
export function actionLabel(a: ActivityLog["action"] | string): string {
  switch (a) {
    case "SESSION_STARTED": return "Session Started";
    case "SESSION_VOIDED": return "Session Voided";
    case "SESSION_VERIFIED": return "Verified";
    case "SESSION_AUDIT_FLAGGED": return "Audit Flagged";
    case "SESSION_AUDIT_CLEARED": return "Audit Cleared";
    case "PAYMENT_COMPLETED": return "Payment";
    case "DISCOUNT_APPLIED": return "Discount Applied";
    case "DISCOUNT_REMOVED": return "Discount Removed";
    case "DISCOUNT_EDITED": return "Discount Edited";
    case "BILL_DISCOUNT_APPLIED": return "Bill Discount";
    case "BILL_DISCOUNT_REMOVED": return "Bill Disc. Removed";
    case "CUSTOM_CHARGE_ADDED": return "Charge Added";
    case "CUSTOM_CHARGE_REMOVED": return "Charge Removed";
    case "MARK_FREE": return "Marked Free";
    case "UNMARK_FREE": return "Unmarked Free";
    case "VOID_TICKETS": return "Void";
    case "UNVOID": return "Un-void";
    case "PRICE_OVERRIDE": return "Price Override";
    case "edit_line": return "Bill Edit";
    case "PACKAGE_QTY_OVERRIDE_SET": return "Qty Override";
    case "PACKAGE_QTY_RESYNC_APPROVED_CHANGE": return "Qty Synced";
    case "BUNDLE_EXTRA_PAX_SYNCED": return "Extra Pax Synced";
    case "ADDON_ADDED": return "Addon Added";
    case "REFILL_ADDED": return "Refill";
    case "GUEST_COUNT_REQUESTED": return "Guest Change Req";
    case "GUEST_COUNT_APPROVED": return "Guest Approved";
    case "GUEST_COUNT_REJECTED": return "Guest Rejected";
    case "PACKAGE_CHANGE_REQUESTED": return "Pkg Change Req";
    case "PACKAGE_CHANGE_APPROVED": return "Pkg Approved";
    case "PACKAGE_CHANGE_REJECTED": return "Pkg Rejected";
    case "TICKET_SERVED": return "Served";
    case "TICKET_CANCELLED": return "Cancelled";
    case "TICKET_BATCH_SERVED": return "Batch Served";
    case "TICKET_REMAINING_CANCELLED": return "Remaining Cancelled";
    case "RECEIPT_EDITED": return "Receipt Edited";
    case "RECEIPT_VOIDED": return "Receipt Voided";
    case "RECEIPT_REFUND": return "Refund";
    case "RECEIPT_DELETED": return "Receipt Deleted";
    case "CUSTOMER_PARTICIPANT_JOINED": return "Guest Joined";
    case "CUSTOMER_PARTICIPANT_REJOINED": return "Guest Rejoined";
    case "CUSTOMER_PARTICIPANT_REVOKED": return "Guest Revoked";
    case "CUSTOMER_PARTICIPANTS_RESET": return "Guests Reset";
    case "CUSTOMER_REQUEST_CREATED": return "Guest Request";
    case "CUSTOMER_REQUEST_COMPLETED": return "Request Done";
    default: return String(a).replace(/_/g, " ");
  }
}

/**
 * The monetary value a log represents, or null.
 *
 * `meta.delta` wins because a discount edit's value IS its delta and it is
 * signed; everything else is reported as written.
 */
export function logAmount(log: ActivityLog): number | null {
  const meta = (log.meta ?? {}) as any;
  if (typeof meta.delta === "number" && Number.isFinite(meta.delta)) return meta.delta;
  const raw =
    meta.amount ??
    meta.paymentTotal ??
    meta.refundAmount ??
    meta.total ??
    meta.snapshot?.total ??
    meta.snapshot?.analytics?.grandTotal;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function describeActivityLog(log: ActivityLog): DescribedLog {
  const meta = (log.meta ?? {}) as any;
  const qty = (log as any).qty ?? meta.qty;
  const qtyPrefix = typeof qty === "number" && qty > 0 ? `${qty}x ` : "";
  const itemName = meta.itemName ? String(meta.itemName) : "";
  const reason = log.reason || meta.reason || undefined;
  const amount = logAmount(log);

  switch (log.action) {
    // --- Session lifecycle -------------------------------------------------
    case "SESSION_STARTED":
      return {
        type: "session",
        title: "Session started",
        detail: [itemName, typeof meta.cashierGuestCount === "number" ? `${meta.cashierGuestCount} pax (cashier)` : null]
          .filter(Boolean).join(" · ") || undefined,
        redundantWithSessionDoc: true,
      };
    case "SESSION_VERIFIED":
      return {
        type: "session",
        title: `Session verified — ${meta.finalCount ?? meta.serverCount ?? "?"} guests`,
        detail: meta.verifyDurationMs != null
          ? `Took ${Math.round(Number(meta.verifyDurationMs) / 1000)}s to verify`
          : undefined,
      };
    case "SESSION_VOIDED":
      return { type: "void", title: "Session voided", detail: reason, amount };

    // --- Manager review ----------------------------------------------------
    case "SESSION_AUDIT_FLAGGED":
      return { type: "adjustment", title: "Session flagged for manager review", detail: reason };
    case "SESSION_AUDIT_CLEARED":
      return { type: "adjustment", title: "Session audit flag cleared", detail: reason };

    // --- Voids & comps -----------------------------------------------------
    case "VOID_TICKETS":
      return { type: "void", title: `Voided ${qtyPrefix}${itemName || "item"}`, detail: log.reason || undefined, amount };
    case "UNVOID":
      return { type: "adjustment", title: `Unvoided ${qtyPrefix}${itemName || "item"}`, detail: reason, amount };
    case "MARK_FREE":
      return {
        type: "free",
        title: `Marked ${qtyPrefix}${itemName || "item"} as free`,
        detail: meta.amount ? `${peso(meta.amount)} value` : reason,
        amount,
      };
    case "UNMARK_FREE":
      return { type: "adjustment", title: `Removed free from ${qtyPrefix}${itemName || "item"}`, detail: reason, amount };

    // --- Discounts & charges ----------------------------------------------
    case "DISCOUNT_APPLIED":
      return {
        type: "discount",
        title: `Discount applied${itemName ? ` to ${itemName}` : ""}`,
        detail: meta.discountName || meta.adjustmentName || reason,
        amount,
      };
    case "DISCOUNT_REMOVED":
      return {
        type: "discount",
        title: `Discount removed${itemName ? ` from ${itemName}` : ""}`,
        detail: log.note || meta.discountName || undefined,
        amount,
      };
    case "DISCOUNT_EDITED":
      return {
        type: "discount",
        title: "Discount edited",
        detail: [meta.discountName, typeof meta.delta === "number" ? `Delta ${peso(meta.delta)}` : null, log.note || reason]
          .filter(Boolean).join(" · ") || undefined,
        amount,
      };
    case "BILL_DISCOUNT_APPLIED":
      return { type: "discount", title: "Bill discount applied", detail: meta.discountName || log.note || undefined, amount };
    case "BILL_DISCOUNT_REMOVED":
      return { type: "discount", title: "Bill discount removed", detail: meta.discountName || undefined, amount };
    case "CUSTOM_CHARGE_ADDED":
      return { type: "adjustment", title: "Custom charge added", detail: log.note || reason, amount };
    case "CUSTOM_CHARGE_REMOVED":
      return { type: "adjustment", title: "Custom charge removed", detail: log.note || reason, amount };

    // --- Line-level billing edits -----------------------------------------
    case "PRICE_OVERRIDE":
      return { type: "adjustment", title: `Price override on ${itemName || "item"}`, detail: reason, amount };
    case "edit_line":
      return { type: "billing", title: `Bill line edited${itemName ? `: ${itemName}` : ""}`, detail: meta.diffSummary || reason, amount };
    case "PACKAGE_QTY_OVERRIDE_SET":
      return {
        type: "adjustment",
        title: `Package qty manually set to ${meta.afterQty ?? "?"}`,
        detail: meta.beforeQty != null ? `Was ${meta.beforeQty}` : undefined,
      };
    case "PACKAGE_QTY_RESYNC_APPROVED_CHANGE":
      return {
        type: "adjustment",
        title: `Package qty auto-synced to ${meta.afterQty ?? "?"}`,
        detail: meta.beforeQty != null ? `Was ${meta.beforeQty} (guest count approved)` : undefined,
      };
    case "BUNDLE_EXTRA_PAX_SYNCED":
      return {
        type: "billing",
        title: `Extra Pax synced to ${meta.afterQty ?? "?"}`,
        detail: meta.beforeQty != null ? `Was ${meta.beforeQty}` : log.note || undefined,
      };

    // --- Payment & receipt -------------------------------------------------
    case "PAYMENT_COMPLETED":
      return {
        type: "payment",
        title: `Payment completed${meta.paymentTotal ? ` — ${peso(meta.paymentTotal)}` : ""}`,
        detail: meta.receiptNumber ? `Receipt: ${meta.receiptNumber}` : undefined,
        amount,
      };
    case "RECEIPT_EDITED":
      return { type: "billing", title: "Receipt edited after close", detail: meta.diffSummary || log.note || reason, amount };
    case "RECEIPT_VOIDED":
      return {
        type: "void",
        title: meta.receiptNumber ? `Receipt ${meta.receiptNumber} voided` : "Receipt voided",
        detail: reason,
        amount,
      };
    case "RECEIPT_REFUND":
      return {
        type: "void",
        title: meta.receiptNumber ? `Receipt ${meta.receiptNumber} refunded` : "Receipt refunded",
        detail: reason,
        amount,
      };
    case "RECEIPT_DELETED":
      return {
        type: "void",
        title: meta.receiptNumber ? `Receipt ${meta.receiptNumber} deleted` : "Receipt deleted",
        detail: reason,
        amount,
      };

    // --- Kitchen -----------------------------------------------------------
    case "ADDON_ADDED":
      return { type: "kitchen", title: `Addon added: ${itemName}${qty ? ` (${qty}x)` : ""}`, detail: reason, amount };
    case "REFILL_ADDED":
      return { type: "refill_order", title: `Refill ordered: ${itemName}${qty ? ` (${qty}x)` : ""}`, detail: reason };
    case "TICKET_SERVED":
      return { type: "kitchen", title: `${itemName || "Item"} served` };
    case "TICKET_BATCH_SERVED":
      return { type: "kitchen", title: `${qtyPrefix}${itemName || "item"} served` };
    case "TICKET_CANCELLED":
      return { type: "void", title: `${itemName || "Kitchen ticket"} cancelled in kitchen`, detail: reason };
    case "TICKET_REMAINING_CANCELLED":
      return { type: "void", title: `Remaining ${itemName || "qty"} cancelled`, detail: reason };

    // --- Change requests ---------------------------------------------------
    case "GUEST_COUNT_REQUESTED":
      return {
        type: "change_request",
        title: `Guest count change requested → ${meta.newQty ?? "?"}`,
        detail: [meta.beforeQty != null ? `Was ${meta.beforeQty}` : null, reason].filter(Boolean).join(" · ") || undefined,
      };
    case "GUEST_COUNT_APPROVED":
      return { type: "change_approval", title: `Guest count change approved → ${meta.afterQty ?? "?"}` };
    case "GUEST_COUNT_REJECTED":
      return { type: "change_rejection", title: "Guest count change rejected", detail: reason };
    case "PACKAGE_CHANGE_REQUESTED":
      return { type: "change_request", title: "Package change requested", detail: itemName || log.note || reason };
    case "PACKAGE_CHANGE_APPROVED":
      return { type: "change_approval", title: "Package changed", detail: itemName || log.note || undefined };
    case "PACKAGE_CHANGE_REJECTED":
      return { type: "change_rejection", title: "Package change rejected", detail: reason };

    // --- Customer app ------------------------------------------------------
    case "CUSTOMER_PARTICIPANT_JOINED":
      return { type: "customer", title: `Guest ${meta.slotNumber ?? ""} joined`.replace(/\s+/g, " ").trim(), detail: meta.joinMethod === "qr" ? "QR scan" : "Manual PIN" };
    case "CUSTOMER_PARTICIPANT_REJOINED":
      return { type: "customer", title: `Guest ${meta.slotNumber ?? ""} rejoined`.replace(/\s+/g, " ").trim() };
    case "CUSTOMER_PARTICIPANT_REVOKED":
      return { type: "customer", title: `Guest ${meta.slotNumber ?? ""} access revoked`.replace(/\s+/g, " ").trim(), detail: reason };
    case "CUSTOMER_PARTICIPANTS_RESET":
      return { type: "customer", title: "Guest devices reset", detail: reason };
    case "CUSTOMER_REQUEST_CREATED":
      return { type: "customer", title: `Guest requested ${itemName || "something"}`, detail: log.note || undefined };
    case "CUSTOMER_REQUEST_COMPLETED":
      return { type: "customer", title: `Guest request completed${itemName ? `: ${itemName}` : ""}` };

    default:
      // Never render SCREAMING_SNAKE at a user.
      return { type: "adjustment", title: actionLabel(log.action), detail: log.note || reason, amount };
  }
}

// --- Export/table formatting -------------------------------------------------
// Used by the Day Review XLSX export. Kept here so the deleted /logs page's
// column set survives verbatim.

export function formatLogAmount(log: ActivityLog): string {
  const meta = (log.meta || {}) as any;

  if (typeof meta.delta === "number" && Number.isFinite(meta.delta)) {
    const sign = meta.delta >= 0 ? "+" : "-";
    return `${sign} ₱${Math.abs(meta.delta).toFixed(2)}`;
  }

  const amount = meta.amount ?? meta.paymentTotal ?? meta.discountValue ?? meta.total ?? undefined;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    let sign = "";
    if (log.action.includes("VOID") || log.action === "MARK_FREE" || log.action === "DISCOUNT_APPLIED") {
      sign = "- ";
    } else if (log.action === "DISCOUNT_REMOVED" || log.action === "UNMARK_FREE") {
      sign = "+ ";
    }
    return `${sign}₱${Math.abs(amount).toFixed(2)}`;
  }

  return "—";
}

export function formatLogDescription(log: ActivityLog): string {
  const meta = (log.meta ?? {}) as any;

  if (log.action === "PAYMENT_COMPLETED") {
    return `Paid via ${Object.keys(meta.mopSummary || {}).join(", ")}`;
  }
  if (log.action === "SESSION_STARTED") {
    const pkg = meta.itemName as string | undefined;
    const pax = meta.cashierGuestCount ?? meta.qty;
    if (pkg || typeof pax === "number") {
      const parts: string[] = [];
      if (pkg) parts.push(pkg);
      if (typeof pax === "number") parts.push(`${pax} pax (cashier)`);
      return parts.join(" · ");
    }
    return log.note || "Session created by cashier.";
  }
  if (log.action === "SESSION_VOIDED" || log.action === "RECEIPT_VOIDED") {
    return `Session voided. Reason: ${log.reason || meta.reason || "N/A"}`;
  }

  const qtyNum =
    typeof meta.qty === "number" ? meta.qty :
    typeof meta.quantity === "number" ? meta.quantity :
    typeof meta.qtyChanged === "number" ? meta.qtyChanged :
    undefined;

  const qty = typeof qtyNum === "number" && qtyNum > 0 ? `${qtyNum}x ` : "";
  const item = "itemName" in meta ? `${meta.itemName}` : "";
  const reason = log.reason || log.note ? ` - Reason: ${log.reason || log.note}` : "";

  return `${qty}${item}${reason}`;
}

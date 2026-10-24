
import { Timestamp } from "firebase/firestore";

export type UserRole = 'admin' | 'manager' | 'cashier' | 'kitchen' | 'server' | 'pending';

/** Full ID belongs only to the open session and receipt; closed copies omit normalization. */
export interface StatutoryDiner {
  id: string;
  kind: 'senior' | 'pwd';
  name: string;
  idNo: string;
  idNoNormalized?: string;
  addedByUid: string;
  addedAtClientMs: number;
  dishLineIds: string[];
}

export interface User {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL?: string | null;
  role: UserRole;
}

export interface Session {
  user: User | null;
  loading: boolean;
}

export interface UserDocument {
    displayName: string;
    email: string;
    role: UserRole;
    photoURL?: string;
}

export type Product = {
  id: string;
  name: string;

  // Variant label for single-kind products. The display name is "name (variant)"
  // when set. Distinct from `description`; see comment below. Legacy callers used
  // this field for free-text notes — kept for backward compat via the dialog UI.
  variant?: string;

  // Free-text description / notes shown to staff in the editor. NOT used as a
  // variant label or appended to the display name.
  description?: string;

  // New Variant Management
  kind?: "single" | "group" | "variant";
  groupId?: string | null;
  groupName?: string | null;
  variantLabel?: string | null;
  isSku?: boolean;

  // Modifier / option group references. Order at attach time; the cashier
  // and the customer modifier pickers iterate in this order.
  //
  // A variant INHERITS its family parent's groups and may attach its own on
  // top — the two are UNIONED, never replaced. A store may also attach extra
  // groups for itself on its inventory row without touching this global doc,
  // which every branch shares. `resolveOptionGroupIds`
  // (lib/server/catalog-shared.ts) is the one place that rule lives, and the
  // cashier picker, the storefront and the customer app all defer to it.
  optionGroupIds?: string[];

  category: string;
  subCategory?: string;
  uom: string;
  barcode?: string;
  imageUrl?: string;
  isActive: boolean;
  /**
   * Soft-deleted. Archiving auto-deactivates the product and pins it into the
   * bottom-most "Archived" group on /admin/menu/products. Archived products
   * never appear in the cashier addon picker. Restoring clears both flags via
   * the restore action.
   */
  isArchived?: boolean;
  /**
   * RETIRED — do not reintroduce. Online availability used to be a single
   * global flag here, which meant only an admin could decide what any store
   * sold online, for every store at once. It is now per-branch and opt-in on
   * the store's own inventory record: see InventoryItem.onlineEnabled. The
   * field may still exist on old product documents; nothing reads it.
   */
  showOnStorefront?: never;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProductRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

/**
 * "addon"   -> on approval the requesting store's inventory record gets
 *              isAddon: true, so it shows in the cashier add-ons modal.
 * "product" -> imported as a plain inventory item (isAddon: false).
 *
 * This lives on the REQUEST only. The created Product doc is identical either
 * way — add-on-ness is a per-store inventory flag, not a catalog property.
 */
export type ProductRequestKind = "addon" | "product";

/**
 * A manager's application to add a new item to the GLOBAL product catalog.
 *
 * Managers cannot write `products` (firestore.rules restricts it to isAdmin()),
 * so the whole lifecycle is server-mediated through POST /api/product-requests.
 * On approval the product is created, auto-imported into the requesting store at
 * the suggested price, and becomes importable by every other store through the
 * existing /manager/inventory -> "Add Products to Inventory" picker.
 *
 * The document is the audit record: writeActivityLog is session-scoped and
 * cannot be used here, so requester/reviewer/timestamps all persist on the doc,
 * which is immutable from the client.
 */
export type ProductRequest = {
  id: string;
  status: ProductRequestStatus;
  requestKind: ProductRequestKind;

  // ---- Proposed catalog definition (mirrors the admin product form) -------
  name: string;
  /** Single-axis variant label, e.g. "Large". Maps to Product.variant. */
  variant?: string | null;
  description?: string | null;
  /** Free-text sub-category; mirrored into addonCategories/{slug} on approval. */
  subCategory?: string | null;
  /** Already passed through normalizeUom() server-side. */
  uom: string;
  barcode?: string | null;
  /**
   * Uploaded to productRequestImages/{requestId}/... before submit. Copied
   * verbatim onto products.imageUrl on approval — the file is never moved to
   * the canonical Items/ path.
   *
   * Deliberately NOT copied onto the auto-imported inventory row:
   * `inventory.imageUrl` is a pure per-store override where null means "show
   * the global photo", and every display surface resolves
   * `inventoryItem.imageUrl ?? product.imageUrl`. See /api/product-requests.
   */
  imageUrl?: string | null;

  /**
   * slugify(`${name} ${variant ?? ""}`). Computed SERVER-SIDE, never trusted
   * from the client. The sole duplicate-protection key.
   */
  nameKey: string;

  // ---- Requesting store's activation intent ------------------------------
  storeId: string;
  /** Denormalized so the admin queue needs no per-row store lookup. */
  storeName: string;
  /**
   * Suggested price for the requesting store only. The admin never sets a
   * global price; every other store sets its own when it imports.
   */
  suggestedPrice: number;
  cost?: number;
  /**
   * Kitchen station in the REQUESTING store. Required when
   * requestKind === "addon": inventory.isAddon cannot be enabled without a
   * price > 0 AND a kitchenLocationId (see /manager/inventory handleToggle).
   */
  kitchenLocationId?: string | null;
  kitchenLocationName?: string | null;
  /** Why this store needs it — shown to the reviewing admin. */
  justification?: string | null;

  // ---- Requester ---------------------------------------------------------
  requestedByUid: string;
  requestedByName: string;
  requestedAt: Timestamp;

  // ---- Review ------------------------------------------------------------
  /**
   * A single reviewer triple rather than the separate `approvedBy` / `rejectedBy`
   * field pairs used by guestCountChange: `status` already records the outcome,
   * and a request is only ever decided once.
   */
  reviewedByUid?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: Timestamp | null;
  /** Admin's message. Required on reject — that is the manager's feedback. */
  reviewNote?: string | null;

  // ---- Approval result ---------------------------------------------------
  /** products/{id} created by the approve op. The link back to the catalog. */
  approvedProductId?: string | null;
  /** Outcome of the auto-import into the requesting store. */
  autoActivation?: "activated" | "activated_without_addon" | null;
  /** Set when autoActivation !== "activated": the exact fix the manager needs. */
  autoActivationNote?: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProductPhotoStatus = "pending" | "approved" | "rejected";

/**
 * A manager's local photo upload for an item at their store, awaiting (or
 * having received) an admin decision on whether to promote it to be the
 * item's photo for every store. See
 * docs/superpowers/specs/2026-08-12-item-photo-local-global-design.md.
 *
 * id is `${storeId}_${productId}` — deterministic, so there is at most one
 * active request per (store, product) pair; resubmitting overwrites it
 * rather than accumulating history.
 */
export type ProductPhotoRequest = {
  id: string;
  storeId: string;
  storeName: string;
  productId: string;
  productName: string;
  status: ProductPhotoStatus;
  imageUrl: string;
  submittedByUid: string;
  submittedByName: string;
  submittedAt: Timestamp;
  reviewedByUid?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: Timestamp | null;
};

/**
 * A reusable, global option group attached to one or more Products.
 * At order time the cashier and customer modifier pickers iterate the
 * groups attached to the chosen product and let the user pick from each
 * group's `values`. Selected values become `modifiers[]` on the bill line
 * and kitchen ticket, each contributing its `priceDelta` to the line total.
 *
 * Examples:
 *   { name: "Cheese", selectionMode: "multi", values: [
 *     { name: "Extra Cheese", priceDelta: 20 },
 *     { name: "No Cheese", priceDelta: 0 },
 *   ]}
 *   { name: "Size", selectionMode: "single", required: true, values: [
 *     { name: "Small", priceDelta: 0 },
 *     { name: "Large", priceDelta: 40 },
 *   ]}
 */
export type OptionGroupValue = {
  id: string;            // stable; survives renames; used in receipts/analytics
  name: string;
  priceDelta: number;    // peso amount, signed; 0 is the default
  isActive: boolean;
  sortOrder: number;
};

export type OptionGroup = {
  id: string;
  name: string;
  selectionMode: "single" | "multi";
  required: boolean;       // single: must pick a value; multi: requires >= minSelections
  minSelections?: number;  // multi only
  maxSelections?: number;  // multi only; undefined = unlimited
  values: OptionGroupValue[];
  isActive: boolean;
  isArchived?: boolean;
  createdAt: any;
  updatedAt: any;
};

export type InventoryItem = {
  id: string;
  productId: string;
  name: string;
  variantLabel?: string | null;
  /**
   * Family / variant metadata mirrored from the underlying Product.
   * Populated by the merge endpoint and the sync-inventory backfill so the
   * cashier addons picker can group variants under their family without
   * an extra Product read per addon. See:
   *  - /api/admin/products/merge
   *  - /api/admin/products/sync-inventory-from-products
   */
  kind?: "single" | "group" | "variant";
  groupId?: string | null;
  groupName?: string | null;
  category?: string;
  subCategory?: string;
  uom: string;
  barcode?: string | null;
  imageUrl?: string | null;
  cost: number;
  sellingPrice: number;
  taxId?: string;
  isActive: boolean;
  isAddon?: boolean;
  isArchived?: boolean;
  /**
   * Per-branch online availability, and the ONLY gate on what the public
   * storefront sells (the global products/{id}.showOnStorefront flag was
   * retired in favour of this). Opt-in: only an explicit `true` publishes the
   * item at this store, so a store's internal inventory cannot reach the
   * public menu by default. Never affects dine-in — an item withheld online
   * is still sold at the table.
   */
  onlineEnabled?: boolean;
  /**
   * Per-branch online price, in pesos. NEVER used by the cashier, receipts,
   * analytics or dine-in — it exists so delivery/packaging cost can be priced
   * in without moving the table price.
   *
   * Three states, and 0 is not the same as blank:
   *   unset (missing/null) → charge the same as sellingPrice;
   *   positive number      → charge that instead;
   *   0 or negative        → WITHHOLD the item from the storefront. It does
   *                          not fall back — an item priced 0 online is one
   *                          nobody has finished pricing, so it stays off the
   *                          public menu even while onlineEnabled is true.
   */
  onlinePrice?: number | null;
  /**
   * Per-branch availability on the CUSTOMER app, mirroring `onlineEnabled`'s
   * opt-in gate — only an explicit `true` publishes the item at this store.
   * Never affects dine-in or the public storefront. Unlike online, there is
   * no separate customer-app price: it always charges `sellingPrice`, so the
   * two can never drift apart.
   */
  customerEnabled?: boolean;
  /**
   * Modifier groups THIS STORE attaches, on top of whatever the global product
   * already gives the item.
   *
   * Unioned with the product's (and, for a variant, its family parent's) by
   * `resolveOptionGroupIds` — never a replacement. This exists so a branch can
   * offer a modifier the others don't without an admin editing `products`,
   * which every branch shares. It is the additive counterpart to
   * `optionOverrides`, which can only take groups AWAY for one store.
   */
  optionGroupIds?: string[];
  kitchenLocationId?: string | null;
  kitchenLocationName?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type Flavor = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type Package = {
  id: string;
  name: string;
  allowedRefillIds?: string[];
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type Refill = {
  id: string;
  name: string;
  requiresFlavor: boolean;
  allowedFlavorIds?: string[];
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
export type StorePackage = {
    packageId: string;
    packageName: string;
    isEnabled: boolean;
    pricePerHead: number;
    kitchenLocationId: string | null;
    kitchenLocationName: string | null;
    refillsAllowed: string[];
    flavorsAllowed: string[];
    sortOrder: number;
    menuScheduleId: string | null;
    /**
     * Bundle package: billed as a single flat-priced unit covering the first
     * `bundleMaxCap` guests. When true, billing uses `bundlePrice` (qty 1)
     * instead of `pricePerHead × guestCount`, but the entered headcount still
     * drives PIN slots, covers, kitchen prep, and guest analytics.
     */
    isBundle?: boolean;
    /** Flat price for the whole bundle (used when `isBundle`). */
    bundlePrice?: number;
    /**
     * How many guests the flat `bundlePrice` covers ("good for N pax").
     *
     * This is a BILLING threshold, never a seating limit — a party may exceed it
     * freely, and the excess is billed via `bundleExtraHeadPrice`. Nothing in the
     * app may clamp a headcount to this value.
     */
    bundleMaxCap?: number;
    /**
     * Per-head price for guests beyond `bundleMaxCap`, billed on a separate
     * "Extra Pax" line. 0 or unset means those guests are included at no charge.
     */
    bundleExtraHeadPrice?: number;
};

export type StoreFlavor = {
    flavorId: string,
    flavorName: string, // denormalized
    isEnabled: boolean,
    sortOrder: number,
}

export type StoreRefill = {
    refillId: string,
    refillName: string, // denormalized
    isEnabled: boolean,
    sortOrder: number,
    kitchenLocationId: string | null;
    kitchenLocationName: string | null;
    flavorsAllowed?: string[] | null;
    isOther?: boolean; // shows under "Other Refills" steppers
    menuScheduleId?: string | null;
};

export type KitchenLocation = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /**
   * Per-station serve-time SLA in minutes. The KDS ages each active ticket
   * against this and flags ones running late. Absent → falls back to a global
   * default. See the kitchen page's slow-ticket alerting.
   */
  slaMinutes?: number;
  /** When true, this location's tickets print to the shared Bluetooth kitchen
   *  printer during an internet outage (offline backup). Absent → false. */
  printOnOutage?: boolean;
};

/**
 * Forward booking. Lives at stores/{storeId}/reservations/{id} and is managed
 * from the dedicated /reservations page. The SHAREAT website writes into the
 * same collection with source:"website". When a party is seated, the
 * reservation links to the created cashier session via sessionId.
 */
/**
 * Cash handover / till log. Lives at stores/{storeId}/cashHandovers/{id} and is
 * recorded from /cashier/handover at shift change. Purely a log for
 * accountability — inventory/accounting truth lives in the ERP. expectedCash =
 * startingCash + cashSales + convertNet + manualCashAdjustment − deductionsTotal − cashRefunds; variance = countedCash −
 * expectedCash.
 */
export type CashHandoverDeduction = {
  id: string;
  amount: number;
  reason: string;
  encodedByUid?: string | null;
  encodedByName?: string | null;
  createdAtClientMs: number;
};

export type CashHandover = {
  id: string;
  shiftDayId: string;
  periodStartMs: number;
  periodEndMs: number;
  startingCash: number;
  cashSales: number;
  /** T-427 additive fields; absent on older handovers. */
  convertNet?: number;
  /** Bible row 391: cash paid back for refunds in the window; subtracted from expectedCash. Absent on older handovers. */
  cashRefunds?: number;
  manualCashAdjustment?: number;
  manualCashAdjustmentReason?: string | null;
  periodStartExclusive?: boolean;
  deductions: CashHandoverDeduction[];
  deductionsTotal: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  outgoingCashierName: string;
  incomingCashierName: string;
  notes?: string | null;
  createdAt?: Timestamp | null;
  createdAtClientMs: number;
  createdByUid?: string | null;
  createdByName?: string | null;
};

export type ReservationStatus = "booked" | "confirmed" | "seated" | "cancelled" | "no_show" | "handled";

export type ReservationEventType =
  | "created" | "edited" | "confirmed" | "seated" | "cancelled" | "no_show" | "handled"
  | "payment_recorded" | "payment_voided" | "payments_applied";

export type ReservationEvent = {
  at: number;              // client ms when the event occurred
  type: ReservationEventType;
  byUid?: string | null;
  byName?: string | null;  // local-user/staff name (or null for website)
  note?: string | null;    // e.g. summary of an edit
};

export type ReservationPayment = {
  id: string;
  methodId: string;                 // refs ModeOfPayment.id
  methodName: string;               // snapshot at log time
  amount: number;
  reference?: string | null;        // required when the method's hasRef === true
  label?: string | null;            // free-text e.g. "Reservation fee", "Ocular deposit"
  note?: string | null;
  recordedAt: Timestamp;
  recordedAtClientMs: number;
  recordedByUid?: string | null;
  recordedByName?: string | null;
  voidedAt?: Timestamp | null;
  voidedAtClientMs?: number | null;
  voidedByUid?: string | null;
  voidedByName?: string | null;
  voidReason?: string | null;
};

export type Reservation = {
  id: string;
  customerName: string;
  phone?: string | null;
  partySize: number;
  reservedForMs: number;          // exact date+time of the booking
  reservedForDayId: string;       // YYYYMMDD (Asia/Manila), for day filtering
  tableId?: string | null;        // optional pre-assignment
  tableNumber?: string | null;
  status: ReservationStatus;
  source: "pos" | "website";
  sessionId?: string | null;      // set when seated
  notes?: string | null;
  createdAt?: Timestamp | null;
  createdAtClientMs: number;
  createdByUid?: string | null;
  createdByName?: string | null;
  history?: ReservationEvent[];   // lifecycle log: booked → … → seated
  updatedAt?: Timestamp | null;
  // Multi-entry payment log (reservation fee, ocular deposits, etc.).
  // Voided entries are kept in place with voidedAt set — never spliced out.
  payments?: ReservationPayment[];
  // Set by the Pay modal when reservation payments are applied to a session,
  // so re-opening the modal on the same session doesn't double-apply.
  paymentsAppliedToSessionId?: string | null;
};

export type MenuSchedule = {
  id: string;
  name: string;
  isActive?: boolean;
  isArchived?: boolean;
  days?: string[];
  startTime?: string;
  endTime?: string;
  timezone?: string;
};

export type OrderItemStatus = "preparing" | "ready" | "served" | "cancelled" | "void" | "partially_served";

export type OrderItemType = "package" | "refill" | "addon";

export type KitchenTicket = {
    id: string;
    // A ticket has exactly one of sessionId (dine-in) or onlineOrderId
    // (online order) set, never both. tableId/tableNumber/guestCount are
    // dine-in-only and stay unset for an online-order ticket.
    sessionId?: string;
    onlineOrderId?: string;
    storeId: string;
    tableId?: string;
    tableNumber?: string;
    type: OrderItemType;
    itemId?: string;
    itemName: string;
    guestCount?: number;
    status: OrderItemStatus;
    kitchenLocationId: string;
    kitchenLocationName?: string;
    notes?: string;
    // Flavor selection display line, kept separate from `notes` on purpose —
    // they render in two different places on the KDS card (a compact "📝
    // Flavors: …" flag vs. the full "Notes" box) and must never show the same
    // text twice. Plain string (not the array-based initialFlavorNames used
    // by package tickets), since refill tickets don't go through the
    // session-based flavor-name enrichment package tickets use.
    flavorNote?: string;
    // ---- Diner self-ordering (CUSTOMER app) ----------------------------------
    // Set only on tickets a diner placed from their own phone. Such a ticket
    // carries NO bill line until the kitchen serves it: `billLineId` stays null
    // and `pendingBillLine` holds everything needed to create the line at that
    // point. See src/lib/kitchen/customer-order-billing.ts for the contract and
    // why cancelling one of these must never void bill quantity.
    /** "customer_app" when the diner placed this themselves. */
    source?: string | null;
    /** Marks a ticket whose bill line is created on serve, not on order. */
    billOnServe?: boolean;
    /** The line to create/increment on serve. Shape: PendingBillLine. */
    pendingBillLine?: Record<string, any> | null;
    /** Stamped the first time this ticket put quantity on the bill. */
    billedAtClientMs?: number;
    qty: number;
    uom?: string;
    createdByUid: string;
    createdAt: any;
    createdAtClientMs?: number;
    updatedAt?: any;
    preparedByUid?: string | null;
    preparedAt?: any | null;
    servedByUid?: string | null;
    servedAt?: any | null;
    servedAtClientMs?: number;
    servedCounted?: boolean;
    cancelledByUid?: string | null;
    cancelledAt?: any | null;
    cancelReason?: string;
    cancelledAtClientMs?: number;
    durationMs?: number;
    initialFlavorIds?: string[];
    initialFlavorNames?: string[];
    sessionMode?: 'package_dinein' | 'alacarte';
    customerName?: string | null;
    sessionLabel?: string;
    orderedByRole?: UserRole | null;
    billLineId?: string; // Link to SessionBillLine
    // --- Batch-serve fields (addon tickets only) ---
    qtyOrdered?: number;    // total qty ordered (e.g. 80)
    qtyServed?: number;     // cumulative qty served across all batches
    qtyCancelled?: number;  // qty cancelled
    qtyRemaining?: number;  // qtyOrdered - qtyServed - qtyCancelled
    /**
     * One entry per batch serve. Written by `handleServeBatch` in the KDS —
     * note `servedAt` is a plain epoch-ms number here, not a Timestamp, and the
     * actor is carried as a server *profile*, not a staff name.
     */
    serveLog?: {
      qty: number;
      servedAt: number;
      servedAtClientMs: number;
      servedByUid: string;
      servedByProfileId?: string | null;
      servedByProfileName?: string | null;
    }[];
    refillRequest?: {
        /** Extra refill counts requested via customer app buttons */
        rice?: number;   // integer
        cheese?: number; // integer
    };

    billing?: {
        isVoided: boolean;
        voidReason?: string | null;
        voidNote?: string | null;
        isFree: boolean;
        discountType?: "percent" | "fixed" | null;
        discountValue?: number | null;
        itemId: string;
        itemName: string;
        unitPrice: number;
    };

    // Modifier selections applied at order time. Driven by the product's
    // attached OptionGroups; see OptionGroup type. Present only on tickets
    // whose product had option groups and where the cashier picked values.
    modifiersText?: string;        // "Large, Extra Cheese" — for KDS display
    modifiers?: SelectedModifier[];

    // --- Offline backup-print stamp (kitchen-bt-printer-backup feature) ---
    // Set when this ticket was printed to the shared Bluetooth kitchen printer
    // because the ordering device was offline. Read by the KDS page to
    // auto-acknowledge tickets the kitchen already handled on paper during an
    // outage, so they don't flood the active prep/alerting queue on reconnect.
    printedOffline?: boolean;
    printedOfflineAt?: number;
    printedOfflineDevice?: string;
};

export type SelectedModifier = {
  groupId: string;
  groupName: string;
  valueId: string;
  valueName: string;
  priceDelta: number;
};

export type BillableLine = {
  id: string;
  type: "package" | "addon";
  itemId: string;
  itemName: string;
  categoryName?: string | null;
  barcode?: string | null;
  unitPrice: number;
  qtyOrdered: number;
  discountQty: number;
  discountType: "percent" | "fixed" | null;
  discountValue: number | null;
  freeQty: number;
  voidedQty: number;
  createdAt?: any;
  updatedAt?: any;
  // Modifier metadata mirrors SessionBillLine. See SelectedModifier type.
  modifiers?: SelectedModifier[];
  modifiersText?: string;
  modifiersTotal?: number;     // sum of priceDelta across selected modifiers (per unit)
};

export type SessionBillLine = {
  id: string;
  type: "package" | "addon";
  itemId: string;
  itemName: string;
  category?: string | null;
  barcode?: string | null;
  unitPrice: number;
  qtyOrdered: number;
  discountType: "percent" | "fixed" | null;
  discountValue: number | null;
  discountQty: number;
  freeQty: number;
  voidedQty: number;
  /**
   * Multiple line-level discounts/charges stored on the bill line (source of truth).
   * Map keyed by adjustment id for easy removal.
   */
  lineAdjustments?: Record<string, LineAdjustment>;
  /**
   * Modifier selections recorded at order time. The line-id includes a hash
   * of these selections so the same product with different modifier picks
   * lives on separate bill lines. See SelectedModifier and OptionGroup types.
   */
  modifiers?: SelectedModifier[];
  modifiersText?: string;
  /**
   * Sum of selected priceDeltas, per unit. Line total math is:
   *   (unitPrice + modifiersTotal) * qty - line-level discounts/charges.
   */
  modifiersTotal?: number;
  /** Per-line special instructions (kitchen note). */
  note?: string | null;
  qtyOverrideActive?: boolean;
  qtyOverrideAt?: any;
  qtyLastSyncedApprovedAt?: string | null;
  createdAt: any;
  updatedAt: any;
  updatedByUid?: string | null;
  updatedByName?: string | null;
  kitchenLocationId?: string | null;
  kitchenLocationName?: string | null;
};

export type LineAdjustmentKind = "discount" | "charge";

export type LineAdjustment = {
  id: string;
  kind: LineAdjustmentKind;      // discount | charge
  note: string;                 // label shown in UI
  type: "fixed" | "percent";    // fixed amount or percent
  value: number;                // amount or percent value
  qty: number;                  // apply to how many items in the line
  refId?: string | null;        // preset id if any
  stackable?: boolean;          // snapshot at time of apply
  createdAtClientMs: number;
  createdByUid: string;
  createdByName?: string;
};

export type Payment = {
    id: string;
    methodId: string;
    amount: number;
    reference?: string;
    fromReservationPaymentId?: string;
};

export type PosPaymentIntentDoc = {
  id: string;
  storeId: string;
  sessionId: string;
  provider: 'paymongo_qrph';
  amount: number;
  amountCentavos: number;
  paymongoIntentId: string;
  paymongoPaymentId: string | null;
  qrData: string | null;
  imageUrl: string | null;
  status: 'awaiting_payment' | 'paid' | 'failed' | 'expired' | 'canceled';
  createdAtMs: number;
  expiresAtMs: number;
  processedEventIds: string[];
  methodId: string;
  createdByLocalUserId: string | null;
  createdByUid: string;
};

export type Adjustment = {
  id: string;
  note: string;
  amount: number;
  type: 'fixed' | 'percent';
  source: 'charge' | 'custom';
  sourceId?: string;
  appliesTo?: "subtotal" | "total";
};

export type Charge = {
  id: string;
  name: string;
  type: "fixed" | "percent";
  value: number;
  appliesTo: "subtotal" | "total";
  // Scope controls WHERE the charge can be applied: at the bill level, at the
  // item line level, or both. Missing on legacy docs; consumers must coalesce
  // a missing value to ["bill"] for backward compatibility.
  scope?: ("bill" | "item")[];
  isEnabled: boolean;
  sortOrder: number;
  isArchived: boolean;
  createdAt: any;
  updatedAt: any;
  createdBy: string;
  updatedBy: string;
  // Admin-override fields (set by platform admin on store-scoped charges)
  adminSuspended?: boolean;
  adminSuspendedAt?: any;
  adminSuspendedBy?: string;
  // UI-runtime marker (not persisted) — added when merging global entries client-side
  source?: "store" | "global";
};

export type Discount = {
  id: string;
  name: string;
  type: "fixed" | "percent";
  value: number;
  scope: ("bill" | "item")[];
  stackable: boolean;
  isEnabled: boolean;
  sortOrder: number;
  isArchived: boolean;
  createdAt: any;
  updatedAt: any;
  createdBy: string;
  updatedBy: string;
  // Optional date-gated availability window. Interpreted as local YYYY-MM-DD
  // strings, inclusive on both ends. Only populated on universal (global)
  // discounts today — store-scoped ones leave these undefined.
  startDate?: string;
  endDate?: string;
  // Admin-override fields (set by platform admin on store-scoped discounts)
  adminSuspended?: boolean;
  adminSuspendedAt?: any;
  adminSuspendedBy?: string;
  // VAT-exempt (senior/PWD): when applied as a bill discount, the whole bill is
  // VAT-exempt and the discount is taken on the VAT-removed net price.
  vatExempt?: boolean;
  // UI-runtime marker (not persisted) — added when merging global entries client-side
  source?: "store" | "global";
};

// Platform-scoped universal discount/charge configured by admin
export type GlobalDiscount = Omit<Discount, "source" | "adminSuspended" | "adminSuspendedAt" | "adminSuspendedBy"> & {
  applicableStoreIds: string[];
};

export type GlobalCharge = Omit<Charge, "source" | "adminSuspended" | "adminSuspendedAt" | "adminSuspendedBy"> & {
  applicableStoreIds: string[];
};

export type ModeOfPayment = {
  id: string;
  name: string;
  type: "cash" | "card" | "online" | "other";
  sortOrder: number;
  isActive: boolean;
  hasRef: boolean;
  isArchived: boolean;
  /** Marks this mode of payment as an auto-confirming gateway tender. */
  gateway?: 'paymongo_qrph' | null;
  createdAt: any;
  updatedAt: any;
  createdBy: string;
  updatedBy: string;
};

/**
 * A saved static merchant/P2P QR (GCash QR Ph, Maya, bank QR) shown to a
 * customer at the till. Lives at stores/{storeId}/savedQrCodes/{id}.
 *
 * DISPLAY-ONLY: showing one records no tender. The cashier still rings the sale
 * through the normal Mode-of-Payment flow. Nothing here touches accounting.
 */
export type SavedQrCode = {
  id: string;
  storeId: string;
  /** What the manager typed, e.g. "GCash — Ate Malou". */
  name: string;
  /**
   * Stable brand key for icon lookup, e.g. "gcash". Kept separate from `name`
   * so a personal label still resolves to the right logo. Derived by
   * guessProvider() in lib/qr/emvco.ts — which matches on the BIC in the
   * merchant-account template, NOT the GUID (that is "ph.ppmi.p2m" for every
   * PH participant and identifies the scheme, not the wallet).
   */
  provider: string;
  sortOrder: number;
  isActive: boolean;

  /**
   * The EMVCo payload, VERBATIM as scanned. NEVER re-serialize this from `meta`
   * — tag order is not canonical and the CRC covers the exact byte sequence, so
   * a "cleaned up" payload is a different string that some bank apps reject.
   *
   * REQUIRED. The wallet stores data, never a picture: every tile renders a
   * freshly generated QR from this string. A scan that does not decode (or
   * whose CRC fails) is simply not saved — there is no photo fallback, because
   * showing a customer a photograph of a QR is exactly what this design avoids.
   */
  payload: string;

  /** Parsed EMVCo fields. DISPLAY ONLY — not a source of truth for anything. */
  meta?: {
    merchantName?: string | null;
    merchantCity?: string | null;
    countryCode?: string | null;
    currency?: string | null;
    mcc?: string | null;
    initiationMethod?: 'static' | 'dynamic' | null;
    accountGuids?: string[];
    maskedAccount?: string | null;
    crcValid?: boolean;
    /** EmvWarning codes from lib/qr/emvco.ts. */
    warnings?: string[];
  };

  // No photo is stored. The scanner keeps reading until it has a payload, and
  // the payload is the only thing worth keeping — a picture of a QR is strictly
  // worse to display than a QR regenerated from its data.

  iconUrl?: string | null;
  iconStoragePath?: string | null;
  iconSource?: 'simpleicons' | 'favicon' | 'upload' | 'initials';
  /** Fallback badge when no icon was fetched — always populated. */
  iconInitials?: string;
  iconColor?: string;

  createdAt: any;
  createdAtMs: number;
  createdByUid: string;
  createdByName?: string | null;
  updatedAt: any;
  updatedByUid?: string;

  /**
   * When true, THIS is the QR shown to online-ordering customers on the
   * website order page. At most one per store. Setting it on one QR clears
   * it on every other QR in the same store. Deactivating or deleting the
   * flagged QR clears the flag — a QR customers cannot be shown must not be
   * the one they are shown.
   *
   * Flagging is a decision about which account receives money from the
   * public, so it is manager/admin only (firestore.rules already scopes
   * savedQrCodes as a config collection).
   */
  useForOnlineOrders?: boolean;
};

/**
 * Photo of a customer's e-wallet confirmation screen, taken right after they
 * scan a saved QR. Lives at paymentProofs/{storeId}/{proofId}.
 *
 * DELIBERATELY JUST A PHOTO. No amount, no reference number, no OCR. The POS
 * does not record what was received here — the sale is rung up through the
 * normal Mode-of-Payment flow, and this is only a visual record that the
 * customer showed a confirmation. Anything more would be a second, unreconciled
 * source of truth for money.
 *
 * RETENTION: 15 days, enforced in two places that must stay in step —
 *   - the photo, by a Storage lifecycle rule on the paymentProofs/ prefix
 *     (see storage-lifecycle.json);
 *   - this document, by a Firestore TTL policy on the `expiresAt` field.
 * Neither costs anything to run, and neither needs a cron job.
 */
export type PaymentProof = {
  id: string;
  storeId: string;

  /** Which saved QR was on screen when this was captured, for context. */
  qrId: string | null;
  qrName: string | null;
  provider: string | null;

  /** null while the upload is still queued in the offline outbox. */
  imageUrl: string | null;
  imageStoragePath: string | null;
  imageUploadStatus: 'pending' | 'uploaded' | 'failed';

  capturedAtMs: number;
  createdAt: any;
  createdByUid: string;
  createdByName: string | null;
  createdByLocalUserId: string | null;

  /**
   * Firestore TTL anchor — the policy deletes this document once the clock
   * passes it. Must be a Timestamp, not a number: a TTL policy silently
   * ignores a field of any other type, and the collection would grow forever
   * with no error to notice.
   */
  expiresAt: any;
};

/**
 * Audit trail written when a saved QR is displayed to a customer. Feature A
 * records no tender, so this is the only signal that money may have moved
 * outside the POS. Best-effort — a failed write must never block the display.
 */
export type QrWalletEvent = {
  id: string;
  qrId: string;
  qrName: string;
  provider: string;
  sessionId: string | null;
  createdAtMs: number;
  createdByUid: string;
  createdByLocalUserId: string | null;
};

export type ForecastConfig = {
  customHolidays?: { name: string; date: string }[]; // date in YYYY-MM-DD
  payrollScheduleType?: 'semi_monthly_15_eom' | 'weekly' | 'bi_weekly' | 'custom';
  customPayrollDates?: number[]; // day-of-month numbers (1–31); 31 = end of month
  payrollWeekday?: number; // 0=Sun..6=Sat for weekly/bi-weekly
  storeContext?: string; // free-text AI context, e.g. "near a university"
  /** Which number becomes projectedSales. "llm" (default) keeps the learned model in shadow. */
  engine?: 'llm' | 'model';
};

export type LoyaltyConfig = {
  isEnabled: boolean;
  pointsPerPeso: number; // e.g. 0.01 = 1 point per ₱100
  /** Minutes a self-redeemed Hub voucher stays valid before it expires and refunds. Default 60. */
  redemptionExpiryMinutes?: number;
};

/**
 * A global (program-wide) loyalty reward members can redeem points for.
 * Managed by platform admin in the POS; read by the Customer Hub. v1 reward
 * types apply as a bill discount when redeemed.
 */
export type LoyaltyReward = {
  id: string;
  name: string;
  description?: string | null;
  pointsCost: number;
  type: "fixed" | "percent"; // fixed = ₱ off, percent = % off the bill
  value: number;
  isActive: boolean;
  sortOrder?: number;
  imageUrl?: string | null;
  /** Optional store scoping; absent ⇒ available at all stores. */
  applicableStoreIds?: string[] | null;
  /**
   * Stores that have switched this reward off locally (Collections → Loyalty).
   * Subtractive on purpose: see src/lib/loyaltyRewardScope.ts.
   */
  disabledStoreIds?: string[] | null;
  /** Max times one customer may claim this reward within a single visit. Default 1. */
  maxPerVisit?: number;
  /** Max total claims of this reward per store. null/0/absent ⇒ unlimited. */
  maxClaimsPerStore?: number | null;
  /** Running claim counter per store, maintained on redeem/reverse. */
  claimsByStore?: Record<string, number>;
  createdAt?: any;
  updatedAt?: any;
  createdBy?: string;
};

export type LoyaltyRedemptionStatus = "active" | "applied" | "expired" | "cancelled";

/**
 * A redemption record / voucher. Created when a member redeems a reward (points
 * are debited at creation). Hub-created vouchers carry a short `code` the
 * cashier enters; POS-created ones are applied immediately (status "applied").
 */
export type LoyaltyRedemption = {
  id: string;
  code: string;
  phone: string;
  rewardId: string;
  rewardName: string;
  pointsCost: number;
  type: "fixed" | "percent";
  value: number;
  status: LoyaltyRedemptionStatus;
  source: "hub" | "pos";
  createdAt?: any;
  createdAtClientMs: number;
  expiresAtMs: number;
  appliedStoreId?: string | null;
  appliedSessionId?: string | null;
  appliedReceiptId?: string | null;
  appliedByUid?: string | null;
  appliedAtMs?: number | null;
  refundedAtMs?: number | null;
};

/**
 * Snapshot of an applied loyalty reward stored on a session. A session can hold
 * several (`session.loyaltyRedemptions`), each a different reward; bill totals
 * sum them. Drives the bill discount math.
 */
export type SessionLoyaltyRedemption = {
  redemptionId: string;
  rewardId: string;
  rewardName: string;
  type: "fixed" | "percent";
  value: number;
  pointsCost: number;
  phone: string;
};

export type SharelebratorLink = {
  linkedCustomerPhone?: string | null;
  linkedCustomerName?: string | null;
  linkedCustomerLockedAt?: any; // Timestamp when session closed
  /** Set when a cashier (not the diner) attached the card. Absent for diner-linked sessions. */
  linkedBy?: "cashier" | null;
  linkedByUid?: string | null;
  linkedAt?: any;
};

export type Store = {
  id: string;
  name: string;
  code: string;
  address: string;
  /**
   * Online-delivery service radius in km. A storefront buyer is offered DELIVERY
   * from this store only when within this distance (server-enforced in placeOrder).
   * 0/absent ⇒ pickup only. Distance is measured from the store's `geo` geotag
   * (declared below). Adjustable via the slider in Store Management, admin/manager only.
   */
  deliveryRadiusKm?: number;
  /**
   * Online-pickup service radius in km. The storefront only lists this store for
   * PICKUP when the buyer is within this distance. 0/absent ⇒ unlimited (any
   * distance) — kept as the default so existing stores aren't affected until a
   * manager sets one. Distance is measured from the store's `geo` geotag.
   * Adjustable via the slider in Store Management, admin/manager only.
   */
  pickupRadiusKm?: number;
  tin?: string;
  logoUrl?: string | null;
  vatType?: "VAT" | "NON_VAT"; // Deprecated
  taxType?: "VAT_INCLUSIVE" | "VAT_EXCLUSIVE" | "NON_VAT";
  taxRatePct?: number;
  isActive: boolean;
  openingDate?: Timestamp | null;
  openingTime?: string;
  closingTime?: string;
  contactNumber?: string;
  email?: string;
  /**
   * When true, this store is bookable from the public SharEat website. The
   * website (shareat-website project) reads this flag via an Admin SDK function
   * to decide which branches to show on its reservation form. This flag is the
   * ONLY enrolment step — there is no separate website-side registration.
   */
  acceptsReservations?: boolean;
  /**
   * When true, the public website shows a live-chat option for this branch that
   * routes to this store's cashier inbox.
   */
  acceptsWebsiteChat?: boolean;
  /**
   * The branch's Facebook Messenger link (https://m.me/...). Surfaced by the
   * website after a booking and as the fallback when live chat is closed.
   * Optional — a blank link simply hides the Messenger button.
   */
  fbPageLink?: string;
  /**
   * Master switch — this store is enrolled in online ordering. The SharEat
   * website only ever lists/serves/accepts orders for a store when this is true
   * AND it is open right now (see onlineOrderMode below). Requires a `geo`
   * geotag to actually appear in the website store picker.
   */
  acceptsOnlineOrders?: boolean;
  /**
   * How the store's online open/closed state is decided:
   *  - "auto"   ⇒ follows the store's opening hours (openingTime/closingTime,
   *               Asia/Manila, overnight-aware) — opens & closes automatically.
   *  - "manual" ⇒ uses onlineOrderManualOpen as a manual override.
   * Absent ⇒ treated as "manual" (back-compat). Computed by
   * lib/storefront/online-hours.ts and mirrored server-side on the website.
   */
  onlineOrderMode?: "auto" | "manual";
  /**
   * Manual open(true)/closed(false) override, used only when onlineOrderMode is
   * "manual". Absent ⇒ treated as open (matches the old boolean behaviour).
   */
  onlineOrderManualOpen?: boolean;
  /**
   * When set (and acceptsReservations is on), constrains the days/time window a
   * customer may book from the public website. Enforced server-side by the
   * website's createReservation function. Absent ⇒ no constraint (any time).
   * days: allowed weekdays in Asia/Manila, 0=Sun … 6=Sat. Times are "HH:mm".
   */
  reservationSchedule?: {
    days: number[];
    fromTime: string;
    toTime: string;
  };
  /**
   * Session modes this store offers. Drives which start-session options the
   * cashier sees (e.g. a take-out kiosk with no dine-in sets offersUnlimited
   * false). Absent ⇒ treated as offered, so existing stores keep both.
   */
  offersAlaCarte?: boolean;
  offersUnlimited?: boolean;
  /**
   * Master switch for this store's Google GenAI features (daily insights,
   * sales forecasts, AI briefings). Default OFF: a store must explicitly set
   * `aiEnabled: true` to use any GenAI. Gates server generation (cron + manual)
   * and the client AI surfaces. See lib/server/ai-enabled.ts.
   */
  aiEnabled?: boolean;
  forecastConfig?: ForecastConfig;
  loyaltyConfig?: LoyaltyConfig;
  /** Geotag (from Google Maps) used to fetch this branch's weather forecast. */
  geo?: { lat: number; lng: number; updatedAt?: any };
  createdAt: any;
  updatedAt: any;
};

export type StoreTable = {
    id: string; // e.g., T1, T2
    code: string;
    tableNumber: string;
    displayName: string;
    isActive: boolean;
    status: 'available' | 'occupied' | 'reserved' | 'out_of_order';
    currentSessionId: string | null;
};

export type PendingSession = {
  id: string;
  storeId: string; // Added for convenience
  tableId?: string;
  tableNumber: string;
  tableDisplayName?: string | null;
  packageName: string;
  status: 'pending_verification' | 'active' | 'closed' | 'voided';
  sessionMode: 'package_dinein' | 'alacarte';
  customerName?: string | null;
  isPaid?: boolean;
  // Set when the session is seated from a reservation. Used by the Pay modal
  // to fetch and pre-apply reservation payments.
  reservationId?: string | null;
  packageOfferingId: string;
  packageSnapshot?: { id?: string; name?: string; pricePerHead?: number; isBundle?: boolean; bundlePrice?: number; bundleMaxCap?: number; bundleExtraHeadPrice?: number } | null;
  initialFlavorIds?: string[];
  startedAt: Timestamp;
  startedAtClientMs?: number | null;
  // Guest Count Model
  guestCountCashierInitial: number;
  guestCountServerVerified: number | null;
  guestCountFinal: number | null;
  guestCountVerifyLocked: boolean;
  // Change Request Models
  guestCountChange?: { status: "none" | "pending" | "approved" | "rejected", approvedAt?: any };
  packageChange?: { status: string };
  customer?: { name?: string | null, tin?: string | null, address?: string | null };
  billDiscount?: Discount | null;
  customAdjustments?: Adjustment[];
  billingRevision?: number;
  statutoryDiners?: StatutoryDiner[] | null;
  statutoryHeadCount?: number | null;
};

/**
 * The session document as it is actually written to
 * `stores/{storeId}/sessions/{sessionId}`.
 *
 * `PendingSession` describes the subset the live cashier/server screens read.
 * The verify, close and change-request paths write considerably more, and code
 * that reconstructs a session's history after the fact (the Daily Session
 * Timeline) needs those fields typed. Kept as an extension rather than folded
 * into `PendingSession` so the ~40 existing consumers stay untouched.
 */
export type SessionDoc = PendingSession & {
  sessionLabel?: string;
  notes?: string;
  createdAt?: any;
  updatedAt?: any;

  startedByUid?: string | null;

  // Verification (ServerPageClient.handleVerify)
  verifiedAt?: any | null;
  verifiedByUid?: string | null;
  verifiedByServerProfileId?: string | null;
  verifiedByServerProfileName?: string | null;
  /** Start → verify lapse, stamped at verify time. Prefer this over recomputing. */
  verifyDurationMs?: number | null;

  // Close (closeSession)
  closedAt?: any | null;
  closedAtClientMs?: number | null;
  closedByUid?: string | null;
  closedByUsername?: string | null;
  receiptSnapshot?: { grandTotal?: number } | null;

  // Serve rollups, incremented by the KDS as tickets are served
  serveCountByType?: Record<string, number>;
  serveTimeMsTotalByType?: Record<string, number>;
  servedRefillsTotal?: number;
  servedRefillsByName?: Record<string, number>;

  loyaltyRedemptions?: any[];

  guestCountChange?: {
    status: "none" | "pending" | "approved" | "rejected";
    requestedCount?: number;
    reason?: string | null;
    reasonNote?: string | null;
    requestedByUid?: string | null;
    requestedAt?: any;
    approvedByUid?: string | null;
    approvedAt?: any;
    rejectedByUid?: string | null;
    rejectedAt?: any;
  };
  packageChange?: {
    status: string;
    requestedPackageId?: string | null;
    requestedPackageSnapshot?: PendingSession["packageSnapshot"];
    reason?: string | null;
    reasonNote?: string | null;
    requestedByUid?: string | null;
    requestedAt?: any;
    approvedByUid?: string | null;
    approvedAt?: any;
    rejectedByUid?: string | null;
    rejectedAt?: any;
  };
};

export type TopRefillRow = { name: string; qty: number };
export type TopAddonRow = { name: string; qty: number; amount: number; categoryName: string; };

export type DailyMetric = {
    meta: {
        dayId?: string;
        storeId: string;
        dayStartMs?: number;
        updatedAt: any;
        backfilledAt?: any;
        source?: string;
        presetId?: string;
        rangeStartMs?: number;
        rangeEndMs?: number;
    };
    payments?: {
        totalGross: number;
        txCount: number;
        byMethod: {
            [methodName: string]: number;
        };
        discountsTotal?: number;
        chargesTotal?: number;
        txCountByMode?: { dineIn: number; walkIn: number };
    };
    guests?: {
        guestCountFinalTotal?: number;
        packageSessionsCount?: number;
        packageCoversBilledByPackageName?: {
            [packageName: string]: number;
        };
        guestCountFinalByPackageName?: Record<string, number>;
    };
    sales?: {
        packageSalesAmountByName: Record<string, number>;
        packageSalesQtyByName: Record<string, number>;
        addonSalesAmountByCategory: Record<string, number>;
        addonSalesQtyByCategory: Record<string, number>;
        addonSalesByItem?: Record<string, { qty: number; amount: number; categoryName: string; }>;
        dineInAddonSalesAmount?: number;
        dineInSalesGross?: number;
        dineInDiscountsTotal?: number;
        dineInChargesTotal?: number;
        salesAmountByHour: Record<string, number>;
        sessionCountByHour: Record<string, number>;
        topAddonsByQty?: TopAddonRow[];
        salesAmountByHourByMode?: {
            dineIn: Record<string, number>;
            walkIn: Record<string, number>;
        };
        sessionCountByHourByMode?: {
            dineIn: Record<string, number>;
            walkIn: Record<string, number>;
        };
        salesAmountByMode?: { dineIn: number; walkIn: number };
        netSalesByMode?: { dineIn: number; walkIn: number };
        salesAmountByDow?: Record<string, number>;
        sessionCountByDow?: Record<string, number>;
    };
    kitchen?: {
        servedCountByType: Record<string, number>;
        cancelledCountByType: Record<string, number>;
        durationMsSumByType: Record<string, number>;
        durationCountByType: Record<string, number>;
        durationMsSumByLocation?: Record<string, number>;
        durationCountByLocation?: Record<string, number>;
        // Per local-user (profileId) serving-time buckets. Avg = sum / count.
        servingMsSumByUser?: Record<string, number>;
        servingCountByUser?: Record<string, number>;
    };
    // Server-page order confirmation timing. Overall + per local-user (profileId).
    server?: {
        confirmMsSum?: number;
        confirmCount?: number;
        confirmMsSumByUser?: Record<string, number>;
        confirmCountByUser?: Record<string, number>;
    };
    // Chat response timing + on-duty attribution. Timeliness fields are keyed
    // by RESPONDER; efficiency fields are keyed by whoever was on duty when
    // the message arrived (may differ — see chat-responsiveness design spec).
    chat?: {
        responseMsSumByUser?: Record<string, number>;
        responseCountByUser?: Record<string, number>;
        within2MinCountByUser?: Record<string, number>;
        receivedWhileOnDutyByUser?: Record<string, number>;
        answeredWhileOnDutyByUser?: Record<string, number>;
        totalReceived?: number;
    };
    // profileId -> display name, for labeling per-user metrics in reports.
    staffNames?: Record<string, string>;
    sessions?: {
        closedCount: number;
        totalPaid: number;
        closedCountByMode?: { dineIn: number; walkIn: number };
        // Sum of dine-in (package) session durations and the count of sessions
        // that contributed a valid duration. Average = sum / count.
        dineInDurationMsSum?: number;
        dineInDurationCount?: number;
    };
    refills?: {
        servedRefillsTotal: number;
        servedRefillsByName: Record<string, number>;
        packageSessionsCount: number;
        topRefillsByQty?: TopRefillRow[];
    };
    items?: {
        voidedQty: number;
        voidedAmount: number;
        freeQty: number;
        freeAmount: number;
        discountedQty: number;
        discountedAmount: number;
        refundCount: number;
        refundTotal: number;
    };
}

/* ------------------------------------------------------------------ */
/*  Daily Metrics Digest  (stored at stores/{storeId}/dailyMetrics/{dayId}) */
/*  Deterministic performance metrics computed every day, no AI involved.  */
/*  Was the signal layer under an AI-narrated brief until that generation */
/*  was retired in favor of ERP's own AI brief (2026-08-08) — this doc is */
/*  what gets forwarded to ERP. See docs/erp-daily-metrics-forwarding.md. */
/* ------------------------------------------------------------------ */

/** One deterministic, server-computed figure shown as a chip. */
export type InsightMetric = {
  label: string;
  value: string;            // pre-formatted (₱, %, min, count)
  sub?: string | null;      // e.g. "vs ₱42,300 same Sat" or "+12% vs 7-day avg"
  direction?: "up" | "down" | "flat" | null;
};

export type DailyMetricsDigest = {
  dayId: string;            // the analyzed day (yesterday), YYYYMMDD (Asia/Manila)
  storeId: string;
  status: "ok" | "no_data" | "error";
  source: "manual" | "cron";
  generatedAt: any;         // serverTimestamp
  generatedAtMs: number;
  sales: InsightMetric[];
  operations: InsightMetric[];
  inventory: InsightMetric[];
  anomalies: InsightMetric[];
  /** Plain-text rollup of every metric below, generated for free alongside
   *  them — handy for forwarding/logging without re-deriving meaning from
   *  the chip arrays. */
  digestText?: string;
  error?: string | null;
};

export type ReceiptAnalyticsV2 = {
  v: 2;
  sessionStartedAt: any | null;
  sessionStartedAtClientMs?: number | null;
  sessionStartedAtHour?: number | null;
  subtotal: number;
  discountsTotal: number;
  chargesTotal: number;
  taxAmount: number;
  // VAT split persisted on the receipt so reprints/exports don't recompute it.
  // Optional: historical receipts predate these and fall back at render time.
  vatableSales?: number;
  vatExemptSales?: number;
  statutoryDiscountTotal?: number;
  statutoryVatRemovedTotal?: number;
  grandTotal: number;
  totalPaid: number;
  change: number;
  mop: Record<string, number>;
  salesByItem?: Record<string, { qty: number; amount: number; categoryName: string; }>;
  salesByCategory?: Record<string, { qty: number; amount: number; }>;
  addonSalesByItem?: Record<string, { qty: number; amount: number; }>; // New field
  servedRefillsByName?: Record<string, number>;
  serveCountByType?: Record<string, number>;
  serveTimeMsTotalByType?: Record<string, number>;
  guestCountSnapshot?: {
    packageOfferingId?: string | null;
    packageName?: string | null;
    finalGuestCount: number;
    billedPackageCovers: number;
    discrepancy: number;
    computedAtClientMs: number;
    rule: "MAX";
    /** Set for bundle packages: covers are flat-satisfied, so no discrepancy. */
    isBundle?: boolean;
    /** Number of bundle units billed (1 per bundle). Undefined for per-head. */
    billedUnits?: number;
  };
};

export type Receipt = {
    id: string;
    storeId: string;
    sessionId: string;
    createdAt: any;
    createdAtClientMs: number;
    createdByUid: string;
    createdByUsername: string;
    sessionMode: 'package_dinein' | 'alacarte';
    tableId: string | null;
    tableNumber: string | null;
    customerName: string | null;
    customerAddress?: string | null;
    customerTin?: string | null;
    lines: SessionBillLine[];
    statutoryDiners?: { kind: 'senior' | 'pwd'; name: string; idNo: string; share: number;
      discount: number; vatRemoved: number; vatExempt: number; promoWasHigher: boolean }[];
    total: number;
    totalPaid: number;
    change: number;
    status: 'final' | 'voided';
    receiptSeq: number;
    receiptNumber: string;
    receiptNoFormatUsed: string;
    /** T-423 additive fields: the terminal series (`<CODE>-<TT>-<NNNNNN>`); `receiptSeq === terminalSeq`. */
    terminalNo?: number;
    terminalSeq?: number;
    deviceId?: string;
    analytics?: any | ReceiptAnalyticsV2;
    analyticsApplied?: boolean;
    analyticsAppliedAt?: any;
    analyticsApplyId?: string;
    // Fields for editing audit trail
    isEdited?: boolean;
    editVersion?: number;
    editedAt?: any;
    editedByUid?: string;
    editedByEmail?: string | null;
    editReason?: string;
    lastDiffSummary?: string;
    // New fields for explicit discount auditing
    discounts?: {
        bill?: any;
        items?: any[];
    };
    discountsTotal?: number;
    discountEventIds?: string[];
    // Fields for voiding
    voidedAt?: any;
    voidedByUid?: string;
    voidedByEmail?: string | null;
    voidReason?: string;
    // Cash disposition of a void (set when a PAID receipt is voided). A void
    // cancels the SALE; these record what happened to the CASH so remittance can
    // reconcile the drawer. retained = paid − refunded; retained cash is collected
    // with no backing sale and is carried into expected remittance.
    voidCashPaid?: number;
    voidCashRefunded?: number;
    voidCashRetained?: number;
    voidCashDisposition?: "refunded" | "retained" | "partial";
    /** If the void was corrected by a new receipt, its id (retained cash consumed). */
    reRingReceiptId?: string | null;
    /** True once retained void cash has been reversed out of analytics because a
     *  re-ring receipt now covers it (prevents double-counting expected cash). */
    voidCashRetainedReversed?: boolean;
    reRingLinkedAt?: any;
  billDiscount?: Discount | null;
  customAdjustments?: Adjustment[];
  loyaltyRedemptions?: SessionLoyaltyRedemption[];
  // Refund receipt support
  receiptId?: string;
  parentReceiptId?: string;
  isRefund?: boolean;
}

export type DiscountEvent = {
  id: string;
  storeId: string;
  receiptId: string;
  receiptNumber: string;
  sessionId: string;
  scope: "bill" | "item";
  actionType: "DISCOUNT_APPLIED" | "DISCOUNT_EDITED" | "DISCOUNT_REMOVED";
  billDiscount: {
    discountType: "fixed" | "percent";
    discountName: string;
    percent?: number | null;
    amount: number;
  } | null;
  itemDiscount: {
    lineId: string;
    itemId?: string;
    itemName: string;
    qtyAffected?: number;
    discountType: "percent" | "fixed";
    percent?: number | null;
    amount: number;          // absolute currency amount for this event
  } | null;
  reason?: string | null;
  createdAt: any;
  createdByUid: string;
  createdByName: string;
  createdByRole: string;
};
export type ActivityLog = {
  id: string;
  sessionId: string;
  storeId: string;

  action: "SESSION_STARTED" | "SESSION_VOIDED" | "SESSION_VERIFIED" | "SESSION_AUDIT_FLAGGED" | "SESSION_AUDIT_CLEARED" | "DISCOUNT_APPLIED" | "DISCOUNT_EDITED" | "DISCOUNT_REMOVED" | "BILL_DISCOUNT_APPLIED" | "BILL_DISCOUNT_REMOVED" | "CUSTOM_CHARGE_ADDED" | "CUSTOM_CHARGE_REMOVED" | "MARK_FREE" | "UNMARK_FREE" | "VOID_TICKETS" | "UNVOID" | "PRICE_OVERRIDE" | "PAYMENT_COMPLETED" | "edit_line" | "PACKAGE_QTY_OVERRIDE_SET" | "PACKAGE_QTY_RESYNC_APPROVED_CHANGE" | "BUNDLE_EXTRA_PAX_SYNCED" | "RECEIPT_DELETED" | "RECEIPT_EDITED" | "RECEIPT_VOIDED" | "RECEIPT_REFUND" | "ADDON_ADDED" | "REFILL_ADDED" | "GUEST_COUNT_REQUESTED" | "GUEST_COUNT_APPROVED" | "GUEST_COUNT_REJECTED" | "PACKAGE_CHANGE_REQUESTED" | "PACKAGE_CHANGE_APPROVED" | "PACKAGE_CHANGE_REJECTED" | "TICKET_SERVED" | "TICKET_CANCELLED" | "TICKET_BATCH_SERVED" | "TICKET_REMAINING_CANCELLED" | "CUSTOMER_PARTICIPANT_JOINED" | "CUSTOMER_PARTICIPANT_REJOINED" | "CUSTOMER_PARTICIPANT_REVOKED" | "CUSTOMER_PARTICIPANTS_RESET" | "CUSTOMER_REQUEST_CREATED" | "CUSTOMER_REQUEST_COMPLETED" | "STATUTORY_DINER_ADDED" | "STATUTORY_DINER_REMOVED";

  createdAtClientMs?: number;
  actorUid: string;
  actorRole?: string | null;
  actorName?: string | null;

  // Device-local server profile (present on server-page writes)
  serverProfileId?: string | null;
  serverProfileName?: string | null;

  lineId?: string;
  
  before?: any;
  after?: any;

  reason?: string | null;
  note?: string | null;

  // Denormalized session context for performant log reading
  sessionLabel?: string;
  sessionStatus?: 'pending_verification' | 'active' | 'closed' | 'voided';
  sessionStartedAt?: any;
  sessionMode?: 'package_dinein' | 'alacarte';
  customerName?: string | null;
  tableNumber?: string | null;
  tableDisplayName?: string | null;

  meta?: {
    statutory?: { type: string; kind: "senior" | "pwd"; idMasked: string; byUid: string; atClientMs: number };
    itemId?: string;
    itemName?: string;
    discountType?: "fixed" | "percent" | null;
    discountValue?: number | null;
    unitPriceBefore?: number | null;
    unitPriceAfter?: number | null;
    qty?: number;
    isFreeBefore?: boolean | null;
    isFreeAfter?: boolean | null;
    isVoidedBefore?: boolean | null;
    isVoidedAfter?: boolean | null;

    receiptId?: string;
    receiptNumber?: string;
    paymentTotal?: number;
    mopSummary?: any;
    
    // For overrides and syncs
    beforeQty?: number;
    afterQty?: number;
    approvedAt?: any;
    newQty?: number;
    amount?: number;
    editVersion?: number;
    diffSummary?: string;
    reason?: string;
    total?: number;
    snapshot?: Receipt;
    sessionLabel?: string;

    // For discount auditing
    scope?: "bill" | "item";
    oldDiscountTotal?: number;
    newDiscountTotal?: number;
    delta?: number;
    discountName?: string;
    percent?: number;
    severity?: "low" | "medium" | "high";
    
    serverCount?: number;
    finalCount?: number;

    // Customer participant fields
    participantId?: string;
    slotNumber?: number;
    joinMethod?: "qr" | "pin";
    revokedCount?: number;

    // Customer request fields
    requestId?: string;
    text?: string;
    type?: string;
    responseMs?: number;
    resolution?: string;

    // Refund-on-correction fields (RECEIPT_REFUND)
    refundAmount?: number;
    previousTotalPaid?: number;
    newGrandTotal?: number;
  };

  createdAt: any; // serverTimestamp()
};

export type PackageUnit = {
    guestId: string;
    packageId: string;
    packageName: string;
    unitPrice: number;
    createdAt: any;
    billing: {
        isFree: boolean;
        discountType?: "percent" | "fixed" | null;
        discountValue?: number | null;
    }
}

/**
 * Represents the real-time KDS document for a single kitchen station.
 * Path: /stores/{storeId}/rtKdsTickets/{kitchenLocationId}
 */
export type RtKdsStationDoc = {
  meta: {
    source: string;
    updatedAt: Timestamp;
  };
  kitchenLocationId: string;
  activeIds: string[]; // Array of active ticket IDs for sorting
  tickets: Record<string, KitchenTicket>; // Map of ticketId to ticket data
  sessionIndex: Record<string, string[]>; // Map of sessionId to its ticketIds
};

export type WeatherCondition = "sunny" | "cloudy" | "light_rain" | "heavy_rain";

export type WeatherEntry = {
  timestamp: Timestamp;
  condition: WeatherCondition;
  activeSessionCount: number;
  activeGuestCount: number;
  loggedByUid: string;
  loggedByProfileId?: string | null;
  loggedByProfileName?: string | null;
  /** Avg/current temperature in °C. Populated by the API logger (source: system). */
  tempC?: number | null;
};

export type WeatherRecord = {
  dayId: string;
  entries: WeatherEntry[];
};

/**
 * One day's weather summary inside a monthly weather-forecast doc. Sourced
 * hourly from OpenWeatherMap (`owm`) or, when the API is unreachable, from a
 * manual cashier log (`manual`). This is what the sales projection reads.
 */
export type DailyWeatherForecast = {
  date: string;        // YYYY-MM-DD
  condition: WeatherCondition;        // whole-day summary
  am?: WeatherCondition | null;       // morning window (00:00–12:00)
  pm?: WeatherCondition | null;       // afternoon/evening window (12:00–24:00)
  tempC?: number | null;
  pop?: number | null; // probability of precipitation 0..1 (max across the day)
  owmMain?: string | null;
  source: "owm" | "manual";
  fetchedAtMs: number;
};

/**
 * One doc per month per store: `stores/{storeId}/weatherForecasts/{YYYY-MM}`.
 * Keeps reads cheap — a 7-day window touches at most two docs. Past dayIds
 * accumulate as the hourly logger runs (history); today..+5 are the forecast.
 */
export type WeatherForecastMonth = {
  ym: string;       // YYYY-MM
  storeId: string;
  updatedAtMs: number;
  days: Record<string, DailyWeatherForecast>; // keyed by dayId (YYYYMMDD)
};

export type DailyContext = {
  dayId: string; // YYYYMMDD
  holiday?: {
    name: string;
    loggedByUid: string;
    loggedAt: Timestamp;
  } | null;
  isPayday?: {
    value: boolean;
    loggedByUid: string;
    loggedAt: Timestamp;
  } | null;
};

export type SalesForecast = {
  date: string; // YYYY-MM-DD
  projectedSales: number;
  actualSales?: number;
  accuracy?: number;
  confidence?: 'high' | 'medium' | 'low';
  /** Learned-model projection (always written when the model exists). */
  modelSales?: number;
  modelConfidence?: 'high' | 'medium' | 'low';
  /** Why the model projected this number, e.g. "Sat baseline ₱48,200". */
  drivers?: string[];
  /** LLM projection, written only when the LLM ran (engine "llm"). */
  llmSales?: number;
  modelAccuracy?: number;
  engine?: 'llm' | 'model';
  provider?: 'claude' | 'gemini' | 'model';
  createdAt: Timestamp;
};

export type ReceiptSession = {
    id: string;
    tableNumber?: string;
    customer?: { name?: string };
    customerName?: string | null;
    sessionMode: 'package_dinein' | 'alacarte';
    guestCountFinal?: number;
    paymentSummary: any;
    closedAt: any;
    startedByUid: string;
    verifiedByUid?: string;
    cashierName?: string;
};

export type ReceiptSettings = {
    businessName: string;
    branchName: string;
    address: string;
    contact: string;
    tin?: string;
    vatType?: "VAT" | "NON_VAT";
    logoUrl?: string | null;
    showLogo?: boolean;
    logoWidthPct?: number;
    footerText?: string;
    showCashierName: boolean;
    showTableOrCustomer: boolean;
    showItemNotes: boolean;
    showDiscountBreakdown: boolean;
    showChargeBreakdown: boolean;
    paperWidth: "58mm" | "80mm";
    receiptNoFormat?: string;
    autoPrintAfterPayment: boolean;
    fontSize: number;
    fontFamily: string;
};

export type ReceiptData = {
    session: ReceiptSession;
    lines?: SessionBillLine[];
    payments: any[];
    settings: ReceiptSettings;
    store?: Store;
    receiptCreatedAt?: any;
    createdByUsername?: string;
    receiptNumber?: string;
    analytics?: any;
    statutoryDiners?: Receipt['statutoryDiners'];
};

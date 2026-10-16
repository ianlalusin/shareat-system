

"use client";

import { useState, useMemo, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Search, Minus, Plus, Loader2, Layers } from "lucide-react";
import Image from "next/image";
import { useIsMobile } from "@/hooks/use-mobile";
import { collection, doc, writeBatch, serverTimestamp, runTransaction, increment, getDoc, getDocs, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { commitLocalFirst } from "@/lib/offline/commit";
import { printKitchenTicketBackup } from "@/lib/printing/kitchenBackupPrint";
import { makeKitchenBackupDeps } from "@/lib/printing/kitchenBackupDeps";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "@/lib/utils";
import { stripUndefined } from "@/lib/firebase/utils";
import type { InventoryItem, OptionGroup, PendingSession, SelectedModifier, SessionBillLine } from "@/lib/types";
import { computeSessionLabel } from "@/lib/utils/session";
import { QuantityInput } from "../cashier/quantity-input";
import { allowsDecimalQty } from "@/lib/uom";
import { resolveFamilyImageUrl } from "@/lib/products/variants";
import { getActorStamp, createKitchenTickets } from "../cashier/firestore";
import { writeActivityLog } from "../cashier/activity-log";
import { ModifierPicker, type PickerResult } from "../cashier/modifier-picker";
import { FamilyOrderModal, type FamilyOrderAddArgs } from "../cashier/family-order-modal";
import { getAuth } from "firebase/auth";

interface AddonsPOSModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  session: PendingSession;
  sessionIsLocked?: boolean;
  onAddLine?: (line: SessionBillLine) => void;
  serverProfile?: { id: string; name: string } | null;
}

type EnrichedStoreAddon = InventoryItem & {
  displayName: string;
  groupKey: string;
  groupName?: string;
  imageUrl?: string | null;
};

type AddonGroup = {
  title: string;
  key: string;
  items: EnrichedStoreAddon[];
  isGroup: boolean;
};

function AddonItem({ addon, onSelect }: { addon: EnrichedStoreAddon; onSelect: (addon: EnrichedStoreAddon) => void }) {
  return (
    <button
      onClick={() => onSelect(addon)}
      className="flex flex-col items-center justify-center p-2 border rounded-md hover:bg-muted/50 transition-colors text-center h-32 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="w-16 h-16 bg-muted rounded-md mb-1 relative overflow-hidden">
        {addon.imageUrl && <Image src={addon.imageUrl} alt={addon.displayName} fill style={{ objectFit: "cover" }} />}
      </div>
      <span className="text-xs font-medium leading-tight line-clamp-2">{addon.displayName}</span>
      <span className="text-xs text-muted-foreground mt-auto">₱{(addon.sellingPrice || 0).toFixed(2)}</span>
    </button>
  );
}

function GroupTile({ group, onSelect }: { group: AddonGroup; onSelect: (group: AddonGroup) => void }) {
  const familyImage = resolveFamilyImageUrl(group.items);
  return (
    <button
      onClick={() => onSelect(group)}
      className="flex flex-col items-center justify-center p-2 border rounded-md hover:bg-muted/50 transition-colors text-center h-32 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <div className="w-16 h-16 bg-muted rounded-md mb-1 relative overflow-hidden flex items-center justify-center">
        {familyImage ? (
          <Image src={familyImage} alt={group.title} fill style={{ objectFit: "cover" }} />
        ) : (
          <Layers className="h-8 w-8 text-muted-foreground" />
        )}
      </div>
      <span className="text-xs font-medium leading-tight line-clamp-2">{group.title}</span>
      <span className="text-xs text-primary mt-auto">Choose variant</span>
    </button>
  );
}

// The old VariantPicker is replaced by FamilyOrderModal which handles
// variant pick + modifier pick + qty + Add Item in one combined modal.

function POSContent({
  storeId,
  session,
  sessionIsLocked,
  onClose,
  onAddLine,
  serverProfile,
  isMobile = false,
}: {
  storeId: string;
  session: PendingSession;
  sessionIsLocked?: boolean;
  onClose: () => void;
  onAddLine?: (line: SessionBillLine) => void;
  serverProfile?: { id: string; name: string } | null;
  isMobile?: boolean;
}) {
  const { appUser } = useAuthContext();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();

  const { storeAddons, storeAddonsLoading, refreshStoreAddons, enableStoreAddons } = useStoreContext();
  const addons = storeAddons as unknown as EnrichedStoreAddon[];
  const isLoading = storeAddonsLoading;

  // Opt the session into the addons subscription on first mount of the picker.
  // Idempotent. Devices that never mount this picker never subscribe.
  useEffect(() => {
    enableStoreAddons();
  }, [enableStoreAddons]);

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const [selectedAddon, setSelectedAddon] = useState<EnrichedStoreAddon | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Combined family flow (replaces the old VariantPicker → AddonsPOSModal flow).
  // When the cashier clicks a family tile, this modal opens layered over the
  // main addons modal; it handles variant lock + modifier picks + qty + Add
  // Item all in one place. Cancelling it returns the cashier to the main grid.
  const [familyOrderGroup, setFamilyOrderGroup] = useState<AddonGroup | null>(null);
  const [familyOrderOpen, setFamilyOrderOpen] = useState(false);

  // Modifier picker for the SINGLETON flow only. Opens after "Add to Order"
  // when a non-family addon has option groups attached.
  const [modifierPickerOpen, setModifierPickerOpen] = useState(false);
  const [pendingOptionGroups, setPendingOptionGroups] = useState<OptionGroup[]>([]);
  const [loadingOptionGroups, setLoadingOptionGroups] = useState(false);

  const categories = useMemo(() => {
    return ["All", ...Array.from(new Set(addons.map((a) => a.subCategory || "Uncategorized")))];
  }, [addons]);

  const groupedAddons = useMemo(() => {
    let result = addons;

    if (activeCategory !== "All") {
      result = result.filter((a) => (a.subCategory || "Uncategorized") === activeCategory);
    }
    if (search) {
      const s = search.toLowerCase();
      result = result.filter((a) => (a.displayName || "").toLowerCase().includes(s));
    }

    const groups: Record<string, AddonGroup> = {};
    result.forEach((addon) => {
      const key = addon.groupKey || addon.id;
      if (!groups[key]) {
        groups[key] = {
          key,
          title: addon.groupName || addon.name,
          items: [],
          isGroup: false,
        };
      }
      groups[key].items.push(addon);
    });

    return Object.values(groups)
      .map((group) => {
        // Stable order so the family picture (first item with an image) and the
        // variant list are deterministic.
        const items = group.items
          .slice()
          .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
        return { ...group, items, isGroup: items.length > 1 };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [addons, search, activeCategory]);

  const handleSelectAddon = (addon: EnrichedStoreAddon) => {
    setSelectedAddon(addon);
    setQuantity(1);
  };

  // Click on a family tile opens the combined FamilyOrderModal which handles
  // variant pick + modifier pick + qty + Add Item all in one place. The main
  // addons modal stays open behind it so the cashier can add more after.
  const handleSelectGroup = (group: AddonGroup) => {
    setFamilyOrderGroup(group);
    setFamilyOrderOpen(true);
  };

  /**
   * Step 1 of adding a SINGLETON addon (non-family path): validate, check
   * whether the underlying Product has any option groups. If yes, open the
   * modifier picker; otherwise jump straight to performAdd() with no modifiers.
   * Family items skip this entirely — FamilyOrderModal does it all in one go.
   */
  const handleAddToOrder = async () => {
    if (sessionIsLocked) {
      toast({ variant: "destructive", title: "Session Closed", description: "Session is closed. KDS updates are disabled." });
      return;
    }
    if (!appUser || !storeId || !session?.id || !selectedAddon) {
      toast({ variant: "destructive", title: "Cannot Add Item", description: "Missing user, store, or session context." });
      return;
    }
    // Items with no kitchen location are still orderable (they just won't make a
    // kitchen ticket — see performAdd). No block here.

    const unitPriceNum = Number((selectedAddon as any).sellingPrice);
    const safeUnitPrice = Number.isFinite(unitPriceNum) ? unitPriceNum : 0;
    if (safeUnitPrice <= 0) {
      toast({ variant: "destructive", title: "Invalid Price", description: `Cannot add "${selectedAddon.displayName}" with a price of zero.`});
      return;
    }

    // Look up option groups attached to the underlying Product.
    const productId = (selectedAddon as any).productId || selectedAddon.id;
    setLoadingOptionGroups(true);
    try {
      const user = getAuth().currentUser;
      const idToken = user ? await user.getIdToken() : null;
      const res = idToken
        ? await fetch(`/api/products/${encodeURIComponent(productId)}/option-groups?storeId=${encodeURIComponent(storeId)}`, {
            headers: { Authorization: `Bearer ${idToken}` },
          })
        : null;
      const json = res ? await res.json().catch(() => ({})) : ({} as any);
      const groups: OptionGroup[] = res?.ok && json?.ok ? (json.optionGroups || []) : [];
      if (groups.length === 0) {
        await performAdd([], "", 0);
      } else {
        setPendingOptionGroups(groups);
        setModifierPickerOpen(true);
      }
    } catch {
      // If the fetch fails for any reason, fall through to add without modifiers
      // rather than block the cashier. The line still goes on the bill correctly.
      await performAdd([], "", 0);
    } finally {
      setLoadingOptionGroups(false);
    }
  };

  /**
   * Writes the bill line and kitchen ticket, optionally with modifiers.
   * Called by:
   *  - the singleton path (uses `selectedAddon` + `quantity` state)
   *  - the FamilyOrderModal callback (passes its own `override` with the
   *    locked variant and chosen quantity)
   * Modifiers contribute their priceDelta to the per-unit price and are stored
   * structurally (for analytics) plus as modifiersText (for KDS/receipt).
   */
  const performAdd = async (
    modifiers: SelectedModifier[],
    modifiersText: string,
    modifiersTotal: number,
    override?: { addon: EnrichedStoreAddon; qty: number; note?: string }
  ) => {
    const addon = override?.addon ?? selectedAddon;
    const qty = override?.qty ?? quantity;
    const lineNote = (override ? (override.note ?? "") : note).trim();
    if (!appUser || !storeId || !session?.id || !addon) return;

    const unitPriceNum = Number((addon as any).sellingPrice);
    const safeUnitPrice = Number.isFinite(unitPriceNum) ? unitPriceNum : 0;
    const effectiveUnitPrice = safeUnitPrice + (modifiersTotal || 0);

    setIsSubmitting(true);

    try {
      // Same item with different modifier picks must land on separate lines.
      const modHash = modifiers.length
        ? modifiers.map((m) => m.valueId).sort().join("-")
        : "";
      const lineId = modHash
        ? `addon_${addon.id}_${safeUnitPrice}_${modHash}`
        : `addon_${addon.id}_${safeUnitPrice}`;
      const actor = getActorStamp(appUser);

      if (isOnline) {
        await runTransaction(db, async (tx) => {
          const lineRef = doc(db, `stores/${storeId}/sessions/${session.id}/sessionBillLines`, lineId);
          const sessionRef = doc(db, "stores", storeId, "sessions", session.id);
          const lineSnap = await tx.get(lineRef);

          if (lineSnap.exists()) {
            tx.update(lineRef, {
              qtyOrdered: increment(qty),
              updatedAt: serverTimestamp(),
              updatedByUid: actor.uid,
              updatedByName: actor.username,
            });
          } else {
            const newLinePayload = stripUndefined({
              id: lineId,
              type: "addon",
              itemId: addon.id,
              itemName: addon.displayName,
              category: addon.subCategory ?? null,
              barcode: addon.barcode ?? null,
              unitPrice: safeUnitPrice,
              qtyOrdered: qty,
              discountType: null,
              discountValue: 0,
              discountQty: 0,
              freeQty: 0,
              voidedQty: 0,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              updatedByUid: actor.uid,
              updatedByName: actor.username,
              kitchenLocationId: addon.kitchenLocationId ?? null,
              kitchenLocationName: addon.kitchenLocationName ?? null,
              modifiers: modifiers.length ? modifiers : null,
              modifiersText: modifiersText || null,
              modifiersTotal: modifiers.length ? modifiersTotal : null,
              note: lineNote || null,
            });
            tx.set(lineRef, newLinePayload);
          }

          // Only items with a kitchen location produce a kitchen ticket. Items with
          // none are still billed (line above) but exempt from KDS so the order
          // doesn't break.
          if (addon.kitchenLocationId) {
            await createKitchenTickets(
              db,
              storeId,
              session.id,
              session,
              "addon",
              {
                itemId: addon.id,
                itemName: addon.displayName,
                kitchenLocationId: addon.kitchenLocationId,
                kitchenLocationName: addon.kitchenLocationName,
                billLineId: lineId,
              },
              qty,
              actor,
              { tx },
              lineNote || undefined,
              // `extra` is spread into the ticket payload. Pass modifier structure
              // so KDS can render it richly if it wants, plus a flat text field.
              modifiers.length ? { modifiers, modifiersText } : undefined
            );
          }
          tx.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });
        });
      } else {
        // Offline: this is the one read-modify-write flow in the modal. `getDoc`
        // resolves from Firestore's local cache (no network needed) so we can
        // still decide increment-vs-create, then batch the same writes the online
        // transaction would have made and commit local-first.
        const lineRef = doc(db, `stores/${storeId}/sessions/${session.id}/sessionBillLines`, lineId);
        const sessionRef = doc(db, "stores", storeId, "sessions", session.id);
        const lineSnap = await getDoc(lineRef); // cache-served offline

        const batch = writeBatch(db);

        if (lineSnap.exists()) {
          batch.update(lineRef, {
            qtyOrdered: increment(qty),
            updatedAt: serverTimestamp(),
            updatedByUid: actor.uid,
            updatedByName: actor.username,
          });
        } else {
          const newLinePayload = stripUndefined({
            id: lineId,
            type: "addon",
            itemId: addon.id,
            itemName: addon.displayName,
            category: addon.subCategory ?? null,
            barcode: addon.barcode ?? null,
            unitPrice: safeUnitPrice,
            qtyOrdered: qty,
            discountType: null,
            discountValue: 0,
            discountQty: 0,
            freeQty: 0,
            voidedQty: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            updatedByUid: actor.uid,
            updatedByName: actor.username,
            kitchenLocationId: addon.kitchenLocationId ?? null,
            kitchenLocationName: addon.kitchenLocationName ?? null,
            modifiers: modifiers.length ? modifiers : null,
            modifiersText: modifiersText || null,
            modifiersTotal: modifiers.length ? modifiersTotal : null,
            note: lineNote || null,
          });
          batch.set(lineRef, newLinePayload);
        }

        // Only items with a kitchen location produce a kitchen ticket. Items with
        // none are still billed (line above) but exempt from KDS so the order
        // doesn't break.
        let ticketPayload: Record<string, any> | null = null;
        if (addon.kitchenLocationId) {
          ticketPayload = await createKitchenTickets(
            db,
            storeId,
            session.id,
            session,
            "addon",
            {
              itemId: addon.id,
              itemName: addon.displayName,
              kitchenLocationId: addon.kitchenLocationId,
              kitchenLocationName: addon.kitchenLocationName,
              billLineId: lineId,
            },
            qty,
            actor,
            { batch },
            lineNote || undefined,
            // `extra` is spread into the ticket payload. Pass modifier structure
            // so KDS can render it richly if it wants, plus a flat text field.
            modifiers.length ? { modifiers, modifiersText } : undefined
          );
        }
        batch.update(sessionRef, { billingRevision: increment(1), updatedAt: serverTimestamp() });

        commitLocalFirst(batch, (err) => console.error("[AddonsPOSModal] offline sync failed", err));

        // Fire-and-forget backup print to the shared kitchen Bluetooth printer.
        // Never awaited into the order flow; any dep (or the kitchenLocations
        // fetch) throwing is swallowed by the trailing .catch.
        if (ticketPayload) {
          void (async () => {
            const klSnap = await getDocs(collection(db, "stores", storeId, "kitchenLocations"));
            const kitchenLocations = klSnap.docs.map((d) => ({ id: d.id, printOnOutage: (d.data() as any).printOnOutage }));
            const deps = makeKitchenBackupDeps({
              kitchenLocations,
              stampTicket: (ticketId) => {
                const ref = doc(db, "stores", storeId, "sessions", session.id, "kitchentickets", ticketId);
                void updateDoc(ref, { printedOffline: true, printedOfflineAt: Date.now(), printedOfflineDevice: getBrowserDeviceId() }).catch(() => {});
                // Also patch the rtKdsTickets projection the KDS page actually
                // reads from, so the auto-ack effect there can see the stamp.
                const _stationId = ticketPayload?.kitchenLocationId;
                if (_stationId) {
                  void updateDoc(doc(db, "stores", storeId, "rtKdsTickets", _stationId), {
                    [`tickets.${ticketId}.printedOffline`]: true,
                    [`tickets.${ticketId}.printedOfflineAt`]: Date.now(),
                  }).catch(() => {});
                }
              },
              alert: (message) => toast({ variant: "destructive", title: "Kitchen printer", description: message }),
            });
            await printKitchenTicketBackup(ticketPayload as any, deps);
          })().catch(() => {});
        }
      }

      // Optimistic UI hook
      if (onAddLine) {
        const newLine: SessionBillLine = {
          id: lineId,
          type: "addon",
          itemId: addon.id,
          itemName: addon.displayName,
          category: addon.subCategory ?? null,
          barcode: addon.barcode ?? null,
          unitPrice: safeUnitPrice,
          qtyOrdered: qty,
          discountType: null,
          discountValue: 0,
          discountQty: 0,
          freeQty: 0,
          voidedQty: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          kitchenLocationId: addon.kitchenLocationId,
          kitchenLocationName: addon.kitchenLocationName,
          modifiers: modifiers.length ? modifiers : undefined,
          modifiersText: modifiersText || undefined,
          modifiersTotal: modifiers.length ? modifiersTotal : undefined,
          note: lineNote || undefined,
        };
        onAddLine(newLine);
      }

      const noteSuffix = modifiersText ? ` (${modifiersText})` : "";
      writeActivityLog({
        action: "ADDON_ADDED",
        storeId,
        sessionId: session.id,
        user: appUser,
        meta: { itemName: addon.displayName, qty, amount: effectiveUnitPrice * qty },
        note: `Addon: ${addon.displayName}${noteSuffix} x${qty}`,
        serverProfile,
      });
      toast({ title: "Added", description: `${addon.displayName}${noteSuffix} x${qty} added.` });
      // Only reset singleton-flow state. Family flow callers passed their own
      // state and don't depend on these resets.
      if (!override) {
        setSelectedAddon(null);
        setQuantity(1);
        setNote("");
        setPendingOptionGroups([]);
      }
    } catch (e: any) {
      console.error("[AddonsPOSModal] add failed:", e);
      toast({ variant: "destructive", title: "Failed", description: "Could not add add-on to order. " + e.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePickerConfirm = (result: PickerResult) => {
    void performAdd(result.modifiers, result.modifiersText, result.modifiersTotal);
  };

  return (
    <>
      <FamilyOrderModal
        open={familyOrderOpen}
        onOpenChange={setFamilyOrderOpen}
        storeId={storeId}
        group={familyOrderGroup}
        onAdd={async (args: FamilyOrderAddArgs) => {
          await performAdd(args.modifiers, args.modifiersText, args.modifiersTotal, {
            addon: args.variant,
            qty: args.quantity,
            note: args.note,
          });
        }}
      />

      {modifierPickerOpen && selectedAddon && (
        <ModifierPicker
          open={modifierPickerOpen}
          onOpenChange={setModifierPickerOpen}
          itemName={selectedAddon.displayName}
          groups={pendingOptionGroups}
          onConfirm={handlePickerConfirm}
        />
      )}

      <div className={cn("space-y-3 flex flex-col flex-1 min-h-0")}>
        <div className={cn("flex gap-2", isMobile && "shrink-0")}>
          <div className="relative w-full">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search add-ons..."
              className="pl-8"
            />
          </div>
          <Button variant="outline" onClick={refreshStoreAddons} disabled={isLoading}>
            Refresh
          </Button>
        </div>

        <ScrollArea className={cn("pr-2 flex-1 min-h-0")}>
          <div className="flex flex-wrap gap-2 pb-3">
            {categories.map((cat) => (
              <Badge
                key={cat}
                variant={activeCategory === cat ? "default" : "secondary"}
                className="cursor-pointer"
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </Badge>
            ))}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading add-ons...
            </div>
          ) : groupedAddons.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground">No add-ons found.</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
              {groupedAddons.map((group) =>
                group.isGroup ? (
                  <GroupTile key={group.key} group={group} onSelect={handleSelectGroup} />
                ) : (
                  <AddonItem key={group.items[0].id} addon={group.items[0]} onSelect={handleSelectAddon} />
                )
              )}
            </div>
          )}
        </ScrollArea>

        <div className={cn("border-t pt-3 space-y-2 shrink-0")}>
          <div className="text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Selected</span>
              <span className="font-medium">{selectedAddon ? selectedAddon.displayName : "-"}</span>
            </div>
          </div>

          {selectedAddon && (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={140}
              placeholder="Special instructions (optional) — e.g. no onions, extra spicy"
              disabled={isSubmitting || sessionIsLocked}
            />
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={!selectedAddon || isSubmitting || sessionIsLocked}
            >
              <Minus className="h-4 w-4" />
            </Button>

            <QuantityInput
              value={quantity}
              onChange={setQuantity}
              disabled={!selectedAddon || isSubmitting || sessionIsLocked}
              allowDecimal={selectedAddon ? allowsDecimalQty(selectedAddon.uom) : false}
            />

            <Button
              variant="outline"
              size="icon"
              onClick={() => setQuantity((q) => q + 1)}
              disabled={!selectedAddon || isSubmitting || sessionIsLocked}
            >
              <Plus className="h-4 w-4" />
            </Button>

            <Button className="ml-auto" onClick={handleAddToOrder} disabled={!selectedAddon || isSubmitting || isLoading || sessionIsLocked}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Add to Order
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export function AddonsPOSModal({ open, onOpenChange, storeId, session, sessionIsLocked, onAddLine, serverProfile }: AddonsPOSModalProps) {
  const isMobile = useIsMobile();

  const content = (
    <POSContent
      storeId={storeId}
      session={session}
      sessionIsLocked={sessionIsLocked}
      onClose={() => onOpenChange(false)}
      onAddLine={onAddLine}
      serverProfile={serverProfile}
      isMobile={isMobile}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[92dvh]">
          <DrawerHeader className="text-left shrink-0">
            <DrawerTitle>Add-ons</DrawerTitle>
            <DrawerDescription>Select add-on items to add to the order.</DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-4 flex-1 min-h-0 flex flex-col">{content}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88dvh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Add-ons</DialogTitle>
          <DialogDescription>Select add-on items to add to the order.</DialogDescription>
        </DialogHeader>
        {content}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

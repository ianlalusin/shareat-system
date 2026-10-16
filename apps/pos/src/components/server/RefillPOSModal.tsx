

"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { applyRefillTap } from "@/lib/refill-selection";
import { globalInactiveIds } from "@/lib/refill-visibility";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, X } from "lucide-react";
import { collection, onSnapshot, query, where, doc, runTransaction, orderBy, getDocs, writeBatch, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { ScrollArea } from "../ui/scroll-area";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { StorePackage, PendingSession, Refill, StoreRefill, StoreFlavor } from "@/lib/types";
import { Separator } from "../ui/separator";
import { useIsMobile } from "@/hooks/use-mobile";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { createKitchenTickets, getActorStamp } from "../cashier/firestore";
import { writeActivityLog } from "../cashier/activity-log";
import { commitLocalFirst } from "@/lib/offline/commit";
import { printKitchenTicketBackup } from "@/lib/printing/kitchenBackupPrint";
import { makeKitchenBackupDeps } from "@/lib/printing/kitchenBackupDeps";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";

interface RefillPOSModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  session: PendingSession;
  sessionIsLocked?: boolean;
  serverProfile?: { id: string; name: string } | null;
}

type CartItem = {
    refill: StoreRefill;
    flavorIds: string[];
    notes: string;
}

const OTHER_REFILLS_ID = "__OTHER_REFILLS__";

function POSContent({
    storeId,
    session,
    sessionIsLocked,
    onClose,
    serverProfile,
}: {
    storeId: string;
    session: PendingSession;
    sessionIsLocked?: boolean;
    onClose: () => void;
    serverProfile?: { id: string; name: string } | null;
}) {
  const { appUser } = useAuthContext();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const [storeRefills, setStoreRefills] = useState<StoreRefill[]>([]);
  const [allGlobalRefills, setAllGlobalRefills] = useState<Refill[]>([]);
  const [storeFlavors, setStoreFlavors] = useState<StoreFlavor[]>([]);
  const [currentPackage, setCurrentPackage] = useState<StorePackage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const [cart, setCart] = useState<Map<string, CartItem>>(new Map());
  const [activeRefillId, setActiveRefillId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [otherQty, setOtherQty] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!storeId) {
        setIsLoading(false);
        return;
    };
    
    const unsubs: (() => void)[] = [];

    const storeRefillsQuery = query(
        collection(db, "stores", storeId, "storeRefills"),
        where("isEnabled", "==", true),
        orderBy("sortOrder", "asc")
    );
    unsubs.push(onSnapshot(storeRefillsQuery, (snapshot) => {
        setStoreRefills(
          snapshot.docs.map((d) => {
            const data = d.data() as Omit<StoreRefill, "id">;
            return { ...data, id: d.id, refillId: d.id };
          })
        );
    }));
    
    // Read every global refill, not just the active ones: the list has to know
    // which ids are RETIRED so it can hide them. Filtering to isActive==true here
    // is why deactivating an item in the global admin appeared to do nothing.
    const globalRefillsQuery = query(collection(db, "refills"));
    unsubs.push(onSnapshot(globalRefillsQuery, (snapshot) => setAllGlobalRefills(snapshot.docs.map(d => ({id: d.id, ...d.data()} as Refill)))));

    const flavorsQuery = query(
        collection(db, "stores", storeId, "storeFlavors"),
        where("isEnabled", "==", true),
    );
    unsubs.push(onSnapshot(flavorsQuery, (snapshot) => {
        setStoreFlavors(
          snapshot.docs.map((d) => {
            const data = d.data() as Omit<StoreFlavor, "id">;
            return { ...data, id: d.id, flavorId: d.id };
          })
        );
    }));

    if (session.packageOfferingId) {
        const packageRef = doc(db, "stores", storeId, "storePackages", session.packageOfferingId);
        unsubs.push(onSnapshot(packageRef, (docSnap) => {
            if (docSnap.exists()) {
                setCurrentPackage(docSnap.data() as StorePackage);
            }
        }));
    }
    
    Promise.all([getDocs(storeRefillsQuery), getDocs(flavorsQuery)]).finally(() => setIsLoading(false));
    
    return () => unsubs.forEach(unsub => unsub());
  }, [storeId, session.packageOfferingId]);
  
  // Only ACTIVE globals carry the flavor rules; retired ids are hidden outright.
  const globalRefills = useMemo(
    () => allGlobalRefills.filter(r => r.isActive !== false),
    [allGlobalRefills]
  );
  const globalInactive = useMemo(() => globalInactiveIds(allGlobalRefills), [allGlobalRefills]);

  const filteredRefills = useMemo(() => {
    let availableRefills = storeRefills.filter(r => !globalInactive.has(r.refillId));

    if (currentPackage && currentPackage.refillsAllowed && currentPackage.refillsAllowed.length > 0) {
        const allowedIds = new Set(currentPackage.refillsAllowed);
        availableRefills = availableRefills.filter(r => allowedIds.has(r.refillId));
    }

    return availableRefills;
  }, [storeRefills, currentPackage, globalInactive]);

  const otherRefills = useMemo(() => {
    return (storeRefills || [])
      .filter(r => (r as any).isOther === true && !globalInactive.has(r.refillId))
      .sort((a,b) => (a.sortOrder - b.sortOrder) || a.refillName.localeCompare(b.refillName));
  }, [storeRefills, globalInactive]);

  const hasOther = useMemo(() => {
    return otherRefills.some(r => Number(otherQty[r.refillId] || 0) > 0);
  }, [otherRefills, otherQty]);


  const activeCartItem = activeRefillId ? cart.get(activeRefillId) : null;
  const activeGlobalRefill = activeCartItem ? globalRefills.find(r => r.id === activeCartItem.refill.refillId) : null;
  
  // Callable for ANY refill, not just the focused one — the selection rules need
  // to ask "does this meat still need a flavor?" about one that is off screen.
  const allowedFlavorsFor = useCallback((refillId: string): StoreFlavor[] => {
    const globalRefillInfo = globalRefills.find(r => r.id === refillId);
    if (!globalRefillInfo?.requiresFlavor) return [];

    const globallyAllowedFlavorIds = new Set(globalRefillInfo.allowedFlavorIds || []);
    const storeEnabledFlavorIds = new Set(storeFlavors.map(f => f.flavorId));

    const finalAllowedIds = globallyAllowedFlavorIds.size === 0
      ? storeEnabledFlavorIds
      : new Set([...globallyAllowedFlavorIds].filter(id => storeEnabledFlavorIds.has(id)));

    const allowedStoreFlavors = storeFlavors.filter(f => finalAllowedIds.has(f.flavorId));

    const initialFlavorIds = new Set(session.initialFlavorIds || []);
    return [...allowedStoreFlavors].sort((a, b) => {
        const aIsInitial = initialFlavorIds.has(a.flavorId);
        const bIsInitial = initialFlavorIds.has(b.flavorId);
        if (aIsInitial && !bIsInitial) return -1;
        if (!aIsInitial && bIsInitial) return 1;
        return ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) || a.flavorName.localeCompare(b.flavorName);
    });
  }, [globalRefills, storeFlavors, session.initialFlavorIds]);

  const needsFlavorFor = useCallback(
    (refillId: string) => allowedFlavorsFor(refillId).length > 0,
    [allowedFlavorsFor]
  );

  const sortedAllowedFlavors = useMemo(
    () => (activeCartItem ? allowedFlavorsFor(activeCartItem.refill.refillId) : []),
    [activeCartItem, allowedFlavorsFor]
  );


  // Cart and focus move together through one pure transition. Updating them
  // independently let focus land on an entry that had just been removed (which
  // happens when you deselect a refill that is NOT the focused one), after
  // which the flavor picker could never reappear.
  const handleSelectRefill = (refill: StoreRefill) => {
    const next = applyRefillTap<CartItem>({
      cart,
      activeId: activeRefillId,
      tappedId: refill.refillId,
      needsFlavor: needsFlavorFor,
      createItem: () => ({ refill, flavorIds: [], notes: "" }),
    });
    setCart(next.cart);
    setActiveRefillId(next.activeId);
  };

  const handleSelectOtherRefills = () => {
    // No createItem: this panel moves focus but never becomes a cart entry.
    const next = applyRefillTap<CartItem>({
      cart,
      activeId: activeRefillId,
      tappedId: OTHER_REFILLS_ID,
      needsFlavor: needsFlavorFor,
    });
    setCart(next.cart);
    setActiveRefillId(next.activeId);
  };

  // Fire-and-forget backup print of offline-created kitchen tickets to the
  // shared Bluetooth kitchen printer. Never awaited into the order flow;
  // any dep (or the kitchenLocations fetch) throwing is swallowed.
  const printOfflineKitchenTickets = (tickets: Array<Record<string, any>>) => {
    if (!tickets.length) return;
    void (async () => {
      const klSnap = await getDocs(collection(db, "stores", storeId, "kitchenLocations"));
      const kitchenLocations = klSnap.docs.map((d) => ({ id: d.id, printOnOutage: (d.data() as any).printOnOutage }));
      // `deps` (and its stampTicket closure) is built once for the whole batch,
      // but each ticket in the loop can belong to a different station. Map
      // ticketId -> kitchenLocationId up front so the shared closure can still
      // patch the correct rtKdsTickets projection per ticket.
      const stationByTicketId = new Map<string, string>();
      for (const t of tickets) {
        if (t?.id && t?.kitchenLocationId) stationByTicketId.set(t.id, t.kitchenLocationId);
      }
      const deps = makeKitchenBackupDeps({
        kitchenLocations,
        stampTicket: (ticketId) => {
          const ref = doc(db, "stores", storeId, "sessions", session.id, "kitchentickets", ticketId);
          void updateDoc(ref, { printedOffline: true, printedOfflineAt: Date.now(), printedOfflineDevice: getBrowserDeviceId() }).catch(() => {});
          // Also patch the rtKdsTickets projection the KDS page actually reads
          // from, so the auto-ack effect there can see the stamp.
          const _stationId = stationByTicketId.get(ticketId);
          if (_stationId) {
            void updateDoc(doc(db, "stores", storeId, "rtKdsTickets", _stationId), {
              [`tickets.${ticketId}.printedOffline`]: true,
              [`tickets.${ticketId}.printedOfflineAt`]: Date.now(),
            }).catch(() => {});
          }
        },
        alert: (message) => toast({ variant: "destructive", title: "Kitchen printer", description: message }),
      });
      for (const ticket of tickets) {
        await printKitchenTicketBackup(ticket as any, deps).catch(() => {});
      }
    })().catch(() => {});
  };

  const handleAddToOrder = async () => {
    if (sessionIsLocked) {
      toast({ variant: "destructive", title: "Session Closed", description: "Session is closed. KDS updates are disabled." });
      return;
    }
    const hasOtherNow = otherRefills.some(r => Number(otherQty[r.refillId] || 0) > 0);
    if (!appUser || (cart.size === 0 && !hasOtherNow)) {
      toast({ variant: "destructive", title: "Cannot Add Item", description: "Your order list is empty." });
      return;
    }
    
    // Validate all items in cart
    for (const item of cart.values()) {
        if (!item.refill.kitchenLocationId) {
            toast({ variant: 'destructive', title: 'Kitchen Not Assigned', description: `"${item.refill.refillName}" has no kitchen location assigned.` });
            return;
        }
        const globalRefillInfo = globalRefills.find(r => r.id === item.refill.refillId);
        if (globalRefillInfo?.requiresFlavor && sortedAllowedFlavors.length > 0 && item.flavorIds.length === 0) {
            toast({ variant: 'destructive', title: 'Flavor Required', description: `"${item.refill.refillName}" requires at least one flavor.` });
            setActiveRefillId(item.refill.refillId); // Switch to the item that needs attention
            return;
        }
    }

    // Validate other refills (rice/cheese)
    const otherStation = storeRefills.find(r => !!r.kitchenLocationId);
    if (hasOtherNow && !otherStation?.kitchenLocationId) {
      toast({ variant: 'destructive', title: 'Kitchen Not Assigned', description: 'No kitchen location is configured to receive Other Refills.' });
      return;
    }

    setIsSubmitting(true);
    
    try {
        const actor = getActorStamp(appUser);
        if (isOnline) {
            await runTransaction(db, async (tx) => {
                for (const item of cart.values()) {
                    const stationId = item.refill.kitchenLocationId;
                    if (!stationId) {
                        throw new Error(`Refill item "${item.refill.refillName}" is missing an assigned kitchen location.`);
                    }

                    const selectedFlavorNames = item.flavorIds.map(id => storeFlavors.find(f => f.flavorId === id)?.flavorName || id);
                    const flavorNote = selectedFlavorNames.length > 0 ? selectedFlavorNames.join(", ") : undefined;

                    await createKitchenTickets(
                        db,
                        storeId,
                        session.id,
                        session,
                        'refill',
                        {
                            itemId: item.refill.refillId,
                            itemName: item.refill.refillName,
                            kitchenLocationId: stationId,
                            kitchenLocationName: item.refill.kitchenLocationName,
                            billLineId: null,
                        },
                        1, // Qty for refill ticket is always 1
                        actor,
                        { tx },
                        item.notes.trim(),
                        { flavorNote }
                    );
                }
                // Other Refills tickets (grouped by kitchenLocationId)
                if (hasOtherNow) {
                    const byStation = new Map<string, { name?: string | null; entries: Array<[string, number]> }>();

                    for (const r of otherRefills) {
                        const qty = Number(otherQty[r.refillId] || 0);
                        if (qty <= 0) continue;

                        const stationId = r.kitchenLocationId;
                        if (!stationId) {
                            throw new Error(`Other refill "${r.refillName}" is missing an assigned kitchen location.`);
                        }

                        const bucket = byStation.get(stationId) || { name: r.kitchenLocationName, entries: [] };
                        bucket.name = bucket.name || r.kitchenLocationName;
                        bucket.entries.push([r.refillName, qty]);
                        byStation.set(stationId, bucket);
                    }

                    for (const [stationId, bucket] of byStation.entries()) {
                        await createKitchenTickets(
                            db,
                            storeId,
                            session.id,
                            session,
                            'refill',
                            {
                                itemId: "OTHER_REFILLS",
                                itemName: "OTHER REFILLS",
                                kitchenLocationId: stationId,
                                kitchenLocationName: bucket.name,
                                billLineId: null,
                            },
                            1,
                            actor,
                            { tx },
                            "",
                            { refillRequest: Object.fromEntries(bucket.entries) }
                        );
                    }
                }


            });
        } else {
            const batch = writeBatch(db);
            const offlineTicketPayloads: Array<Record<string, any>> = [];
            for (const item of cart.values()) {
                const stationId = item.refill.kitchenLocationId;
                if (!stationId) {
                    throw new Error(`Refill item "${item.refill.refillName}" is missing an assigned kitchen location.`);
                }

                const selectedFlavorNames = item.flavorIds.map(id => storeFlavors.find(f => f.flavorId === id)?.flavorName || id);
                const flavorNote = selectedFlavorNames.length > 0 ? selectedFlavorNames.join(", ") : undefined;

                const ticketPayload = await createKitchenTickets(
                    db,
                    storeId,
                    session.id,
                    session,
                    'refill',
                    {
                        itemId: item.refill.refillId,
                        itemName: item.refill.refillName,
                        kitchenLocationId: stationId,
                        kitchenLocationName: item.refill.kitchenLocationName,
                        billLineId: null,
                    },
                    1, // Qty for refill ticket is always 1
                    actor,
                    { batch },
                    item.notes.trim(),
                    { flavorNote }
                );
                if (ticketPayload) offlineTicketPayloads.push(ticketPayload);
            }
            // Other Refills tickets (grouped by kitchenLocationId)
            if (hasOtherNow) {
                const byStation = new Map<string, { name?: string | null; entries: Array<[string, number]> }>();

                for (const r of otherRefills) {
                    const qty = Number(otherQty[r.refillId] || 0);
                    if (qty <= 0) continue;

                    const stationId = r.kitchenLocationId;
                    if (!stationId) {
                        throw new Error(`Other refill "${r.refillName}" is missing an assigned kitchen location.`);
                    }

                    const bucket = byStation.get(stationId) || { name: r.kitchenLocationName, entries: [] };
                    bucket.name = bucket.name || r.kitchenLocationName;
                    bucket.entries.push([r.refillName, qty]);
                    byStation.set(stationId, bucket);
                }

                for (const [stationId, bucket] of byStation.entries()) {
                    const ticketPayload = await createKitchenTickets(
                        db,
                        storeId,
                        session.id,
                        session,
                        'refill',
                        {
                            itemId: "OTHER_REFILLS",
                            itemName: "OTHER REFILLS",
                            kitchenLocationId: stationId,
                            kitchenLocationName: bucket.name,
                            billLineId: null,
                        },
                        1,
                        actor,
                        { batch },
                        "",
                        { refillRequest: Object.fromEntries(bucket.entries) }
                    );
                    if (ticketPayload) offlineTicketPayloads.push(ticketPayload);
                }
            }

            commitLocalFirst(batch, (err) => console.error("[RefillPOSModal] offline sync failed", err));

            // Fire-and-forget backup print — one per ticket created in this
            // offline batch. Never awaited into the order flow.
            printOfflineKitchenTickets(offlineTicketPayloads);
        }

        const refillNames = [...cart.entries()].map(([id, qty]) => `${id} x${qty}`).join(", ");
        writeActivityLog({ action: "REFILL_ADDED", storeId, sessionId: session.id, user: appUser, note: `Refill ordered: ${refillNames || "other"}`, meta: { qty: cart.size + (hasOther ? 1 : 0) }, serverProfile });
        toast({ title: `Sent ${cart.size + (hasOther ? 1 : 0)} refill(s) to the kitchen.` });
        handleReset();

    } catch(e: any) {
        toast({ variant: 'destructive', title: "Order Failed", description: e.message });
    } finally {
        setIsSubmitting(false);
    }
  };

  const handleRepeatFirstOrder = async () => {
    if (sessionIsLocked) {
      toast({ variant: "destructive", title: "Session Closed", description: "Session is closed. KDS updates are disabled." });
      return;
    }
    if (!appUser || !currentPackage) {
        toast({ variant: "destructive", title: "Cannot Repeat Order", description: "Package information not found." });
        return;
    }
    setIsSubmitting(true);

    try {
        const allowedRefillIds = new Set(currentPackage.refillsAllowed || []);
        const refillsToOrder = storeRefills.filter(sr => sr.isEnabled && allowedRefillIds.has(sr.refillId) && sr.kitchenLocationId);
        
        if (refillsToOrder.length === 0) {
            toast({ variant: "destructive", title: "No Refills", description: "No valid refills are enabled for this package." });
            setIsSubmitting(false);
            return;
        }

        const first = refillsToOrder[0];
        if (!first.kitchenLocationId) {
            toast({ variant: "destructive", title: "Kitchen Not Assigned", description: `The first available refill "${first.refillName}" has no kitchen location assigned.` });
            setIsSubmitting(false);
            return;
        }

        const flavorIds = session.initialFlavorIds || [];
        const flavorNames = flavorIds
          .map(id => storeFlavors.find(f => f.flavorId === id)?.flavorName || id)
          .filter(Boolean);
        
        const flavorNote = flavorNames.length ? flavorNames.join(", ") : undefined;
        const notes = (activeCartItem?.notes || "").trim();

        const guestCount = session.guestCountFinal || session.guestCountCashierInitial || 1;
        const packageName = (currentPackage as any)?.packageName || (currentPackage as any)?.name || session.packageSnapshot?.name || "Package";
        const itemName = `REFILL - ${packageName}`;
        
        const actor = getActorStamp(appUser);
        if (isOnline) {
            await runTransaction(db, async (tx) => {
                await createKitchenTickets(
                    db,
                    storeId,
                    session.id,
                    session,
                    'refill',
                    {
                        itemId: "REFILL_PACKAGE_FIRST_ORDER",
                        itemName: itemName,
                        kitchenLocationId: first.kitchenLocationId!,
                        kitchenLocationName: first.kitchenLocationName,
                        billLineId: null,
                    },
                    1,
                    actor,
                    { tx },
                    notes,
                    { flavorNote }
                );
            });
        } else {
            const batch = writeBatch(db);
            const ticketPayload = await createKitchenTickets(
                db,
                storeId,
                session.id,
                session,
                'refill',
                {
                    itemId: "REFILL_PACKAGE_FIRST_ORDER",
                    itemName: itemName,
                    kitchenLocationId: first.kitchenLocationId!,
                    kitchenLocationName: first.kitchenLocationName,
                    billLineId: null,
                },
                1,
                actor,
                { batch },
                notes,
                { flavorNote }
            );
            commitLocalFirst(batch, (err) => console.error("[RefillPOSModal] offline sync failed", err));

            // Fire-and-forget backup print. Never awaited into the order flow.
            if (ticketPayload) printOfflineKitchenTickets([ticketPayload]);
        }

        toast({
            title: "Sent refill ticket to kitchen.",
            description: itemName
        });

        onClose();

    } catch (e: any) {
        toast({ variant: 'destructive', title: 'Order Failed', description: e.message });
    } finally {
        setIsSubmitting(false);
    }
  };


  const handleReset = () => {
    setCart(new Map());
    setActiveRefillId(null);
    setOtherQty({});
    onClose();
  }
  
  /**
   * One flavor per meat: picking another flavor replaces the current one.
   * Mirrors the customer app, so both sides enforce the same rule.
   */
  const handleFlavorSelect = (flavorId: string) => {
    if (!activeRefillId) return;

    setCart(prev => {
        const newCart = new Map(prev);
        const item = newCart.get(activeRefillId);
        if (item) {
            const isSelected = item.flavorIds[0] === flavorId;
            newCart.set(activeRefillId, { ...item, flavorIds: isSelected ? [] : [flavorId] });
        }
        return newCart;
    });
  }
  
  const handleNotesChange = (notes: string) => {
    if (!activeRefillId) return;
    setCart(prev => {
      const newCart = new Map(prev);
      const item = newCart.get(activeRefillId);
      if (item) {
        newCart.set(activeRefillId, { ...item, notes });
      }
      return newCart;
    });
  };

  const handleRemoveFromCart = (refillId: string) => {
      setCart(prev => {
          const newCart = new Map(prev);
          newCart.delete(refillId);
          // If the removed item was the active one, reset active selection
          if (activeRefillId === refillId) {
              setActiveRefillId(newCart.keys().next().value || null);
          }
          return newCart;
      });
  }

  const defaultFlavorNames = useMemo(() => {
    if (!session.initialFlavorIds || !storeFlavors) return "";
    return session.initialFlavorIds
        .map(id => storeFlavors.find(f => f.flavorId === id)?.flavorName)
        .filter(Boolean)
        .join(", ");
  }, [session.initialFlavorIds, storeFlavors]);
  
  const initialFlavorIdSet = useMemo(() => new Set(session.initialFlavorIds || []), [session.initialFlavorIds]);

  const needsFlavors = !!activeGlobalRefill?.requiresFlavor && sortedAllowedFlavors.length > 0;

  return (
    <div className="h-[70vh] flex flex-col">
      {session.sessionMode === 'package_dinein' && (
        <div className="p-4 border-b">
            <div className="flex items-start sm:items-center gap-4 flex-col sm:flex-row">
                <Button 
                    variant="destructive"
                    onClick={handleRepeatFirstOrder}
                    disabled={isSubmitting || sessionIsLocked}
                    className="flex-shrink-0"
                >
                    <RefreshCw className="mr-2 h-4 w-4" /> Repeat First Order
                </Button>
                <div className="text-xs text-muted-foreground">
                    <p>Sends all refills allowed by the package with the default flavors.</p>
                    {currentPackage?.packageName && (
                    <p>
                        <span className="font-semibold">{currentPackage.packageName}:</span> <span className="text-destructive font-medium">{defaultFlavorNames}</span>
                    </p>
                    )}
                </div>
            </div>
            <Separator className="mt-2 mb-0" />
        </div>
      )}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 p-4 overflow-y-auto">
        {/* Left Panel: Refills */}
        <div className="md:col-span-1 border-r pr-4 flex flex-col">
          <h3 className="font-semibold mb-2">1. Select Refills</h3>
          <ScrollArea className="flex-1">
            <div className="space-y-1">
              {isLoading ? (
                <Loader2 className="mx-auto my-16 animate-spin"/>
              ) : (
                filteredRefills.map(refill => (
                  <button
                    key={refill.refillId}
                    onClick={() => handleSelectRefill(refill)}
                    className={cn(
                        "w-full text-left p-2 border rounded-md hover:bg-muted/50 transition-colors focus:outline-none",
                        cart.has(refill.refillId) && "bg-destructive text-white border-destructive font-bold",
                        activeRefillId === refill.refillId && !cart.has(refill.refillId) && "bg-muted font-semibold",
                        // Focused item is outlined: tapping a selected item that is
                        // NOT focused reopens it, tapping the focused one removes it.
                        activeRefillId === refill.refillId && "ring-2 ring-destructive/40 ring-offset-1"
                    )}
                  >
                    {refill.refillName}
                  </button>
                ))
              )}

              <button
                type="button"
                onClick={handleSelectOtherRefills}
                className={cn(
                  "w-full text-left p-2 border rounded-md hover:bg-muted/50 transition-colors focus:outline-none",
                  activeRefillId === OTHER_REFILLS_ID && "bg-destructive/10 text-destructive border-destructive font-bold"
                )}
              >
                Other Refills
              </button>
               {filteredRefills.length === 0 && !isLoading && (
                 <p className="text-center text-sm text-muted-foreground py-10">No refills available for this package.</p>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right Panel: Flavors & Notes for Active Item */}
        <div className="md:col-span-2 flex flex-col gap-4">
          <h3 className="font-semibold">2. Customize Selection</h3>
          {activeRefillId === OTHER_REFILLS_ID ? (
            <div className="flex-1 flex flex-col gap-4">
              <div className="border rounded-lg">
                <div className="p-4 space-y-4">
                  <h3 className="font-semibold">Other Refills</h3>

                  {otherRefills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No other refills configured (toggle "Other" in Store Refills).</p>
                  ) : (
                    otherRefills.map((r) => {
                      const k = r.refillId;
                      const v = Number(otherQty[k] || 0);
                      return (
                        <div key={k} className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{r.refillName}</p>
                            <p className="text-xs text-muted-foreground">Quantity</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() =>
                                setOtherQty((prev) => ({
                                  ...prev,
                                  [k]: Math.max(0, Number(prev[k] || 0) - 1),
                                }))
                              }
                            >
                              -
                            </Button>
                            <div className="w-10 text-center font-mono">{v}</div>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              onClick={() =>
                                setOtherQty((prev) => ({
                                  ...prev,
                                  [k]: Number(prev[k] || 0) + 1,
                                }))
                              }
                            >
                              +
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}


                </div>
              </div>
              <div className="flex-1 flex items-center justify-center text-center text-muted-foreground bg-muted/50 rounded-lg">
                <p>These refills are always available and optional.</p>
              </div>
            </div>
          ) : activeCartItem ? (
            <div className="flex-1 flex flex-col gap-4">
              <div className={cn("border rounded-lg", !needsFlavors && "bg-muted/50")}>
                <div className="p-4 space-y-2">
                  <h3 className="font-semibold">
                    {needsFlavors ? "Flavor — choose 1 per meat" : "Flavors"}
                  </h3>
                  {needsFlavors ? (
                    <RadioGroup
                      value={activeCartItem.flavorIds[0] ?? ""}
                      onValueChange={handleFlavorSelect}
                      className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto"
                    >
                        {sortedAllowedFlavors.map(flavor => (
                            <div key={flavor.flavorId} className="flex items-center gap-2">
                                <RadioGroupItem
                                    id={`flavor-${flavor.flavorId}`}
                                    value={flavor.flavorId}
                                />
                                <Label
                                  htmlFor={`flavor-${flavor.flavorId}`} 
                                  className={cn(
                                    "font-normal",
                                    initialFlavorIdSet.has(flavor.flavorId) && "text-destructive font-medium"
                                  )}
                                >
                                    {flavor.flavorName}
                                </Label>
                            </div>
                        ))}
                    </RadioGroup>
                  ) : (
                    <p className="text-sm text-muted-foreground">This item does not require flavors.</p>
                  )}
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-2">
                <Label htmlFor="notes">Notes (Optional)</Label>
                <Textarea 
                  id="notes" 
                  value={activeCartItem.notes} 
                  onChange={e => handleNotesChange(e.target.value)} 
                  placeholder="e.g., extra hot, no onions..." 
                  className="flex-1"
                />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center text-muted-foreground bg-muted/50 rounded-lg">
                <p>Select a refill item from the left to customize it.</p>
            </div>
          )}
        </div>
      </div>
      
      <DialogFooter className="p-4 border-t">
        <Button variant="ghost" onClick={handleReset}>Cancel</Button>
        <Button 
          onClick={handleAddToOrder} 
          disabled={isSubmitting || sessionIsLocked || (cart.size === 0 && !hasOther)}
        >
           {isSubmitting ? <Loader2 className="animate-spin" /> : `Send ${cart.size + (hasOther ? 1 : 0)} Item(s) to Kitchen`}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function RefillPOSModal(props: RefillPOSModalProps) {
  const isMobile = useIsMobile();
  
  const handleOpenChange = (open: boolean) => {
    if (!open) props.onOpenChange(false);
  };

  if (isMobile) {
    return (
      <Drawer open={props.open} onOpenChange={handleOpenChange}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle>Order Refill</DrawerTitle>
            <DrawerDescription>Select refill items and any required flavors.</DrawerDescription>
          </DrawerHeader>
          <POSContent {...props} onClose={() => props.onOpenChange(false)} />
        </DrawerContent>
      </Drawer>
    );
  }
  
  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl p-0 gap-0">
          <DialogHeader className="p-4 pb-0">
            <DialogTitle>Order Refill</DialogTitle>
            <DialogDescription>Select refill items and any required flavors.</DialogDescription>
          </DialogHeader>
          <POSContent {...props} onClose={() => props.onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

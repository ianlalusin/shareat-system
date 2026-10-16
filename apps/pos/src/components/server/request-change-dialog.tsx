

"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Minus, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { db } from "@/lib/firebase/client";
import { doc, updateDoc, serverTimestamp, getDoc, writeBatch } from "firebase/firestore";
import { useAuthContext } from "@/context/auth-context";
import { isScheduleActiveNow } from "@/lib/utils/isScheduleActiveNow";
import { useIsMobile } from "@/hooks/use-mobile";
import { writeActivityLog } from "@/components/cashier/activity-log";
import { QuantityInput } from "../cashier/quantity-input";
import type { PendingSession, StorePackage, MenuSchedule } from "@/lib/types";

const REASON_OPTIONS = {
  guest_request: "Guest Request",
  guest_left: "Guest Left",
  additional_guest_arrived: "Additional Guest Arrived",
  item_unavailable: "Item Unavailable",
  other: "Other",
};
type ReasonKey = keyof typeof REASON_OPTIONS;

const baseSchema = z.object({
  reason: z.string({ required_error: "A reason is required." }),
  reasonNote: z.string().optional(),
});

const guestCountSchema = baseSchema.extend({
  requestedCount: z.coerce.number().min(0, "Guest count must be 0 or more."),
}).refine(data => !(data.reason === 'other' && (!data.reasonNote || data.reasonNote.trim() === '')), {
    message: "Details are required when reason is 'Other'.",
    path: ["reasonNote"],
});

const packageSchema = baseSchema.extend({
  requestedPackageId: z.string({ required_error: "Please select a package." }),
}).refine(data => !(data.reason === 'other' && (!data.reasonNote || data.reasonNote.trim() === '')), {
    message: "Details are required when reason is 'Other'.",
    path: ["reasonNote"],
});


interface RequestChangeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: PendingSession;
  storeId: string;
  storePackages: StorePackage[];
  schedules: Map<string, MenuSchedule>;
  serverProfile?: { id: string; name: string } | null;
}

const DIALOG_TABS = [
    { value: "guest", label: "Guest Count" },
    { value: "package", label: "Package" },
]

function ChangeRequestForm({ session, storeId, storePackages, schedules, onClose, serverProfile }: RequestChangeDialogProps) {
  const { appUser } = useAuthContext();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState("guest");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guestForm = useForm<z.infer<typeof guestCountSchema>>({
    resolver: zodResolver(guestCountSchema),
    defaultValues: { requestedCount: session.guestCountFinal || 0, reasonNote: "" },
  });

  const packageForm = useForm<z.infer<typeof packageSchema>>({
    resolver: zodResolver(packageSchema),
    defaultValues: { requestedPackageId: session.packageOfferingId, reasonNote: "" },
  });

  const watchedGuestReason = guestForm.watch("reason");
  const watchedPackageReason = packageForm.watch("reason");
  const guestCountValue = guestForm.watch("requestedCount");

  const availablePackages = useMemo(() => {
    return storePackages.filter(pkg => {
        if (!pkg.isEnabled) return false;
        // Every bundle stays selectable regardless of headcount: its cap is the
        // number of guests the flat price covers, not a seating limit. Guests
        // beyond it are billed on the Extra Pax line. The option label shows the
        // cap, so the cashier can see what they're choosing.
        if (!pkg.menuScheduleId) return true; // Always available if no schedule
        const schedule = schedules.get(pkg.menuScheduleId);
        if (!schedule) return true; // Fail open if schedule not found
        return isScheduleActiveNow(schedule);
    });
  }, [storePackages, schedules]);


  const lastSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Reset only when the session actually changes. Parent spreads into a
    // fresh object each snapshot tick, so depending on `session` directly
    // would wipe typed input. Guard with the id instead.
    if (lastSessionIdRef.current === session.id) return;
    lastSessionIdRef.current = session.id;
    guestForm.reset({ requestedCount: session.guestCountFinal || 0, reasonNote: "" });
    packageForm.reset({ requestedPackageId: session.packageOfferingId, reasonNote: "" });
  }, [session, guestForm, packageForm]);
  
  const checkSessionLock = async () => {
    const sessionRef = doc(db, "stores", storeId, "sessions", session.id);
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists() || sessionSnap.data().status === 'closed' || sessionSnap.data().isPaid) {
        toast({ variant: 'destructive', title: 'Action Failed', description: 'This session has already been closed.' });
        onClose();
        return true;
    }
    return false;
  }

  const handleGuestSubmit = async (data: z.infer<typeof guestCountSchema>) => {
    if (!appUser || !session.tableId || await checkSessionLock()) return;
    setIsSubmitting(true);
    const batch = writeBatch(db);
    const sessionRef = doc(db, "stores", storeId, "sessions", session.id);
    const sessionProjectionRef = doc(db, `stores/${storeId}/activeSessions`, session.id);
    
    try {
        // Update session doc (truth)
        batch.update(sessionRef, {
            "guestCountChange.status": "pending",
            "guestCountChange.requestedCount": data.requestedCount,
            "guestCountChange.reason": data.reason,
            "guestCountChange.reasonNote": data.reason === 'other' ? data.reasonNote?.trim() : (data.reasonNote?.trim() || null),
            "guestCountChange.requestedByUid": appUser.uid,
            "guestCountChange.requestedAt": serverTimestamp(),
        });
        
        // Update session projection for UI hint
        batch.update(sessionProjectionRef, {
            "guestCountChange.status": "pending",
            "guestCountChange.requestedCount": data.requestedCount,
            updatedAt: serverTimestamp()
        });

      await batch.commit();
      writeActivityLog({ action: "GUEST_COUNT_REQUESTED", storeId, sessionId: session.id, user: appUser, meta: { beforeQty: session.guestCountFinal ?? undefined, newQty: data.requestedCount, reason: data.reason }, note: `Guest count change requested: ${session.guestCountFinal} → ${data.requestedCount}`, serverProfile });
      toast({ title: "Request Sent", description: "Guest count change request sent to cashier for approval." });
      onClose();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Request Failed", description: e.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePackageSubmit = async (data: z.infer<typeof packageSchema>) => {
    if (!appUser || !session.tableId || await checkSessionLock()) return;
    const selectedPackage = availablePackages.find(p => p.packageId === data.requestedPackageId);
    if (!selectedPackage) {
      toast({ variant: "destructive", title: "Invalid Package" });
      return;
    }
    setIsSubmitting(true);
    const batch = writeBatch(db);
    const sessionRef = doc(db, "stores", storeId, "sessions", session.id);
    const sessionProjectionRef = doc(db, `stores/${storeId}/activeSessions`, session.id);

    try {
        const requestedPackageSnapshot = {
            name: selectedPackage.packageName,
            pricePerHead: selectedPackage.pricePerHead,
            ...(selectedPackage.isBundle
                ? {
                    isBundle: true,
                    bundlePrice: Number(selectedPackage.bundlePrice ?? 0),
                    bundleMaxCap: Number(selectedPackage.bundleMaxCap ?? 0),
                    bundleExtraHeadPrice: Number(selectedPackage.bundleExtraHeadPrice ?? 0),
                  }
                : {}),
        };

        batch.update(sessionRef, {
            "packageChange.status": "pending",
            "packageChange.requestedPackageId": data.requestedPackageId,
            "packageChange.requestedPackageSnapshot": requestedPackageSnapshot,
            "packageChange.reason": data.reason,
            "packageChange.reasonNote": data.reason === 'other' ? data.reasonNote?.trim() : (data.reasonNote?.trim() || null),
            "packageChange.requestedByUid": appUser.uid,
            "packageChange.requestedAt": serverTimestamp(),
        });

        batch.update(sessionProjectionRef, {
            "packageChange.status": "pending",
            "packageChange.requestedPackageSnapshot": requestedPackageSnapshot,
            updatedAt: serverTimestamp()
        });

      await batch.commit();
      writeActivityLog({ action: "PACKAGE_CHANGE_REQUESTED", storeId, sessionId: session.id, user: appUser, meta: { itemName: selectedPackage.packageName }, note: `Package change requested: ${session.packageSnapshot?.name} → ${selectedPackage.packageName}`, serverProfile });
      toast({ title: "Request Sent", description: "Package change request sent to cashier for approval." });
      onClose();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Request Failed", description: e.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isGuestRequestPending = session.guestCountChange?.status === "pending";
  const isPackageRequestPending = session.packageChange?.status === "pending";
  const isSessionLocked = session.status === "closed";

    return (
        <>
            {isSessionLocked && (
                <Alert variant="destructive" className="m-4">
                    <AlertDescription>This session is closed and cannot be modified.</AlertDescription>
                </Alert>
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="p-4">
            {isMobile ? (
                <Select value={activeTab} onValueChange={setActiveTab}>
                    <SelectTrigger>
                        <SelectValue placeholder="Select a change type..." />
                    </SelectTrigger>
                    <SelectContent>
                        {DIALOG_TABS.map(tab => (
                            <SelectItem key={tab.value} value={tab.value}>{tab.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <TabsList className="grid w-full grid-cols-2">
                    {DIALOG_TABS.map(tab => (
                        <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>
                    ))}
                </TabsList>
            )}

            <TabsContent value="guest">
                <form onSubmit={guestForm.handleSubmit(handleGuestSubmit)} className="space-y-4 pt-4">
                {isGuestRequestPending && (
                    <Alert variant="destructive">
                    <AlertDescription>A guest count change request is already pending for this session.</AlertDescription>
                    </Alert>
                )}
                <div className="space-y-2">
                    <Label htmlFor="requestedCount">New Guest Count</Label>
                    <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => guestForm.setValue("requestedCount", Math.max(0, guestCountValue - 1))}
                    >
                        <Minus />
                    </Button>
                    <Controller
                        name="requestedCount"
                        control={guestForm.control}
                        render={({ field }) => (
                        <QuantityInput
                            value={field.value}
                            onChange={field.onChange}
                            className="w-full text-center"
                        />
                        )}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => guestForm.setValue("requestedCount", guestCountValue + 1)}
                    >
                        <Plus />
                    </Button>
                    </div>
                    {guestForm.formState.errors.requestedCount && <p className="text-sm text-destructive">{guestForm.formState.errors.requestedCount.message}</p>}
                </div>
                <div className="space-y-2">
                    <Label>Reason</Label>
                    <Controller
                    name="reason"
                    control={guestForm.control}
                    render={({ field, fieldState }) => (
                        <>
                        <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger><SelectValue placeholder="Select a reason..." /></SelectTrigger>
                            <SelectContent>
                            {Object.entries(REASON_OPTIONS).map(([key, value]) => (
                                <SelectItem key={key} value={key}>{value}</SelectItem>
                            ))}
                            </SelectContent>
                        </Select>
                        {fieldState.error && <p className="text-sm text-destructive">{fieldState.error.message}</p>}
                        </>
                    )}
                    />
                </div>
                {watchedGuestReason === 'other' && (
                    <div className="space-y-2">
                        <Label htmlFor="guestNote">Details for "Other"</Label>
                        <Textarea id="guestNote" {...guestForm.register("reasonNote")} />
                        {guestForm.formState.errors.reasonNote && <p className="text-sm text-destructive">{guestForm.formState.errors.reasonNote.message}</p>}
                    </div>
                )}
                <Button type="submit" disabled={isSubmitting || isGuestRequestPending || isSessionLocked} className="w-full">
                    {isSubmitting ? <Loader2 className="animate-spin" /> : "Request Guest Count Change"}
                </Button>
                </form>
            </TabsContent>
            <TabsContent value="package">
                <form onSubmit={packageForm.handleSubmit(handlePackageSubmit)} className="space-y-4 pt-4">
                {isPackageRequestPending && (
                    <Alert variant="destructive">
                    <AlertDescription>A package change request is already pending for this session.</AlertDescription>
                    </Alert>
                )}
                <div className="space-y-2">
                    <Label>New Package</Label>
                    <Controller
                    name="requestedPackageId"
                    control={packageForm.control}
                    render={({ field }) => (
                        <Select onValueChange={field.onChange} value={field.value}>
                        <SelectTrigger><SelectValue placeholder="Select a package..." /></SelectTrigger>
                        <SelectContent>
                            {availablePackages.length > 0 ? (
                                availablePackages.map(p => (
                                <SelectItem key={p.packageId} value={p.packageId}>
                                    {p.isBundle
                                        ? `${p.packageName} - ₱${p.bundlePrice ?? 0} (≤${p.bundleMaxCap ?? 1} pax)`
                                        : `${p.packageName} - ₱${p.pricePerHead}/head`}
                                </SelectItem>
                                ))
                            ) : (
                                <div className="p-4 text-center text-sm text-muted-foreground">
                                    No packages available at this time.
                                </div>
                            )}
                        </SelectContent>
                        </Select>
                    )}
                    />
                    {packageForm.formState.errors.requestedPackageId && <p className="text-sm text-destructive">{packageForm.formState.errors.requestedPackageId.message}</p>}
                </div>
                <div className="space-y-2">
                    <Label>Reason</Label>
                    <Controller
                    name="reason"
                    control={packageForm.control}
                    render={({ field, fieldState }) => (
                        <>
                        <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger><SelectValue placeholder="Select a reason..." /></SelectTrigger>
                            <SelectContent>
                            {Object.entries(REASON_OPTIONS).map(([key, value]) => (
                                <SelectItem key={key} value={key}>{value}</SelectItem>
                            ))}
                            </SelectContent>
                        </Select>
                        {fieldState.error && <p className="text-sm text-destructive">{fieldState.error.message}</p>}
                        </>
                    )}
                    />
                </div>
                {watchedPackageReason === 'other' && (
                    <div className="space-y-2">
                        <Label htmlFor="packageNote">Details for "Other"</Label>
                        <Textarea id="packageNote" {...packageForm.register("reasonNote")} />
                        {packageForm.formState.errors.reasonNote && <p className="text-sm text-destructive">{packageForm.formState.errors.reasonNote.message}</p>}
                    </div>
                )}
                <Button type="submit" disabled={isSubmitting || isPackageRequestPending || isSessionLocked || availablePackages.length === 0} className="w-full">
                    {isSubmitting ? <Loader2 className="animate-spin" /> : "Request Package Change"}
                </Button>
                </form>
            </TabsContent>
            </Tabs>
        </>
    );
}

export function RequestChangeDialog(props: RequestChangeDialogProps) {
    const isMobile = useIsMobile();
    
    if (isMobile) {
        return (
            <Drawer open={props.isOpen} onOpenChange={props.onClose}>
                <DrawerContent>
                    <DrawerHeader className="text-left">
                        <DrawerTitle>Request Change for Table {props.session.tableNumber}</DrawerTitle>
                        <DrawerDescription>Submit a request for a cashier to approve.</DrawerDescription>
                    </DrawerHeader>
                    <ChangeRequestForm {...props} />
                </DrawerContent>
            </Drawer>
        );
    }
    
    return (
        <Dialog open={props.isOpen} onOpenChange={props.onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Request Change for Table {props.session.tableNumber}</DialogTitle>
                    <DialogDescription>Submit a request for a cashier to approve.</DialogDescription>
                </DialogHeader>
                <ChangeRequestForm {...props} />
            </DialogContent>
        </Dialog>
    );
}

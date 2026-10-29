
"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { AppUser } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { startSession, StartSessionPayload } from "./firestore";
import { CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, PlusCircle, Minus, Plus, MessageSquarePlus, X, Users } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { QuantityInput } from "./quantity-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Form, FormControl, FormField, FormItem, FormMessage } from "../ui/form";
import type { StorePackage, StoreFlavor } from "@/lib/types";
import { bundleExtraPax } from "@/lib/billing/bundle";

// --- TYPES ---
export type Table = {
    id: string;
    tableNumber: string;
    displayName: string;
    status: 'available' | 'occupied';
    currentSessionId: string | null;
    isActive: boolean;
};


const unlimitedSchema = z.object({
    tableId: z.string({ required_error: "Please select a table." }),
    packageId: z.string({ required_error: "Please select a package." }),
    guestCount: z.coerce.number().min(1, "At least one guest is required."),
    riceQty: z.coerce.number().min(0),
    cheeseQty: z.coerce.number().min(0),
    initialFlavorIds: z.array(z.string()).min(1, "Select at least one flavor.").max(3, "You can select up to 3 flavors."),
    notes: z.string().optional(),
    customerName: z.string().min(2, "Customer name is required."),
    customerTin: z.string().optional(),
    customerAddress: z.string().optional(),
});

const alacarteSchema = z.object({
  customerName: z.string().min(2, "Customer name is required."),
  customerTin: z.string().optional(),
  customerAddress: z.string().optional(),
});

type UnlimitedFormValues = z.infer<typeof unlimitedSchema>;
type AlaCarteFormValues = z.infer<typeof alacarteSchema>;


// --- PROPS ---
export interface PendingSeat {
    id: string;
    name: string;
    partySize: number;
    phone?: string | null;
    /**
     * Present when the seat originates from a /reservations "Seat now" rather
     * than the walk-in waitlist. The cashier marks this reservation seated (and
     * links the new session) on completion instead of deleting a waitlist entry.
     */
    reservationId?: string;
    /** T-455 S5: present when the party comes from the lobby line; the lobby entry is linked to the new session on completion. */
    lobbyEntryId?: string;
    /** Pre-filled into the Notes box (the diner name and the entry note). */
    notes?: string;
    /** Lines with a POS item key (a key that is one of this store's packages selects it). */
    items?: { posItemKey: string; qty: number }[];
    /** Lines with no POS item key: shown to the cashier as plain text to tap in by hand. */
    textLines?: { label: string; qty: number }[];
}

interface StartSessionFormProps {
    tables: Table[];
    packages: StorePackage[];
    flavors: StoreFlavor[];
    user: AppUser | null;
    storeId: string;
    /** Store session-mode flags. Absent ⇒ offered (existing stores keep both). */
    offersUnlimited?: boolean;
    offersAlaCarte?: boolean;
    pendingSeat?: PendingSeat | null;
    onSeatCompleted?: (sessionId: string, standLabel?: string) => void;
    onSeatCleared?: () => void;
}

export function StartSessionForm({ tables, packages, flavors, user, storeId, offersUnlimited, offersAlaCarte, pendingSeat, onSeatCompleted, onSeatCleared }: StartSessionFormProps) {
    const { toast } = useToast();
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Which order modes this store offers (absent ⇒ offered). Drives the tabs.
    const showUnlimited = offersUnlimited !== false;
    const showAlaCarte = offersAlaCarte !== false;
    const bothModes = showUnlimited && showAlaCarte;
    const [mode, setMode] = useState<"unlimited" | "alacarte">(showUnlimited ? "unlimited" : "alacarte");

    // State for rice/cheese qty touched status
    const [riceTouched, setRiceTouched] = useState(false);
    const [cheeseTouched, setCheeseTouched] = useState(false);

    const unlimitedForm = useForm<UnlimitedFormValues>({
        resolver: zodResolver(unlimitedSchema),
        defaultValues: {
            guestCount: 2,
            riceQty: 2,
            cheeseQty: 2,
            initialFlavorIds: [],
            notes: "",
            customerName: "",
            customerTin: "",
            customerAddress: "",
        },
    });
    
    const alaCarteForm = useForm<AlaCarteFormValues>({
        resolver: zodResolver(alacarteSchema),
        defaultValues: {
            customerName: "",
            customerTin: "",
            customerAddress: "",
        }
    });
    
    const guestCount = unlimitedForm.watch("guestCount");
    const riceQty = unlimitedForm.watch("riceQty");
    const cheeseQty = unlimitedForm.watch("cheeseQty");

    // A bundle's cap is the headcount its flat price covers, NOT a seating limit —
    // the party may be any size, and guests beyond the cap are billed per-head at
    // `bundleExtraHeadPrice` (0 = included at no charge).
    const selectedPackageId = unlimitedForm.watch("packageId");
    const selectedPackage = packages.find(p => p.packageId === selectedPackageId);
    const isBundle = !!selectedPackage?.isBundle;
    const bundleCap = Number(selectedPackage?.bundleMaxCap ?? 0);
    const bundleExtraPrice = Number(selectedPackage?.bundleExtraHeadPrice ?? 0);
    const extraPax = isBundle ? bundleExtraPax(guestCount, bundleCap) : 0;

    const setGuestCount = (val: number) => {
        unlimitedForm.setValue('guestCount', Math.max(1, Math.floor(Number(val) || 1)));
    };

    // Seat-from-waitlist: prefill form when parent sets a pending seat.
    const formRef = useRef<HTMLDivElement>(null);
    const lastSeatIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!pendingSeat) {
            lastSeatIdRef.current = null;
            return;
        }
        if (lastSeatIdRef.current === pendingSeat.id) return;
        lastSeatIdRef.current = pendingSeat.id;
        if (showUnlimited) setMode("unlimited");
        unlimitedForm.setValue("customerName", pendingSeat.name);
        if (pendingSeat.partySize > 0) {
            unlimitedForm.setValue("guestCount", pendingSeat.partySize);
        }
        if (pendingSeat.notes) unlimitedForm.setValue("notes", pendingSeat.notes);
        const keyed = pendingSeat.items?.find((it) => packages.some((p) => p.packageId === it.posItemKey));
        if (keyed) unlimitedForm.setValue("packageId", keyed.posItemKey);
        // Defer scroll so the tab change and setValue commit first.
        setTimeout(() => {
            formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 80);
    }, [pendingSeat, unlimitedForm]);

    // Effect to sync rice/cheese with guest count if not manually touched
    useEffect(() => {
        if (!riceTouched) {
            unlimitedForm.setValue('riceQty', guestCount);
        }
        if (!cheeseTouched) {
            unlimitedForm.setValue('cheeseQty', guestCount);
        }
    }, [guestCount, riceTouched, cheeseTouched, unlimitedForm]);

    const handleRiceChange = (value: number) => {
        setRiceTouched(true);
        unlimitedForm.setValue('riceQty', value);
    }
    
    const handleCheeseChange = (value: number) => {
        setCheeseTouched(true);
        unlimitedForm.setValue('cheeseQty', value);
    }
    
    const handleAddNotes = () => {
        const currentNotes = unlimitedForm.getValues('notes') || '';
        const newNote = `Rice: ${riceQty}, Cheese: ${cheeseQty}`;
        const updatedNotes = currentNotes ? `${currentNotes}\n${newNote}` : newNote;
        unlimitedForm.setValue('notes', updatedNotes);
    };

    const onSubmitUnlimited = async (data: UnlimitedFormValues) => {
        if (!user || !storeId) {
            toast({ variant: 'destructive', title: 'Error', description: 'User or store not found.' });
            return;
        }
        setIsSubmitting(true);

        const chosenTable = tables.find(t => t.id === data.tableId);
        const chosenPackage = packages.find(p => p.packageId === data.packageId);

        if (!chosenPackage || !chosenTable) {
            toast({ variant: 'destructive', title: 'Error', description: 'Selected table or package not found.' });
            setIsSubmitting(false);
            return;
        }

        
        const normOpt = (v: any) => {
            const s = typeof v === "string" ? v.trim() : "";
            return s.length > 0 ? s : null;
        };
        
        const customerData = {
            name: normOpt(data.customerName),
            tin: normOpt(data.customerTin),
            address: normOpt(data.customerAddress),
        };

        const sessionPayload: StartSessionPayload = {
            tableId: chosenTable.id,
            tableNumber: chosenTable.tableNumber,
            displayName: chosenTable.displayName,
            guestCount: data.guestCount,
            initialFlavorIds: data.initialFlavorIds,
            notes: data.notes,
            package: chosenPackage,
            sessionMode: "package_dinein",
        };
        
        if (customerData.name || customerData.tin || customerData.address) {
            sessionPayload.customer = customerData;
        }

        try {
            const newSessionId = await startSession(storeId, sessionPayload, user);

            if (pendingSeat) {
                onSeatCompleted?.(newSessionId, chosenTable.tableNumber);
            }

            toast({ title: 'Session Created!', description: `Table ${chosenTable.tableNumber} is now pending server verification.` });
            router.push(`/pins?sessionId=${newSessionId}`);

        } catch (error: any) {
            console.error("Error Starting Session:", error);
            toast({ variant: 'destructive', title: 'Error Starting Session', description: error.message || 'Could not start session.' });
        } finally {
            setIsSubmitting(false);
        }
    };
    
    const onSubmitAlaCarte = async (data: AlaCarteFormValues) => {
        if (!user || !storeId) {
            toast({ variant: 'destructive', title: 'Error', description: 'User or store not found.' });
            return;
        }
        
        const name = (data.customerName || "").trim();

        setIsSubmitting(true);
        
        const normOpt = (v: any) => {
            const s = typeof v === "string" ? v.trim() : "";
            return s.length > 0 ? s : null;
        };
        
        const customer = {
            name,
            tin: normOpt(data.customerTin),
            address: normOpt(data.customerAddress),
        };
        
        try {
            const newSessionId = await startSession(storeId, {
                tableId: "alacarte",
                tableNumber: "N/A",
                customer,
                sessionMode: "alacarte",
                guestCount: 1, // Default for ala carte, not displayed
            }, user);

            toast({ title: 'Order Created!', description: `Redirecting to add items.` });
            router.push(`/cashier?sessionId=${newSessionId}`);

        } catch (error: any) {
            console.error("Error Starting Session (Ala Carte):", error);
            toast({ variant: 'destructive', title: 'Error Starting Session', description: error.message || 'Could not start session.' });
        } finally {
            setIsSubmitting(false);
        }
    }
    
    return (
        <CardContent className="px-4 pt-0" ref={formRef}>
            {pendingSeat && (
                <div className="mb-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary shrink-0" />
                    <div className="flex-1 min-w-0 text-sm">
                        <span className="font-semibold">Seating: {pendingSeat.name}</span>
                        <span className="text-muted-foreground"> · {pendingSeat.partySize} pax</span>
                        {pendingSeat.textLines && pendingSeat.textLines.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                                Tap in by hand: {pendingSeat.textLines.map((l) => `${l.qty} x ${l.label}`).join(", ")}
                            </p>
                        )}
                    </div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => onSeatCleared?.()}
                        aria-label="Clear seating"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            )}
            {!showUnlimited && !showAlaCarte ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No order modes are enabled for this store. Turn on dine-in (Unlimited) and/or à la carte in Store settings.
                </div>
            ) : (
            <Tabs value={mode} onValueChange={(v) => setMode(v as any)} className="w-full">
                {bothModes && (
                    <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="unlimited">Unlimited</TabsTrigger>
                        <TabsTrigger value="alacarte">Ala Carte</TabsTrigger>
                    </TabsList>
                )}
                {showUnlimited && (
                <TabsContent value="unlimited">
                    <Form {...unlimitedForm}>
                        <form onSubmit={unlimitedForm.handleSubmit(onSubmitUnlimited)} className="space-y-6 pt-4">
                            {/* Step 1: Table and Guests */}
                            <div className="space-y-4">
                                <div className="grid grid-cols-2 gap-4">
                                    <FormField
                                        name="tableId"
                                        control={unlimitedForm.control}
                                        render={({ field }) => (
                                            <FormItem>
                                                <Label>Table</Label>
                                                <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                    <FormControl>
                                                        <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                                                    </FormControl>
                                                    <SelectContent>
                                                        {tables.map(table => <SelectItem key={table.id} value={table.id}>{table.displayName || `Table ${table.tableNumber}`}</SelectItem>)}
                                                    </SelectContent>
                                                </Select>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                    <div className="space-y-2">
                                        <Label>Guests{isBundle && bundleCap > 0 ? ` (first ${bundleCap} covered)` : ''}</Label>
                                        <div className="flex items-center gap-2">
                                            <Button type="button" variant="outline" size="icon" onClick={() => setGuestCount(guestCount - 1)}><Minus /></Button>
                                            <QuantityInput
                                                value={guestCount}
                                                onChange={(val) => setGuestCount(val)}
                                                className="w-16 text-center"
                                            />
                                            <Button type="button" variant="outline" size="icon" onClick={() => setGuestCount(guestCount + 1)}><Plus /></Button>
                                        </div>
                                        {extraPax > 0 && (
                                            <p className="text-xs text-amber-600">
                                                +{extraPax} beyond the {bundleCap} covered
                                                {bundleExtraPrice > 0 ? ` @ ₱${bundleExtraPrice} each` : ' — no extra charge'}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <Separator />
                            {/* Step 2: Package */}
                            <FormField
                                name="packageId"
                                control={unlimitedForm.control}
                                render={({ field }) => (
                                    <FormItem>
                                        <Label>Package</Label>
                                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                                            <FormControl>
                                                <SelectTrigger><SelectValue placeholder="Select a package..." /></SelectTrigger>
                                            </FormControl>
                                            <SelectContent>
                                                {packages.map(pkg => (
                                                    <SelectItem key={pkg.packageId} value={pkg.packageId}>
                                                        {pkg.isBundle
                                                            ? `${pkg.packageName} - ₱${pkg.bundlePrice ?? 0} (≤${pkg.bundleMaxCap ?? 1} pax)`
                                                            : `${pkg.packageName} - ₱${pkg.pricePerHead}/head`}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <Separator />
                            {/* Step 3: Flavors */}
                            <FormField
                                name="initialFlavorIds"
                                control={unlimitedForm.control}
                                render={({ field }) => (
                                    <FormItem>
                                        <Label>Initial Flavors (up to 3)</Label>
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 border rounded-md max-h-40 overflow-y-auto">
                                            {flavors.map(flavor => (
                                                <div key={flavor.flavorId} className="flex items-center gap-2">
                                                    <Checkbox
                                                        id={`flavor-${flavor.flavorId}`}
                                                        checked={field.value?.includes(flavor.flavorId)}
                                                        onCheckedChange={(checked) => {
                                                            const current = field.value || [];
                                                            const newValue = checked
                                                                ? [...current, flavor.flavorId]
                                                                : current.filter(id => id !== flavor.flavorId);
                                                            if (newValue.length <= 3) {
                                                                field.onChange(newValue);
                                                            } else {
                                                                toast({ variant: 'destructive', title: "Limit Reached", description: "You can only select up to 3 flavors."});
                                                            }
                                                        }}
                                                    />
                                                    <Label htmlFor={`flavor-${flavor.flavorId}`} className="font-normal cursor-pointer">{flavor.flavorName}</Label>
                                                </div>
                                            ))}
                                        </div>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                            <Separator />
                            {/* Step 4: Notes and Customer */}
                            <div className="space-y-4">
                                <div className="p-4 border rounded-md space-y-4">
                                    <div className="grid grid-cols-3 gap-4 items-end">
                                        <div className="space-y-2">
                                            <Label>Rice</Label>
                                            <div className="flex items-center gap-2">
                                                <Button type="button" variant="outline" size="icon" onClick={() => handleRiceChange(Math.max(0, riceQty - 1))}><Minus /></Button>
                                                <QuantityInput value={riceQty} onChange={handleRiceChange} className="w-12 text-center" />
                                                <Button type="button" variant="outline" size="icon" onClick={() => handleRiceChange(riceQty + 1)}><Plus /></Button>
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Cheese</Label>
                                            <div className="flex items-center gap-2">
                                                <Button type="button" variant="outline" size="icon" onClick={() => handleCheeseChange(Math.max(0, cheeseQty - 1))}><Minus /></Button>
                                                <QuantityInput value={cheeseQty} onChange={handleCheeseChange} className="w-12 text-center" />
                                                <Button type="button" variant="outline" size="icon" onClick={() => handleCheeseChange(cheeseQty + 1)}><Plus /></Button>
                                            </div>
                                        </div>
                                        <Button type="button" variant="outline" size="sm" onClick={handleAddNotes} className="self-end mb-1">
                                            <MessageSquarePlus className="mr-2"/> Add
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="notes">Notes (Optional)</Label>
                                    <Textarea id="notes" placeholder="e.g., birthday celebration, allergies..." {...unlimitedForm.register('notes')} />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <FormField
                                        control={unlimitedForm.control}
                                        name="customerName"
                                        render={({ field }) => (
                                            <FormItem>
                                                <Label>Customer Name</Label>
                                                <FormControl>
                                                    <Input {...field} />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                    <FormField
                                        control={unlimitedForm.control}
                                        name="customerTin"
                                        render={({ field }) => (
                                            <FormItem>
                                                <Label>TIN (Optional)</Label>
                                                <FormControl>
                                                    <Input {...field} />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                </div>
                                <FormField
                                    control={unlimitedForm.control}
                                    name="customerAddress"
                                    render={({ field }) => (
                                        <FormItem>
                                            <Label>Address (Optional)</Label>
                                            <FormControl>
                                                <Input {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                            </div>
                            <Button type="submit" variant="destructive" disabled={isSubmitting} className="w-full">
                                {isSubmitting ? <Loader2 className="animate-spin" /> : <PlusCircle className="mr-2" />}
                                Start Session
                            </Button>
                        </form>
                    </Form>
                </TabsContent>
                )}
                {showAlaCarte && (
                    <TabsContent value="alacarte">
                        <Form {...alaCarteForm}>
                        <form onSubmit={alaCarteForm.handleSubmit(onSubmitAlaCarte)} className="space-y-6 pt-4">
                            <div className="space-y-4">
                                <FormField
                                    control={alaCarteForm.control}
                                    name="customerName"
                                    render={({ field }) => (
                                        <FormItem>
                                            <Label>Customer Name <span className="text-destructive">*</span></Label>
                                            <FormControl>
                                                <Input {...field} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <div className="grid grid-cols-2 gap-4">
                                    <FormField
                                        control={alaCarteForm.control}
                                        name="customerTin"
                                        render={({ field }) => (
                                            <FormItem>
                                                <Label>TIN (Optional)</Label>
                                                <FormControl>
                                                    <Input {...field} />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                    <FormField
                                        control={alaCarteForm.control}
                                        name="customerAddress"
                                        render={({ field }) => (
                                            <FormItem>
                                                <Label>Address (Optional)</Label>
                                                <FormControl>
                                                    <Input {...field} />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                </div>
                            </div>
                            <Button type="submit" variant="destructive" disabled={isSubmitting} className="w-full">
                                {isSubmitting ? <Loader2 className="animate-spin" /> : <PlusCircle className="mr-2" />}
                                Create Order & Add Items
                            </Button>
                        </form>
                        </Form>
                </TabsContent>
                )}
            </Tabs>
            )}
        </CardContent>
    );
}

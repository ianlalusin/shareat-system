

"use client";

import { useState, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, Trash2, X } from "lucide-react";
import type { Discount, Charge, Adjustment } from "@/lib/types";
import { type AppUser } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";

interface BillAdjustmentsProps {
  appUser: AppUser | null;
  billDiscount: Discount | null;
  charges: Charge[];
  discounts: Discount[];
  onAddAdjustment: (charge: Charge) => void | Promise<void>;
  onAddCustomAdjustment: (note: string, amount: number) => void | Promise<void>;
  onSetBillDiscount: (discount: Discount | null) => void | Promise<void>;
  isLocked?: boolean;
  /**
   * Shared "a customAdjustments/billDiscount write is in flight" lock owned by
   * the parent (e.g. session-detail-view's updateSessionBillingState). Disables
   * every control here in addition to this component's own local isSaving, so
   * an add-charge/discount write can't race a remove in BillAppliedAdjustments
   * (or vice versa) against the same stale customAdjustments closure.
   */
  busy?: boolean;
  /** Popover side; defaults to "top" for the sticky-footer placement. */
  side?: "top" | "bottom" | "left" | "right";
}

function CurrencyInput({ value, onChange, disabled }: { value: number, onChange: (val: number) => void, disabled?: boolean }) {
    const [displayValue, setDisplayValue] = useState(value.toString());

    useEffect(() => {
        if (document.activeElement?.id !== `currency-input-${value}`) {
            setDisplayValue(value.toString());
        }
    }, [value]);

    const handleFocus = () => {
        if (parseFloat(displayValue) === 0) {
            setDisplayValue("");
        }
    };

    const handleBlur = () => {
        if (displayValue === "" || isNaN(parseFloat(displayValue))) {
            setDisplayValue("0");
            onChange(0);
        } else {
            onChange(parseFloat(displayValue));
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setDisplayValue(e.target.value);
    };

    const handleKeyUp = () => {
        const numVal = parseFloat(displayValue);
        if (!isNaN(numVal)) {
            onChange(numVal);
        }
    }

    return (
        <Input
            id={`currency-input-${value}`}
            type="number"
            placeholder="Value"
            value={displayValue}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyUp={handleKeyUp}
            className="h-9"
            disabled={disabled}
        />
    )
}

function normalizeDiscountType(t: any): "fixed" | "percent" {
    if (t === "percentage" || t === "percent") return "percent";
    return "fixed";
}

/**
 * Renders the two bill-action buttons (Bill Discount, Add Charge) as a
 * compact inline group. Each button opens its editor in a Popover so this
 * can be dropped into a sticky footer action row next to the Pay button.
 * All billing handlers/behavior are unchanged from the previous inline
 * (mode-toggled) editor — only the presentation moved from an inline panel
 * to a popover.
 */
export function BillAdjustments({
  appUser,
  billDiscount,
  charges,
  discounts,
  onAddAdjustment,
  onAddCustomAdjustment,
  onSetBillDiscount,
  isLocked = false,
  busy = false,
  side = "top",
}: BillAdjustmentsProps) {
  const [discountOpen, setDiscountOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // State for the discount editor
  const [isCustomDiscount, setIsCustomDiscount] = useState(true);
  const [selectedDiscountId, setSelectedDiscountId] = useState<string>('custom');
  const [tempDiscountType, setTempDiscountType] = useState<'fixed' | 'percent'>('fixed');
  const [tempDiscountValue, setTempDiscountValue] = useState(0);

  // State for custom charge
  const [showCustomCharge, setShowCustomCharge] = useState(false);
  const [customChargeNote, setCustomChargeNote] = useState("");
  const [customChargeAmount, setCustomChargeAmount] = useState(0);

  useEffect(() => {
      if (billDiscount) {
          const isSaved = discounts.some(d => d.id === billDiscount.id);
          setIsCustomDiscount(!isSaved);
          setSelectedDiscountId(isSaved ? billDiscount.id : 'custom');
          setTempDiscountType(normalizeDiscountType(billDiscount.type));
          setTempDiscountValue(billDiscount.value);
      } else {
          setIsCustomDiscount(true);
          setSelectedDiscountId('custom');
          setTempDiscountType('fixed');
          setTempDiscountValue(0);
      }
  }, [billDiscount, discounts]);

  const handleDiscountSelect = (id: string) => {
    setSelectedDiscountId(id);
    if (id === 'custom') {
        setIsCustomDiscount(true);
        setTempDiscountType('fixed');
        setTempDiscountValue(0);
    } else {
        const selected = discounts.find(d => d.id === id);
        if (selected) {
            setIsCustomDiscount(false);
            setTempDiscountType(normalizeDiscountType(selected.type));
            setTempDiscountValue(Number(selected.value) || 0);
        }
    }
  }

  const runBillingMutation = async (action: () => void | Promise<void>) => {
    setIsSaving(true);
    try {
      await action();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Billing update failed", description: err?.message ?? "Could not update the bill." });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApplyDiscount = async () => {
    let discountToApply: Discount;
    if (isCustomDiscount) {
         discountToApply = {
            id: `custom-${Date.now()}`,
            name: 'Custom Discount',
            type: tempDiscountType,
            value: tempDiscountValue,
            scope: ['bill'],
            stackable: false, isEnabled: true, sortOrder: 9999, isArchived: false, createdAt: '', updatedAt: '', createdBy: '', updatedBy: ''
        };
    } else {
        const selected = discounts.find(d => d.id === selectedDiscountId);
        if (!selected) return;
        discountToApply = {
            ...selected,
            type: normalizeDiscountType(selected.type),
            value: Number(selected.value) || 0,
        };
    }
    await runBillingMutation(async () => {
      await onSetBillDiscount(discountToApply);
      setDiscountOpen(false);
    });
  };

  const handleClearDiscount = async () => {
    await runBillingMutation(async () => {
      await onSetBillDiscount(null);
      setDiscountOpen(false);
    });
  }

  const handleChargeSelect = async (id: string) => {
    if (id === 'other') {
        setShowCustomCharge(true);
    } else {
        setShowCustomCharge(false);
        const selected = charges.find(c => c.id === id);
        if (selected) {
            // Note: selecting a preset charge intentionally does NOT close the
            // popover (matches prior inline-panel behavior), so the cashier can
            // add multiple charges in a row without reopening the editor.
            await runBillingMutation(() => onAddAdjustment(selected));
        }
    }
  }

  const handleApplyCustomCharge = async () => {
    await runBillingMutation(async () => {
      await onAddCustomAdjustment(customChargeNote, customChargeAmount);
      setCustomChargeNote("");
      setCustomChargeAmount(0);
      setShowCustomCharge(false);
      setChargeOpen(false);
    });
  };

  const canSeeDiscountButton = useMemo(() => {
    if (!appUser) return false;
    if (appUser.isPlatformAdmin) return true;
    if (appUser.role === 'manager') return true;
    return false;
  }, [appUser]);

  return (
    <div className="flex items-center gap-2">
        {canSeeDiscountButton && (
            <Popover
                open={discountOpen}
                onOpenChange={(open) => {
                    setDiscountOpen(open);
                    // Popovers are mutually exclusive: opening one closes the other.
                    if (open) setChargeOpen(false);
                }}
            >
                <PopoverTrigger asChild>
                    <Button type="button" variant={discountOpen ? 'destructive' : 'outline'} size="sm" disabled={isSaving || isLocked || busy}>
                        Bill Discount
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side={side} className="w-80 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">Bill Discount</p>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setDiscountOpen(false)}><X size={16} /></Button>
                    </div>
                    <Select onValueChange={handleDiscountSelect} disabled={isLocked || isSaving || busy} value={selectedDiscountId}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Select discount..." /></SelectTrigger>
                        <SelectContent>
                            {discounts.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                            <SelectItem value="custom">Others (Custom)</SelectItem>
                        </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1">
                        <Select
                            value={tempDiscountType}
                            onValueChange={(type: 'percent' | 'fixed') => setTempDiscountType(type)}
                            disabled={isLocked || isSaving || busy || !isCustomDiscount}
                        >
                            <SelectTrigger className="h-9 w-16"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="percent">%</SelectItem>
                                <SelectItem value="fixed">₱</SelectItem>
                            </SelectContent>
                        </Select>
                        <CurrencyInput
                            value={tempDiscountValue}
                            onChange={setTempDiscountValue}
                            disabled={isLocked || isSaving || busy || !isCustomDiscount}
                        />
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={handleClearDiscount} disabled={isLocked || isSaving || busy}><Trash2 size={16} /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-green-600" onClick={handleApplyDiscount} disabled={isLocked || isSaving || busy}><Check size={16} /></Button>
                    </div>
                </PopoverContent>
            </Popover>
        )}

        <Popover
            open={chargeOpen}
            onOpenChange={(open) => {
                setChargeOpen(open);
                if (!open) setShowCustomCharge(false);
                // Popovers are mutually exclusive: opening one closes the other.
                if (open) setDiscountOpen(false);
            }}
        >
            <PopoverTrigger asChild>
                <Button type="button" variant={chargeOpen ? 'destructive' : 'outline'} size="sm" disabled={isSaving || isLocked || busy}>
                    Add Charge
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" side={side} className="w-80 space-y-3">
                <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Add Charge</p>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setChargeOpen(false)}><X size={16} /></Button>
                </div>
                <Select onValueChange={(value) => void handleChargeSelect(value)} disabled={isLocked || isSaving || busy}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Select a charge to add..." /></SelectTrigger>
                    <SelectContent>
                        {charges.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({c.type === 'fixed' ? `₱${c.value}` : `${c.value}%`})</SelectItem>)}
                        <SelectItem value="other">Other (Custom)</SelectItem>
                    </SelectContent>
                </Select>
                {showCustomCharge && (
                    <div className="space-y-2 pt-2 border-t">
                        <Input
                            placeholder="Charge Note (e.g., Spill Fee)"
                            value={customChargeNote}
                            onChange={(e) => setCustomChargeNote(e.target.value)}
                            className="h-9"
                            disabled={isSaving || busy}
                        />
                        <CurrencyInput
                            value={customChargeAmount}
                            onChange={setCustomChargeAmount}
                            disabled={isSaving || busy}
                        />
                        <Button size="sm" className="w-full" onClick={handleApplyCustomCharge} disabled={isSaving || busy || !customChargeNote || customChargeAmount <= 0}>Apply Custom Charge</Button>
                    </div>
                )}
            </PopoverContent>
        </Popover>
    </div>
  );
}

/**
 * Compact list of currently-applied bill-level adjustments (custom charges /
 * custom-added charges) with a remove action. Split out of BillAdjustments so
 * it can be placed in the scrolling bill-summary column while the action
 * buttons live in the sticky footer. Same remove handler/behavior as before;
 * only the location moved.
 */
export function BillAppliedAdjustments({
  adjustments,
  onRemoveAdjustment,
  isLocked = false,
  busy = false,
}: {
  adjustments: Adjustment[];
  onRemoveAdjustment: (id: string) => void | Promise<void>;
  isLocked?: boolean;
  /**
   * Shared "a customAdjustments/billDiscount write is in flight" lock owned by
   * the parent (mirrors the same prop on BillAdjustments). Disables the
   * remove buttons here in addition to this component's own local isSaving,
   * so a remove can't race an add-charge/discount write in BillAdjustments
   * against the same stale customAdjustments closure.
   */
  busy?: boolean;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  if (!adjustments || adjustments.length === 0) return null;

  const handleRemove = async (id: string) => {
    setIsSaving(true);
    try {
      await onRemoveAdjustment(id);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Billing update failed", description: err?.message ?? "Could not update the bill." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="px-3 py-2 text-sm space-y-1">
        {adjustments.map(adj => (
            <div key={adj.id} className="flex justify-between items-center">
                <span className="text-muted-foreground">{adj.note}</span>
                 <div className="flex items-center gap-2">
                    <span>+ {adj.type === 'percent' ? `${adj.amount}%` : `₱${adj.amount.toFixed(2)}`}</span>
                    {!isLocked && <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => handleRemove(adj.id)} disabled={isSaving || busy}><Trash2 size={12} /></Button>}
                </div>
            </div>
        ))}
    </div>
  );
}

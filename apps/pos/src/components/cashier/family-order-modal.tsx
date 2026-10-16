"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuth } from "firebase/auth";
import Image from "next/image";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertTriangle, Check, Layers, Minus, Plus } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { resolveFamilyImageUrl } from "@/lib/products/variants";
import type { InventoryItem, OptionGroup, OptionGroupValue, SelectedModifier } from "@/lib/types";

type EnrichedStoreAddon = InventoryItem & {
  displayName: string;
  groupKey: string;
  groupName?: string;
  imageUrl?: string | null;
};

export type AddonGroup = {
  title: string;
  key: string;
  items: EnrichedStoreAddon[];
  isGroup: boolean;
};

export type FamilyOrderAddArgs = {
  variant: EnrichedStoreAddon;
  modifiers: SelectedModifier[];
  modifiersText: string;
  modifiersTotal: number;
  quantity: number;
  note: string;
};

function activeValues(g: OptionGroup): OptionGroupValue[] {
  return (g.values || [])
    .filter((v) => v.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function fmtDelta(v: number): string {
  if (!v) return "";
  return v > 0 ? `+₱${v.toLocaleString()}` : `-₱${Math.abs(v).toLocaleString()}`;
}

function FamilyOrderContent({
  group,
  storeId,
  onCancel,
  onAdd,
}: {
  group: AddonGroup;
  storeId: string;
  onCancel: () => void;
  onAdd: (args: FamilyOrderAddArgs) => Promise<void>;
}) {
  const { toast } = useToast();
  const [selectedVariant, setSelectedVariant] = useState<EnrichedStoreAddon | null>(null);
  const [optionGroups, setOptionGroups] = useState<OptionGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset when the family changes.
  useEffect(() => {
    setSelectedVariant(null);
    setOptionGroups([]);
    setSelections({});
    setQuantity(1);
    setNote("");
  }, [group.key]);

  // Fetch the option groups (inherited from the family parent) once the user
  // locks in a variant. Picker matches modifier-picker.tsx behavior.
  useEffect(() => {
    if (!selectedVariant) {
      setOptionGroups([]);
      setSelections({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoadingGroups(true);
        const productId = (selectedVariant as any).productId || selectedVariant.id;
        const user = getAuth().currentUser;
        if (!user) {
          setOptionGroups([]);
          return;
        }
        const idToken = await user.getIdToken();
        const res = await fetch(`/api/products/${encodeURIComponent(productId)}/option-groups?storeId=${encodeURIComponent(storeId)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        const groups: OptionGroup[] = res.ok && json?.ok ? json.optionGroups || [] : [];
        setOptionGroups(groups);
        // Pre-select first value of any required single-select group.
        const initial: Record<string, Set<string>> = {};
        for (const g of groups) {
          if (g.selectionMode === "single" && g.required) {
            const first = activeValues(g)[0];
            initial[g.id] = first ? new Set([first.id]) : new Set();
          } else {
            initial[g.id] = new Set();
          }
        }
        setSelections(initial);
      } catch {
        if (!cancelled) setOptionGroups([]);
      } finally {
        if (!cancelled) setLoadingGroups(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVariant?.id, storeId]);

  function toggleSingle(g: OptionGroup, valueId: string) {
    setSelections((prev) => ({ ...prev, [g.id]: new Set([valueId]) }));
  }
  function toggleMulti(g: OptionGroup, valueId: string) {
    setSelections((prev) => {
      const next = new Set(prev[g.id] || []);
      if (next.has(valueId)) {
        next.delete(valueId);
      } else {
        if (g.maxSelections != null && next.size >= g.maxSelections) return prev;
        next.add(valueId);
      }
      return { ...prev, [g.id]: next };
    });
  }

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const g of optionGroups) {
      const sel = selections[g.id] || new Set();
      if (g.selectionMode === "single") {
        if (g.required && sel.size === 0) out[g.id] = `Pick one ${g.name.toLowerCase()}.`;
      } else {
        // `required` is the master switch: minSelections only applies when the
        // group is required, so an optional group never forces a selection.
        const min = g.required ? (g.minSelections ?? 1) : 0;
        const max = g.maxSelections;
        if (sel.size < min) out[g.id] = `Pick at least ${min}.`;
        else if (max != null && sel.size > max) out[g.id] = `Pick at most ${max}.`;
      }
    }
    return out;
  }, [optionGroups, selections]);

  const modifiersTotal = useMemo(() => {
    let sum = 0;
    for (const g of optionGroups) {
      const sel = selections[g.id] || new Set();
      for (const v of activeValues(g)) if (sel.has(v.id)) sum += Number(v.priceDelta || 0);
    }
    return sum;
  }, [optionGroups, selections]);

  const canAdd =
    !submitting &&
    !!selectedVariant &&
    !loadingGroups &&
    Object.keys(errors).length === 0 &&
    quantity > 0;

  function buildModifiers(): { modifiers: SelectedModifier[]; modifiersText: string; modifiersTotal: number } {
    const mods: SelectedModifier[] = [];
    for (const g of optionGroups) {
      const sel = selections[g.id] || new Set();
      for (const v of activeValues(g)) {
        if (sel.has(v.id)) {
          mods.push({
            groupId: g.id,
            groupName: g.name,
            valueId: v.id,
            valueName: v.name,
            priceDelta: Number(v.priceDelta || 0),
          });
        }
      }
    }
    return {
      modifiers: mods,
      modifiersText: mods.map((m) => m.valueName).join(", "),
      modifiersTotal: mods.reduce((acc, m) => acc + m.priceDelta, 0),
    };
  }

  async function handleAdd() {
    if (!canAdd || !selectedVariant) return;
    setSubmitting(true);
    try {
      const { modifiers, modifiersText, modifiersTotal } = buildModifiers();
      await onAdd({
        variant: selectedVariant,
        modifiers,
        modifiersText,
        modifiersTotal,
        quantity,
        note: note.trim(),
      });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSubmitting(false);
    }
  }

  const variantUnitPrice = Number(selectedVariant?.sellingPrice || 0);
  const lineUnitPrice = variantUnitPrice + modifiersTotal;
  const lineTotal = lineUnitPrice * quantity;

  // Family picture: first variant with an image. Variants without their own
  // image fall back to this so the picker never shows empty tiles when the
  // family has at least one picture.
  const familyImage = resolveFamilyImageUrl(group.items);

  return (
    <div className="grid gap-4 p-4">
      {/* Step 1: variant picker (locks on click) */}
      <div>
        <div className="text-sm font-semibold mb-2">1. Choose variant</div>
        <div className="grid grid-cols-3 gap-2">
          {group.items.map((variant) => {
            const isSelected = selectedVariant?.id === variant.id;
            return (
              <button
                key={variant.id}
                type="button"
                onClick={() => setSelectedVariant(variant)}
                className={cn(
                  "relative flex flex-col items-center justify-center p-2 border rounded-md text-center h-32 transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
                  isSelected ? "border-primary ring-2 ring-primary bg-primary/5" : "hover:bg-muted/50"
                )}
              >
                {isSelected && (
                  <span className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground p-0.5">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                <div className="w-16 h-16 bg-muted rounded-md mb-1 relative overflow-hidden">
                  {(variant.imageUrl ?? familyImage) && (
                    <Image src={(variant.imageUrl ?? familyImage) as string} alt={variant.displayName} fill style={{ objectFit: "cover" }} />
                  )}
                </div>
                <span className="text-xs font-medium leading-tight line-clamp-2">{variant.displayName}</span>
                <span className="text-xs text-muted-foreground mt-auto">₱{Number(variant.sellingPrice || 0).toFixed(2)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2: modifier picker (only meaningful once variant is locked) */}
      <div className={cn("transition-opacity", !selectedVariant && "opacity-50 pointer-events-none")}>
        <div className="text-sm font-semibold mb-2">2. Modifiers</div>
        {!selectedVariant ? (
          <div className="text-xs text-muted-foreground italic">Pick a variant above first.</div>
        ) : loadingGroups ? (
          <div className="py-4 text-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline" />
          </div>
        ) : optionGroups.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No modifiers for this item.</div>
        ) : (
          <div className="grid gap-3">
            {optionGroups.map((g) => {
              const sel = selections[g.id] || new Set();
              const err = errors[g.id];
              const values = activeValues(g);
              return (
                <div key={g.id} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold text-sm">{g.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {g.selectionMode === "single" ? "Pick one" : "Pick any"}
                        {g.required && <span> · required</span>}
                        {g.selectionMode === "multi" && g.maxSelections != null && (
                          <span> · up to {g.maxSelections}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {sel.size > 0 && <Badge variant="secondary" className="text-xs">{sel.size} selected</Badge>}
                      {/* Optional groups: let the cashier clear the current pick. Radios
                          alone don't support deselect, so this button covers both single
                          and multi modes. Hidden when the group is required. */}
                      {!g.required && sel.size > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => setSelections((prev) => ({ ...prev, [g.id]: new Set() }))}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>

                  {g.selectionMode === "single" ? (
                    <RadioGroup value={Array.from(sel)[0] || ""} onValueChange={(v) => toggleSingle(g, v)} className="grid gap-1">
                      {values.map((v) => (
                        <label key={v.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value={v.id} id={`v-${v.id}`} />
                            <span className="text-sm">{v.name}</span>
                          </div>
                          {v.priceDelta !== 0 && (
                            <span className={`text-xs ${v.priceDelta > 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtDelta(v.priceDelta)}</span>
                          )}
                        </label>
                      ))}
                    </RadioGroup>
                  ) : (
                    <div className="grid gap-1">
                      {values.map((v) => (
                        <label key={v.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40">
                          <div className="flex items-center gap-2">
                            <Checkbox checked={sel.has(v.id)} onCheckedChange={() => toggleMulti(g, v.id)} />
                            <span className="text-sm">{v.name}</span>
                          </div>
                          {v.priceDelta !== 0 && (
                            <span className={`text-xs ${v.priceDelta > 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtDelta(v.priceDelta)}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}

                  {err && (
                    <Alert variant="destructive" className="mt-2 py-2">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <AlertDescription className="text-xs">{err}</AlertDescription>
                    </Alert>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Step 3: quantity + summary */}
      <div className={cn("transition-opacity", !selectedVariant && "opacity-50 pointer-events-none")}>
        <div className="text-sm font-semibold mb-2">3. Quantity</div>
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={!selectedVariant || submitting}>
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <span className="font-mono text-lg w-10 text-center">{quantity}</span>
            <Button type="button" variant="outline" size="icon" className="h-8 w-8" onClick={() => setQuantity((q) => q + 1)} disabled={!selectedVariant || submitting}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {selectedVariant && (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">
                ₱{variantUnitPrice.toFixed(2)}
                {modifiersTotal !== 0 && (
                  <span className={modifiersTotal > 0 ? "text-emerald-700" : "text-red-700"}> {fmtDelta(modifiersTotal)}</span>
                )}
                {` × ${quantity}`}
              </div>
              <div className="font-bold text-base">₱{lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
          )}
        </div>
      </div>

      {/* Step 4: special instructions */}
      <div className={cn("transition-opacity", !selectedVariant && "opacity-50 pointer-events-none")}>
        <div className="text-sm font-semibold mb-2">Special instructions <span className="font-normal text-muted-foreground">(optional)</span></div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={140} placeholder="e.g. no onions, extra spicy, separate packing…" disabled={!selectedVariant} />
      </div>

      <DialogFooter className="pt-2">
        <Button variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button onClick={handleAdd} disabled={!canAdd}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Item"}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function FamilyOrderModal({
  open,
  onOpenChange,
  storeId,
  group,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  group: AddonGroup | null;
  onAdd: (args: FamilyOrderAddArgs) => Promise<void>;
}) {
  const isMobile = useIsMobile();
  if (!group) return null;

  const content = (
    <FamilyOrderContent
      group={group}
      storeId={storeId}
      onCancel={() => onOpenChange(false)}
      onAdd={async (args) => {
        await onAdd(args);
        onOpenChange(false);
      }}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> {group.title}</DrawerTitle>
            <DrawerDescription>Pick a variant and any modifiers before adding to the order.</DrawerDescription>
          </DrawerHeader>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85dvh] overflow-y-auto p-0">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> {group.title}</DialogTitle>
          <DialogDescription>Pick a variant and any modifiers before adding to the order.</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

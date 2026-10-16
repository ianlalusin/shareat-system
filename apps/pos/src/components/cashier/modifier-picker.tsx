"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { OptionGroup, OptionGroupValue, SelectedModifier } from "@/lib/types";

export type PickerResult = {
  modifiers: SelectedModifier[];
  modifiersText: string;
  modifiersTotal: number;
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

function ModifierPickerContent({
  itemName,
  groups,
  onCancel,
  onConfirm,
}: {
  itemName: string;
  groups: OptionGroup[];
  onCancel: () => void;
  onConfirm: (result: PickerResult) => void;
}) {
  // Selection state: groupId -> Set<valueId>
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});

  useEffect(() => {
    const initial: Record<string, Set<string>> = {};
    for (const g of groups) {
      // For required single-select groups, pre-select the first active value.
      if (g.selectionMode === "single" && g.required) {
        const first = activeValues(g)[0];
        initial[g.id] = first ? new Set([first.id]) : new Set();
      } else {
        initial[g.id] = new Set();
      }
    }
    setSelections(initial);
  }, [groups]);

  function toggleSingle(g: OptionGroup, valueId: string) {
    setSelections((prev) => ({ ...prev, [g.id]: new Set([valueId]) }));
  }

  function toggleMulti(g: OptionGroup, valueId: string) {
    setSelections((prev) => {
      const next = new Set(prev[g.id] || []);
      if (next.has(valueId)) {
        next.delete(valueId);
      } else {
        // Respect maxSelections.
        if (g.maxSelections != null && next.size >= g.maxSelections) return prev;
        next.add(valueId);
      }
      return { ...prev, [g.id]: next };
    });
  }

  // Validation. Each group reports its own error, if any.
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const g of groups) {
      const sel = selections[g.id] || new Set();
      if (g.selectionMode === "single") {
        if (g.required && sel.size === 0) {
          out[g.id] = `Pick one ${g.name.toLowerCase()}.`;
        }
      } else {
        // `required` is the master switch: minSelections only applies when the
        // group is required. An optional group never forces a selection, even
        // if a stale min was stored from an earlier edit.
        const min = g.required ? (g.minSelections ?? 1) : 0;
        const max = g.maxSelections;
        if (sel.size < min) {
          out[g.id] = `Pick at least ${min}.`;
        } else if (max != null && sel.size > max) {
          out[g.id] = `Pick at most ${max}.`;
        }
      }
    }
    return out;
  }, [groups, selections]);

  const isValid = Object.keys(errors).length === 0;

  // Live total of selected deltas.
  const total = useMemo(() => {
    let sum = 0;
    for (const g of groups) {
      const sel = selections[g.id] || new Set();
      for (const v of activeValues(g)) {
        if (sel.has(v.id)) sum += Number(v.priceDelta || 0);
      }
    }
    return sum;
  }, [groups, selections]);

  function buildResult(): PickerResult {
    const mods: SelectedModifier[] = [];
    for (const g of groups) {
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
    const text = mods.map((m) => m.valueName).join(", ");
    const sum = mods.reduce((acc, m) => acc + m.priceDelta, 0);
    return { modifiers: mods, modifiersText: text, modifiersTotal: sum };
  }

  return (
    <div className="grid gap-4 p-4">
      <div className="text-sm">
        Customize <span className="font-semibold">{itemName}</span>
      </div>

      {groups.map((g) => {
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
                {/* Optional groups: radios alone can't deselect, so expose a Clear
                    affordance. Hidden when the group is required. */}
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
              <RadioGroup
                value={Array.from(sel)[0] || ""}
                onValueChange={(v) => toggleSingle(g, v)}
                className="grid gap-1"
              >
                {values.map((v) => (
                  <label
                    key={v.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={v.id} id={`v-${v.id}`} />
                      <span className="text-sm">{v.name}</span>
                    </div>
                    {v.priceDelta !== 0 && (
                      <span className={`text-xs ${v.priceDelta > 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {fmtDelta(v.priceDelta)}
                      </span>
                    )}
                  </label>
                ))}
              </RadioGroup>
            ) : (
              <div className="grid gap-1">
                {values.map((v) => (
                  <label
                    key={v.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={sel.has(v.id)}
                        onCheckedChange={() => toggleMulti(g, v.id)}
                      />
                      <span className="text-sm">{v.name}</span>
                    </div>
                    {v.priceDelta !== 0 && (
                      <span className={`text-xs ${v.priceDelta > 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {fmtDelta(v.priceDelta)}
                      </span>
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

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Modifier total</span>
        <span className={total === 0 ? "text-muted-foreground" : total > 0 ? "font-medium text-emerald-700" : "font-medium text-red-700"}>
          {total === 0 ? "—" : fmtDelta(total)}
        </span>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onConfirm(buildResult())} disabled={!isValid}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ModifierPicker({
  open,
  onOpenChange,
  itemName,
  groups,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemName: string;
  groups: OptionGroup[];
  onConfirm: (result: PickerResult) => void;
}) {
  const isMobile = useIsMobile();

  const content = (
    <ModifierPickerContent
      itemName={itemName}
      groups={groups}
      onCancel={() => onOpenChange(false)}
      onConfirm={(r) => { onConfirm(r); onOpenChange(false); }}
    />
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader className="text-left">
            <DrawerTitle>Customize</DrawerTitle>
            <DrawerDescription>Pick modifiers for this item before adding to the order.</DrawerDescription>
          </DrawerHeader>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85dvh] overflow-y-auto p-0">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>Customize</DialogTitle>
          <DialogDescription>Pick modifiers for this item before adding to the order.</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}

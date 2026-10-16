
"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Edit } from "lucide-react";
import { useState, useMemo } from "react";
import { AddonsLauncherButton } from "./addons-launcher-button";
import { Badge } from "../ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { format } from "date-fns";
import { toJsDate } from "@/lib/utils/date";
import { useAuthContext } from "@/context/auth-context";
import type { Discount, PendingSession, SessionBillLine } from "@/lib/types";

interface BillableItemsProps {
  lines: SessionBillLine[];
  storeId: string;
  session: PendingSession;
  discounts: Discount[];
  isLocked?: boolean;
  onUpdateLine: (line: SessionBillLine) => void;
  onAddLine?: (line: SessionBillLine) => void;
}

function BillableLineRow({ 
    line, 
    onEdit,
    isLocked,
}: { 
    line: SessionBillLine, 
    onEdit: (line: SessionBillLine) => void,
    isLocked?: boolean,
}) {
    const totalDiscountQty = line.discountQty;
    const totalFreeQty = line.freeQty;

    const netQty = line.qtyOrdered - line.voidedQty;
    const unitPrice = line.unitPrice ?? 0;
    const modTotal = Number((line as any).modifiersTotal ?? 0);
    const effectiveUnit = unitPrice + modTotal;
    const modifiersText = (line as any).modifiersText as string | undefined;
    // The bundle overflow line is system-managed (driven by guest count) — it
    // must not be hand-edited or voided, or it would drift from the headcount.
    const isSystemManaged = line.id.startsWith('bundleextra_');

    return (
        <div className="flex flex-col border-b last:border-b-0">
            <div className="flex items-center gap-4 py-3 px-4">
                <div className="flex-1">
                    <p className="font-medium">{netQty > 1 && `${netQty}x `}{line.itemName}</p>
                    {modifiersText && (
                      <p className="text-xs text-muted-foreground italic pl-2">— {modifiersText}</p>
                    )}
                    {(line as any).note && (
                      <p className="text-xs text-amber-700 italic pl-2">📝 {(line as any).note}</p>
                    )}
                     <div className="text-xs text-muted-foreground">
                        <p>{netQty} x ₱{effectiveUnit.toFixed(2)} each = ₱{(netQty * effectiveUnit).toFixed(2)}</p>
                    </div>
                    {totalDiscountQty > 0 && <Badge variant="outline" className="mt-1 border-blue-500 text-blue-600">{totalDiscountQty} discounted</Badge>}
                    {totalFreeQty > 0 && <Badge variant="outline" className="mt-1 border-green-500 text-green-600">{totalFreeQty} free</Badge>}
                </div>
                {!isLocked && (
                    <div className="flex items-center gap-2">
                       {isSystemManaged ? (
                            <Badge variant="outline" className="text-muted-foreground font-normal">Auto · from guests</Badge>
                       ) : (
                            <Button variant="outline" size="sm" onClick={() => onEdit(line)}>
                                <Edit className="mr-2"/> Edit
                            </Button>
                       )}
                    </div>
                )}
            </div>
        </div>
    )
}

export function BillableItems({ 
    lines,
    storeId,
    session,
    discounts,
    isLocked = false,
    onUpdateLine,
    onAddLine
}: BillableItemsProps) {
  
  const { appUser } = useAuthContext();
  
  const { activeLines, voidedLines } = useMemo(() => {
    // Keep the package/bundle line pinned to the top (dine-in sessions). Stable
    // sort preserves the createdAt order of everything else.
    const packageFirst = (a: SessionBillLine, b: SessionBillLine) =>
      (a.type === 'package' ? 0 : 1) - (b.type === 'package' ? 0 : 1);
    const active = lines.filter(line => (line.qtyOrdered - line.voidedQty) > 0).sort(packageFirst);
    const voided = lines.filter(line => line.voidedQty > 0).sort(packageFirst);
    return { activeLines: active, voidedLines: voided };
  }, [lines]);

  return (
    <>
      <Card className="flex-1 flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between p-4 border-b sticky top-0 bg-background z-10">
            <CardTitle className="text-lg">Billable Items</CardTitle>
            <AddonsLauncherButton
              storeId={storeId}
              session={session}
              sessionIsLocked={isLocked}
              onAddLine={onAddLine}
            />
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-y-auto">
            <div className="divide-y">
                {activeLines.map((line) => (
                    <BillableLineRow 
                        key={line.id}
                        line={line}
                        onEdit={onUpdateLine}
                        isLocked={isLocked}
                    />
                ))}

                {voidedLines.length > 0 && (
                     <Accordion type="single" collapsible className="w-full">
                        <AccordionItem value="voided-items" className="border-t">
                            <AccordionTrigger className="px-4 text-muted-foreground">
                                Voided Items ({voidedLines.reduce((sum, l) => sum + l.voidedQty, 0)})
                            </AccordionTrigger>
                            <AccordionContent className="px-4">
                                <div className="divide-y">
                                {voidedLines.map(line => (
                                    <div key={`${line.id}-voided`} className="py-2">
                                        <div className="flex justify-between">
                                            <p className="font-medium text-muted-foreground line-through">{line.voidedQty}x {line.itemName}</p>
                                            <p className="text-muted-foreground line-through">₱{(line.voidedQty * (line.unitPrice ?? 0)).toFixed(2)}</p>
                                        </div>
                                    </div>
                                ))}
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                     </Accordion>
                )}
            </div>
        </CardContent>
      </Card>
    </>
  );
}

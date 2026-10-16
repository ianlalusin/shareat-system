"use client";

import { useCallback, useEffect, useMemo } from "react";
import { Loader2, Pencil, Plus, QrCode } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSavedQrCodes } from "@/hooks/useSavedQrCodes";
import { cleanupRadixOverlays } from "@/lib/ui/cleanup-radix";
import { pickOnlineQr } from "@/lib/qr/online-qr";
import { cn } from "@/lib/utils";
import type { SavedQrCode } from "@/lib/types";

import { QrTileIcon } from "./QrTileIcon";

export type QrWalletModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string | null;
  /** Opens the add/edit dialog. `null` starts a new entry. */
  onManage: (qr: SavedQrCode | null) => void;
  /** Hands a tile to the dedicated display modal (which replaces this one). */
  onDisplay: (qr: SavedQrCode) => void;
};

/**
 * The QR wallet: a grid of saved QR tiles. Tapping one shows it full-size for a
 * customer to scan.
 *
 * Drawer on mobile / Dialog on desktop, following AddonsPOSModal — a cashier
 * holding a tablet in portrait gets a sheet that does not fight the keyboard.
 */
export function QrWalletModal({
  open,
  onOpenChange,
  storeId,
  onManage,
  onDisplay,
}: QrWalletModalProps) {
  const isMobile = useIsMobile();
  const { qrCodes, loading, error } = useSavedQrCodes(storeId);

  const active = qrCodes.filter((qr) => qr.isActive !== false);

  // pickOnlineQr, NOT a raw filter — so a double-flag (which rules cannot
  // prevent) renders exactly one "Online" badge, never two.
  const onlineQr = useMemo(() => pickOnlineQr(qrCodes), [qrCodes]);

  // This modal can open from inside the mobile nav Sheet — nested Radix portals
  // are exactly the case that strands an overlay and leaves the app unclickable.
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(cleanupRadixOverlays, 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Hands off to the dedicated display modal. This wallet closes rather than
  // hosting the QR: nested inside here it inherited this dialog's box and got
  // clipped, and a QR that has to be scrolled to will not get scanned.
  const handleSelect = useCallback(
    (qr: SavedQrCode) => {
      onDisplay(qr);
    },
    [onDisplay],
  );

  const body = (
    <div className="relative min-h-[240px] flex-1 overflow-hidden">
      <ScrollArea className="h-full max-h-[60vh]">
        <div className="p-1">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Loading saved QR codes…</p>
            </div>
          )}

          {!loading && error && (
            <p className="py-12 text-center text-sm text-destructive">
              Couldn&apos;t load the wallet. {error}
            </p>
          )}

          {!loading && !error && active.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
              <QrCode className="h-10 w-10 opacity-40" />
              <p className="text-sm font-medium">No saved QR codes yet</p>
              <RoleGuard allow={["admin", "manager"]} hideOnDeny>
                <p className="max-w-xs text-sm">
                  Tap <span className="font-medium">Add QR</span> and photograph a GCash or bank QR
                  to save it here.
                </p>
              </RoleGuard>
            </div>
          )}

          {!loading && !error && active.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {active.map((qr) => (
                <div key={qr.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => handleSelect(qr)}
                    title={`Show ${qr.name}`}
                    className={cn(
                      "flex w-full flex-col items-center gap-2 rounded-xl border bg-card p-3",
                      "transition-colors hover:bg-accent focus-visible:outline-none",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <div className="h-14 w-14 shrink-0">
                      <QrTileIcon qr={qr} />
                    </div>
                    <span className="line-clamp-2 w-full break-words text-center text-xs font-medium leading-tight">
                      {qr.name}
                    </span>
                  </button>

                  {onlineQr?.id === qr.id && (
                    <Badge
                      variant="secondary"
                      className="absolute left-1 top-1 h-4 px-1 text-[10px] font-medium leading-none"
                    >
                      Online
                    </Badge>
                  )}

                  <RoleGuard allow={["admin", "manager"]} hideOnDeny>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      aria-label={`Edit ${qr.name}`}
                      title={`Edit ${qr.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onManage(qr);
                      }}
                      className="absolute right-1 top-1 h-7 w-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </RoleGuard>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );

  const addButton = (
    <RoleGuard allow={["admin", "manager"]} hideOnDeny>
      <Button type="button" onClick={() => onManage(null)} disabled={!storeId}>
        <Plus className="mr-2 h-4 w-4" />
        Add QR
      </Button>
    </RoleGuard>
  );

  const title = "QR Wallet";
  const description = "Show a saved QR code for a customer to scan and pay.";

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="flex max-h-[92dvh] flex-col">
          <DrawerHeader className="shrink-0 text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col px-4">{body}</div>
          <DrawerFooter className="shrink-0 flex-row justify-end gap-2">
            {addButton}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] max-w-2xl flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        <DialogFooter className="shrink-0">
          {addButton}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

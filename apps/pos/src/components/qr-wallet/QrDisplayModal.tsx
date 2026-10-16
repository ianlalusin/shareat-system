"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Camera, CheckCircle2, Loader2, ScanLine, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useLocalProfile } from "@/context/local-profile-context";
import { capturePaymentProof } from "@/lib/payments/proof/capture";
import type { SavedQrCode } from "@/lib/types";

import { QrTileIcon } from "./QrTileIcon";

/**
 * Dedicated full-attention modal for showing one saved QR to a customer.
 *
 * ITS OWN MODAL, not an overlay inside the wallet. Nested inside the wallet's
 * dialog the QR inherited that dialog's box and got clipped — and a QR that is
 * clipped or has to be scrolled to is a QR that will not scan. The wallet
 * closes when this opens, so there is exactly one dialog on screen and no
 * stacked Radix portals to strand.
 *
 * LAYOUT: side-by-side on a wide screen (QR left, details right), stacked in
 * portrait on mobile (QR on top). The QR is sized from BOTH viewport axes so
 * it always fits without scrolling — clamping on width alone clips it on a
 * short landscape tablet, which is exactly the shape a till runs at.
 *
 * The QR panel is always white with dark modules regardless of theme. Scanners
 * expect that polarity, and a dark-mode QR is a support call.
 */
export function QrDisplayModal({
  qr,
  storeId,
  open,
  onClose,
}: {
  qr: SavedQrCode | null;
  storeId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const releaseRef = useRef<null | (() => void)>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const { currentProfile } = useLocalProfile();

  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState(0);

  useEffect(() => {
    if (!open) setCaptured(0);
  }, [open]);

  // Keep the screen awake while a customer is scanning — a tablet that sleeps
  // mid-scan reads as a broken QR. Best-effort; unsupported in some WebViews.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const anyNav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };

    anyNav.wakeLock
      ?.request("screen")
      .then((sentinel) => {
        if (cancelled) {
          void sentinel.release();
          return;
        }
        releaseRef.current = () => void sentinel.release();
      })
      .catch(() => {
        /* A nicety, never a requirement. */
      });

    return () => {
      cancelled = true;
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [open]);

  const handleCapture = useCallback(
    async (file: File) => {
      if (!storeId || !qr) return;
      setCapturing(true);
      try {
        await capturePaymentProof({
          file,
          storeId,
          qr,
          localUserId: currentProfile?.profileId ?? null,
          isOnline,
        });
        setCaptured((n) => n + 1);
        toast({
          title: "Proof saved",
          description: isOnline
            ? "Photo saved to this sale's records."
            : "Saved on this device — it will upload when you're back online.",
        });
      } catch (error: any) {
        console.error("[QrDisplayModal] proof capture failed:", error);
        toast({
          variant: "destructive",
          title: "Couldn't save the photo",
          description: error?.message ?? "Please try again.",
        });
      } finally {
        setCapturing(false);
      }
    },
    [currentProfile?.profileId, isOnline, qr, storeId, toast],
  );

  if (!qr) return null;

  const warnings = qr.meta?.warnings ?? [];
  const hasAmount = warnings.includes("has_amount");

  const qrPanel = (
    <div className="flex shrink-0 items-center justify-center bg-white p-4 sm:p-6 md:w-[52%]">
      {qr.payload ? (
        <QRCodeSVG
          value={qr.payload}
          level="M"
          marginSize={2}
          // Bounded on BOTH axes so it never overflows the modal in any shape.
          className="h-auto w-full max-w-[min(78vw,44dvh)] md:max-w-[min(38vw,62dvh)]"
        />
      ) : (
        <div className="flex aspect-square w-full max-w-[min(78vw,44dvh)] flex-col items-center justify-center gap-2 p-6 text-center md:max-w-[min(38vw,62dvh)]">
          <ScanLine className="h-8 w-8 text-neutral-400" />
          <p className="text-sm font-medium text-neutral-800">This QR needs re-scanning</p>
          <p className="text-sm text-neutral-500">
            It was saved before the scanner was added. Ask a manager to edit it and scan again.
          </p>
        </div>
      )}
    </div>
  );

  const detailsPanel = (
    <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 shrink-0">
          <QrTileIcon qr={qr} />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold leading-tight">{qr.name}</h3>
          {qr.meta?.maskedAccount && (
            <p className="text-sm tabular-nums text-muted-foreground">{qr.meta.maskedAccount}</p>
          )}
        </div>
      </div>

      <p className="text-base font-medium">Scan QR to proceed</p>

      {hasAmount && (
        <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          This QR has a fixed amount baked in.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        Once the customer has paid, take a photo of their proof of payment.
      </p>

      {captured > 0 && (
        <p className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {captured === 1 ? "1 photo saved" : `${captured} photos saved`}
          <span className="text-muted-foreground">· kept 15 days</span>
        </p>
      )}

      {/* Showing a QR records no tender, so this line is the only thing between
          "customer paid" and "sale never rung up". Always visible. */}
      <p className="text-sm text-muted-foreground">
        Display only — record this payment in the payment screen.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void handleCapture(file);
        }}
      />

      {/* Short labels on purpose. The right pane is narrow on a landscape till
          and long labels clipped; the surrounding copy already explains what
          the photo is for, so the button does not have to. */}
      <div className="mt-auto flex gap-2 pt-2">
        <Button
          type="button"
          className="min-w-0 flex-1"
          onClick={() => fileInputRef.current?.click()}
          disabled={capturing || !storeId}
        >
          {capturing ? (
            <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <Camera className="mr-2 h-4 w-4 shrink-0" />
          )}
          <span className="truncate">{captured > 0 ? "Take another" : "Take photo"}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={onClose}
          disabled={capturing}
          aria-label="Back to wallet"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="ml-2 hidden sm:inline">Back</span>
        </Button>
      </div>
    </div>
  );

  const a11y = (
    <>
      <DialogTitle className="sr-only">{qr.name}</DialogTitle>
      <DialogDescription className="sr-only">
        Show this QR code for the customer to scan and pay.
      </DialogDescription>
    </>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
        <DrawerContent className="max-h-[94dvh] overflow-hidden">
          <DrawerTitle className="sr-only">{qr.name}</DrawerTitle>
          <DrawerDescription className="sr-only">
            Show this QR code for the customer to scan and pay.
          </DrawerDescription>
          <div className="flex flex-col overflow-hidden">
            {qrPanel}
            {detailsPanel}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        {a11y}
        <div className="flex flex-row items-stretch">
          {qrPanel}
          {detailsPanel}
        </div>
      </DialogContent>
    </Dialog>
  );
}

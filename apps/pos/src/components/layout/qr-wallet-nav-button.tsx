"use client";

import { QrCode } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useQrWallet } from "@/context/qr-wallet-context";
import { cn } from "@/lib/utils";

/**
 * Navbar entry that opens the QR wallet.
 *
 * Visible to every store role: a cashier must be able to show a customer a
 * saved QR. Adding or editing one is gated separately, inside the wallet.
 */
export function QrWalletNavButton({
  className,
  variant = "ghost",
  showLabel = false,
}: {
  className?: string;
  variant?: "ghost" | "outline";
  showLabel?: boolean;
}) {
  const { openWallet } = useQrWallet();

  return (
    <Button
      type="button"
      variant={variant}
      size={showLabel ? "sm" : "icon"}
      onClick={openWallet}
      aria-label="QR wallet"
      title="QR wallet — show a saved QR code"
      className={cn(showLabel && "gap-2", className)}
    >
      <QrCode className="h-4 w-4 shrink-0" />
      {showLabel && <span>QR Wallet</span>}
    </Button>
  );
}

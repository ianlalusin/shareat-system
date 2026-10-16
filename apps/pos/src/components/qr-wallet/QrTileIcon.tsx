"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { initialsBadge } from "@/lib/qr/initials";
import type { SavedQrCode } from "@/lib/types";

/**
 * Tile artwork for a saved QR: the fetched brand logo when there is one,
 * otherwise a deterministic initials badge.
 *
 * Falls back on image error too, not just on a missing URL — a fetched icon can
 * 404 later (Storage object deleted, offline tablet with a cold cache), and a
 * broken-image glyph in the wallet looks like the QR itself is broken.
 */
export function QrTileIcon({
  qr,
  className,
}: {
  qr: Pick<SavedQrCode, "name" | "iconUrl" | "iconInitials" | "iconColor">;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  const fallback = initialsBadge(qr.name);
  const initials = qr.iconInitials || fallback.initials;
  const color = qr.iconColor || fallback.color;

  if (qr.iconUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={qr.iconUrl}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={cn("h-full w-full rounded-lg bg-white object-contain p-1.5", className)}
      />
    );
  }

  return (
    <div
      aria-hidden
      style={{ backgroundColor: color }}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-lg font-semibold text-white",
        className,
      )}
    >
      {initials}
    </div>
  );
}

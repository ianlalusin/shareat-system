
"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cleanupRadixOverlays } from "@/lib/ui/cleanup-radix";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

export function useConfirmDialog() {
  const [open, setOpen] = React.useState(false);
  const [opts, setOpts] = React.useState<ConfirmOptions>({
    title: "Confirm",
    description: "",
    confirmText: "Confirm",
    cancelText: "Cancel",
    destructive: true,
  });

  const resolverRef = React.useRef<((v: boolean) => void) | null>(null);

  function confirm(next: ConfirmOptions) {
    setOpts({
      title: next.title,
      description: next.description ?? "",
      confirmText: next.confirmText ?? "Confirm",
      cancelText: next.cancelText ?? "Cancel",
      destructive: next.destructive ?? true,
    });
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      // Resolve false only if a resolver exists (wasn't already resolved by Action)
      resolverRef.current?.(false);
      resolverRef.current = null;
      setTimeout(cleanupRadixOverlays, 200);
    }
  };

  const handleActionClick = () => {
    resolverRef.current?.(true);
    resolverRef.current = null;
    setOpen(false);
    setTimeout(cleanupRadixOverlays, 200);
  };

  const Dialog = (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts.title}</AlertDialogTitle>
          {opts.description ? (
            <AlertDialogDescription>{opts.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{opts.cancelText}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleActionClick}
            className={
              opts.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : ""
            }
          >
            {opts.confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, Dialog };
}

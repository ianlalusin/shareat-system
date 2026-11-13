"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * T-568: the readable, copyable surface for a slip that could not be printed (no printer paired, or the print failed).
 * It replaces the browser's own alert(): a toast cannot hold a multi-line receipt, so the toast is the notification and
 * this window is where the text is read and copied.
 */
export function SlipTextDialog({ text, title, onClose }: { text: string | null; title: string; onClose: () => void }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      toast({ title: "Copied", description: "The slip text is on the clipboard." });
    } catch {
      toast({ variant: "destructive", title: "Could not copy", description: "Select the slip text and copy it by hand." });
    }
  };
  return (
    <Dialog open={text !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            No printer is paired, or the print failed. Select and copy the slip below; it is not saved anywhere else.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs">{text}</pre>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={copy}>Copy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

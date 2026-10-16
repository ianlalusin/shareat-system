
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PlusCircle } from "lucide-react";
import { AddonsPOSModal } from "@/components/shared/AddonsPOSModal";
import type { PendingSession, SessionBillLine } from "@/lib/types";

interface AddonsLauncherButtonProps {
  storeId: string;
  session: PendingSession;
  sessionIsLocked?: boolean;
  onAddLine?: (line: SessionBillLine) => void;
}

export function AddonsLauncherButton({ storeId, session, sessionIsLocked, onAddLine }: AddonsLauncherButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" disabled={sessionIsLocked} onClick={() => setIsModalOpen(true)}>
          <PlusCircle className="mr-2"/> Add Add-on
      </Button>
      
      {isModalOpen && (
        <AddonsPOSModal
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          storeId={storeId}
          session={session}
          sessionIsLocked={sessionIsLocked}
          onAddLine={onAddLine}
        />
      )}
    </>
  );
}

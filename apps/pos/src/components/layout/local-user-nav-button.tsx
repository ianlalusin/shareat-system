"use client";

import { Button } from "@/components/ui/button";
import { UserCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocalProfile } from "@/context/local-profile-context";
import { useAuthContext } from "@/context/auth-context";
import { bypassesLocalUserGate } from "@/lib/server-profiles/localGate";

/** Navbar entry that opens the local-user (device profile) selector. Hidden for
 * admins/managers, who are attributed by their own account and bypass local sign-in. */
export function LocalUserNavButton({ className }: { className?: string }) {
  const { appUser } = useAuthContext();
  const { currentProfile, openSwitcher } = useLocalProfile();

  if (bypassesLocalUserGate(appUser)) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={openSwitcher}
      aria-label="Local user"
      title={currentProfile ? `Local user: ${currentProfile.name}` : "Sign in as a local user"}
      className={cn("text-black gap-2", className)}
    >
      <UserCircle2 className="h-4 w-4 shrink-0" />
      <span className="hidden max-w-[110px] truncate sm:inline">{currentProfile ? currentProfile.name : "Sign in"}</span>
    </Button>
  );
}

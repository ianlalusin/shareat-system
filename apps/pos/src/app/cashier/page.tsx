"use client";

import { Suspense, useEffect } from 'react';
import { useSearchParams } from "next/navigation";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from "@/hooks/use-toast";
import { useLocalProfile } from "@/context/local-profile-context";
import { useIdleTimer } from "@/hooks/useIdleTimer";
import { useStoreContext } from "@/context/store-context";
import { ChatInbox } from "@/components/cashier/ChatInbox";

const SessionDetailView = dynamic(
  () => import('@/components/cashier/session-detail-view').then((mod) => mod.SessionDetailView),
  {
    loading: () => <div className="flex items-center justify-center h-screen"><Loader2 className="h-10 w-10 animate-spin" /></div>,
    ssr: false,
  }
);

const SessionListView = dynamic(
  () => import('@/components/cashier/session-list-view').then((mod) => mod.SessionListView),
  {
    loading: () => <div className="flex items-center justify-center h-screen"><Loader2 className="h-10 w-10 animate-spin" /></div>,
    ssr: false,
  }
);

function CashierPageContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get('sessionId') ?? null;
  const { toast } = useToast();
  const { currentProfile, signOut } = useLocalProfile();
  const { activeStore } = useStoreContext();

  // Idle auto sign-out (30 minutes), mirroring the server station.
  const { isIdle } = useIdleTimer({ idleMs: 30 * 60_000 });
  useEffect(() => {
    if (isIdle && currentProfile) {
      signOut();
      toast({ title: "Signed out", description: "Inactive for 30 minutes." });
    }
  }, [isIdle, currentProfile, signOut, toast]);

  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      {sessionId ? <SessionDetailView sessionId={sessionId} /> : <SessionListView />}
      <ChatInbox storeId={activeStore?.id} />
    </RoleGuard>
  );
}

export default function CashierPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>}>
      <CashierPageContent />
    </Suspense>
  )
}

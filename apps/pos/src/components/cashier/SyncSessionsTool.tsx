'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useAuthContext } from '@/context/auth-context';
import { useStoreContext } from '@/context/store-context';
import { useToast } from '@/hooks/use-toast';
import { collection, query, where, getDocs, writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import { RoleGuard } from '../guards/RoleGuard';
import { toJsDate } from '@/lib/utils/date';
import type { PendingSession } from '@/lib/types';

export function SyncSessionsTool() {
  const { appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const { toast } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = async () => {
    if (!activeStore) {
      toast({ variant: 'destructive', title: 'No store selected' });
      return;
    }
    setIsSyncing(true);
    toast({ title: 'Sync started...', description: 'Fetching all active sessions.' });

    try {
      const sourceSessionsRef = collection(db, 'stores', activeStore.id, 'sessions');
      const targetSessionsRef = collection(db, 'stores', activeStore.id, 'activeSessions');

      // 1. Get all source-of-truth active sessions
      const q = query(sourceSessionsRef, where('status', 'in', ['active', 'pending_verification']));
      const sourceSnapshot = await getDocs(q);
      const sourceSessions = sourceSnapshot.docs.map(d => ({ id: d.id, ...d.data() } as PendingSession));

      // 2. Get all current projections to find which ones to delete
      const targetSnapshot = await getDocs(targetSessionsRef);
      const targetIds = new Set(targetSnapshot.docs.map(d => d.id));
      const sourceIds = new Set(sourceSessions.map(s => s.id));

      const batch = writeBatch(db);
      let writeCount = 0;
      let deleteCount = 0;

      // 3. Delete stale projections
      targetIds.forEach(id => {
        if (!sourceIds.has(id)) {
          batch.delete(doc(targetSessionsRef, id));
          deleteCount++;
        }
      });
      
      // 4. Create/update projections for active sessions
      sourceSessions.forEach(session => {
        const projectionRef = doc(targetSessionsRef, session.id);
        const projectionPayload = {
            id: session.id,
            status: session.status,
            sessionMode: session.sessionMode,
            tableId: session.tableId,
            tableNumber: session.tableNumber || null,
            customerName: (session.customer as any)?.name || session.customerName || null,
            packageOfferingId: session.packageOfferingId || null,
            packageName: (session.packageSnapshot as any)?.name || null,
            packageSnapshot: session.packageSnapshot || null,
            guestCountCashierInitial: session.guestCountCashierInitial || 0,
            guestCountServerVerified: session.guestCountServerVerified || null,
            guestCountFinal: session.guestCountFinal || null,
            startedAt: session.startedAt,
            startedAtClientMs: session.startedAtClientMs || toJsDate(session.startedAt)?.getTime() || null,
            updatedAt: serverTimestamp(),
            initialFlavorIds: session.initialFlavorIds || [],
            guestCountChange: session.guestCountChange || { status: 'none' },
            packageChange: session.packageChange || { status: 'none' },
        };
        batch.set(projectionRef, projectionPayload);
        writeCount++;
      });

      await batch.commit();

      toast({
        title: 'Sync Complete',
        description: `${writeCount} session(s) synced, ${deleteCount} stale session(s) removed.`,
      });
    } catch (error: any) {
      console.error('Session sync failed:', error);
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: error.message,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <RoleGuard allow={['admin', 'manager']} hideOnDeny>
      <Button variant="outline" onClick={handleSync} disabled={isSyncing}>
        {isSyncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        Sync Sessions
      </Button>
    </RoleGuard>
  );
}

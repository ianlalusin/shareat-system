"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Users, Clock, Phone, X, Loader2 } from "lucide-react";
import { TimeElapsed } from "@/components/server/SessionCard";
import { ParkWalkInModal } from "./ParkWalkInModal";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { useToast } from "@/hooks/use-toast";

export interface WaitlistEntry {
  id: string;
  name: string;
  partySize: number;
  phone: string | null;
  notes: string | null;
  status: "waiting" | "seated" | "cancelled";
  createdAtClientMs: number;
  createdAt?: any;
}

interface Props {
  storeId: string;
  onSeat: (entry: WaitlistEntry) => void;
  activeSeatingId?: string | null;
}

export function WaitlistCard({ storeId, onSeat, activeSeatingId }: Props) {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
  const { toast } = useToast();

  useEffect(() => {
    if (!storeId) return;
    const q = query(
      collection(db, "stores", storeId, "waitlist"),
      where("status", "==", "waiting")
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as WaitlistEntry[];
      rows.sort((a, b) => (a.createdAtClientMs ?? 0) - (b.createdAtClientMs ?? 0));
      setEntries(rows);
      setIsLoading(false);
    }, () => setIsLoading(false));
    return () => unsub();
  }, [storeId]);

  const handleCancel = async (entry: WaitlistEntry) => {
    if (!(await confirm({
      title: `Remove ${entry.name} from waitlist?`,
      description: "They'll no longer appear on this list.",
      confirmText: "Remove",
    }))) return;
    try {
      await deleteDoc(doc(db, "stores", storeId, "waitlist", entry.id));
      toast({ title: "Removed", description: entry.name });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Error", description: err?.message });
    }
  };

  const count = entries.length;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 p-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" />
              Waitlist
              {count > 0 && <Badge variant="secondary">{count}</Badge>}
            </CardTitle>
            <CardDescription className="text-xs">Walk-ins waiting for a table.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Park
          </Button>
        </CardHeader>
        <CardContent className="pt-0 px-4 pb-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No one on the waitlist.</p>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => {
                const isActive = activeSeatingId === e.id;
                return (
                  <li
                    key={e.id}
                    className={`rounded-lg border p-2 flex items-center gap-2 ${isActive ? "bg-primary/5 border-primary/50" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-bold truncate">{e.name}</p>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          <Users className="h-3 w-3 mr-0.5" />{e.partySize}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground flex items-center gap-0.5">
                          <Clock className="h-3 w-3" />
                          <TimeElapsed startTime={e.createdAt} startTimeMs={e.createdAtClientMs ?? null} />
                        </span>
                      </div>
                      {(e.phone || e.notes) && (
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground truncate">
                          {e.phone && (
                            <span className="flex items-center gap-0.5">
                              <Phone className="h-3 w-3" /> {e.phone}
                            </span>
                          )}
                          {e.notes && <span className="truncate">· {e.notes}</span>}
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={isActive ? "default" : "outline"}
                      onClick={() => onSeat(e)}
                      className="h-8"
                    >
                      Seat
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleCancel(e)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${e.name} from waitlist`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ParkWalkInModal open={modalOpen} onOpenChange={setModalOpen} storeId={storeId} />
      {ConfirmDialog}
    </>
  );
}



"use client";

import { useState, useEffect, useMemo, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { PageHeader } from "@/components/page-header";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { collection, query, where, onSnapshot, orderBy, limit, Timestamp, getDocs, getDoc, doc, startAfter, QueryDocumentSnapshot, DocumentData } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { Loader2, Search, ArrowLeft, Clock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebounce } from "@/hooks/use-debounce";
import { toJsDate } from "@/lib/utils/date";
import { format } from "date-fns";
import type { KitchenTicket } from "@/lib/types";

import { formatDurationHuman } from "@/lib/utils/date";
function formatDuration(ms: number) { return formatDurationHuman(ms, "-"); }

function HistoryPageContent() {
  const { appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const searchParams = useSearchParams();
  const kitchenLocationId = searchParams.get('kitchenLocationId');

  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastVisible, setLastVisible] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [stationName, setStationName] = useState("");
  
  const [filter, setFilter] = useState<'all' | 'served' | 'cancelled'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  const fetchTickets = useCallback(async (loadMore = false) => {
    if (!activeStore || !kitchenLocationId) return;

    setIsLoading(true);

    const ticketsRef = collection(db, 'stores', activeStore.id, 'rtKdsTickets', kitchenLocationId, 'closedKdsTickets');
    let q = query(
      ticketsRef,
      orderBy('updatedAt', 'desc'),
      limit(25)
    );

    if (loadMore && lastVisible) {
      q = query(q, startAfter(lastVisible));
    }

    try {
      const snapshot = await getDocs(q);
      const newTickets = snapshot.docs.map(d => d.data() as KitchenTicket);
      
      setLastVisible(snapshot.docs[snapshot.docs.length - 1] || null);
      setHasMore(snapshot.docs.length === 25);
      
      setTickets(prev => loadMore ? [...prev, ...newTickets] : newTickets);

    } catch (error) {
      console.error("Error fetching kitchen history:", error);
    } finally {
      setIsLoading(false);
    }
  }, [activeStore, kitchenLocationId, lastVisible]);
  
  useEffect(() => {
    setTickets([]);
    setLastVisible(null);
    setHasMore(true);
    fetchTickets(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore, kitchenLocationId]);
  
  useEffect(() => {
      if (!activeStore || !kitchenLocationId) return;
      getDoc(doc(db, 'stores', activeStore.id, 'kitchenLocations', kitchenLocationId))
        .then(snap => {
            if(snap.exists()) setStationName(snap.data().name);
        });
  }, [activeStore, kitchenLocationId])

  const filteredAndGroupedTickets = useMemo(() => {
    let filtered = tickets;
    if (filter !== 'all') {
        filtered = filtered.filter(t => t.status === filter);
    }
    if (debouncedSearchTerm) {
        const lowerSearch = debouncedSearchTerm.toLowerCase();
        filtered = filtered.filter(t => 
            t.itemName?.toLowerCase().includes(lowerSearch) ||
            t.sessionLabel?.toLowerCase().includes(lowerSearch)
        );
    }

    const groupedByDate = filtered.reduce((acc, ticket) => {
        const closedAt = toJsDate(ticket.servedAtClientMs || ticket.cancelledAtClientMs || ticket.createdAtClientMs || ticket.updatedAt);
        const dateKey = closedAt ? format(closedAt, 'yyyy-MM-dd') : 'unknown';
        
        if (!acc[dateKey]) acc[dateKey] = [];
        acc[dateKey].push(ticket);
        return acc;
    }, {} as Record<string, KitchenTicket[]>);

    return Object.entries(groupedByDate)
        .sort(([dateA], [dateB]) => dateB.localeCompare(dateA)) // Sort dates descending
        .map(([date, tickets]) => {
            const groupedBySession = tickets
                .filter((t) => t.sessionId || t.onlineOrderId)
                .reduce((acc, ticket) => {
                    const sessionKey = (ticket.sessionId || ticket.onlineOrderId) as string;
                    if (!acc[sessionKey]) acc[sessionKey] = [];
                    acc[sessionKey].push(ticket);
                    return acc;
            }, {} as Record<string, KitchenTicket[]>);
            
            return {
                date: format(new Date(date), 'MMMM d, yyyy'),
                sessions: Object.entries(groupedBySession).map(([sessionId, tickets]) => ({
                    sessionId,
                    sessionLabel: tickets[0].sessionLabel,
                    tickets,
                }))
            }
        });
  }, [tickets, filter, debouncedSearchTerm]);

  if (!activeStore || !kitchenLocationId) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Error</CardTitle>
                <CardDescription>Store or kitchen location not specified. Please go back to the kitchen page and select a station.</CardDescription>
            </CardHeader>
        </Card>
    );
  }

  return (
    <RoleGuard allow={["admin", "manager", "kitchen"]}>
      <PageHeader title={`History: ${stationName}`} description="Browse all completed and cancelled kitchen tickets for this station.">
        <Button variant="outline" asChild><a href="/kitchen"><ArrowLeft className="mr-2 h-4 w-4" />Back to KDS</a></Button>
      </PageHeader>

      <div className="flex flex-col sm:flex-row gap-4 my-6">
        <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
                placeholder="Search by item or session..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8"
            />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
            <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="served">Served</TabsTrigger>
                <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
            </TabsList>
        </Tabs>
      </div>
      
      {isLoading && tickets.length === 0 ? (
          <div className="flex justify-center p-10"><Loader2 className="animate-spin" /></div>
      ) : filteredAndGroupedTickets.length === 0 ? (
          <p className="text-center text-muted-foreground py-10">No history found for the selected criteria.</p>
      ) : (
        <div className="space-y-4">
            {filteredAndGroupedTickets.map(dateGroup => (
                <Card key={dateGroup.date}>
                    <CardHeader><CardTitle>{dateGroup.date}</CardTitle></CardHeader>
                    <CardContent>
                        <Accordion type="multiple" className="space-y-2">
                           {dateGroup.sessions.map(sessionGroup => (
                               <AccordionItem value={sessionGroup.sessionId} key={sessionGroup.sessionId}>
                                   <AccordionTrigger className="p-2 bg-muted/50 rounded-md">
                                        <h4 className="font-semibold">{sessionGroup.sessionLabel}</h4>
                                   </AccordionTrigger>
                                   <AccordionContent className="p-0 pt-2">
                                       <Table>
                                           <TableHeader>
                                               <TableRow><TableHead>Item</TableHead><TableHead>Status</TableHead><TableHead>Time Closed</TableHead><TableHead>Duration</TableHead></TableRow>
                                           </TableHeader>
                                           <TableBody>
                                               {sessionGroup.tickets.map(ticket => (
                                                   <TableRow key={ticket.id}>
                                                       <TableCell>{ticket.itemName}</TableCell>
                                                       <TableCell>
                                                            <Badge variant={ticket.status === 'served' ? 'default' : 'destructive'} className="capitalize">{ticket.status}</Badge>
                                                       </TableCell>
                                                       <TableCell>
                                                            {format(toJsDate(ticket.servedAtClientMs || ticket.cancelledAtClientMs || ticket.createdAtClientMs)!, 'HH:mm:ss')}
                                                       </TableCell>
                                                        <TableCell>{formatDuration(ticket.durationMs || 0)}</TableCell>
                                                   </TableRow>
                                               ))}
                                           </TableBody>
                                       </Table>
                                   </AccordionContent>
                               </AccordionItem>
                           ))}
                        </Accordion>
                    </CardContent>
                </Card>
            ))}
            {hasMore && (
                <div className="text-center py-4">
                    <Button onClick={() => fetchTickets(true)} disabled={isLoading}>
                        {isLoading ? <Loader2 className="animate-spin mr-2"/> : null}
                        Load More
                    </Button>
                </div>
            )}
        </div>
      )}
    </RoleGuard>
  )
}

export function HistoryPageClient() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>}>
            <HistoryPageContent />
        </Suspense>
    )
}


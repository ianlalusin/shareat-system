// src/components/cashier/LinkCardDialog.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ScanLine, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QrScanner } from "@/components/qr-wallet/QrScanner";
import { useAuthContext } from "@/context/auth-context";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { classifyCustomerQuery, maskPhone, parseCardQrPayload } from "@/lib/loyalty/session-link";

type Hit = { phone: string; name: string; pointsBalance: number };

export function LinkCardDialog({
  open,
  onOpenChange,
  storeId,
  sessionId,
  sessionLabel,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  sessionId: string;
  sessionLabel?: string;
  onLinked?: (r: { phone: string; name: string }) => void;
}) {
  const { user } = useAuthContext();
  const isOnline = useOnlineStatus();
  const { toast } = useToast();

  const [tab, setTab] = useState<"scan" | "search">("scan");
  const [scannerKey, setScannerKey] = useState(0);
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 300);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Hit[]>([]);
  const [candidate, setCandidate] = useState<Hit | null>(null);
  const [linking, setLinking] = useState(false);
  // Bumped on close / reset / tab change; a scan lookup that resolves after a bump is stale and dropped.
  const scanReqRef = useRef(0);

  const api = useCallback(
    async (url: string, init?: RequestInit) => {
      if (!user) throw new Error("Not signed in.");
      const token = await user.getIdToken();
      return fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
      });
    },
    [user],
  );

  const find = useCallback(
    async (q: string): Promise<Hit[]> => {
      const res = await api(`/api/loyalty/find-customer?storeId=${encodeURIComponent(storeId)}&q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Search failed.");
      return Array.isArray(data.results) ? data.results : [];
    },
    [api, storeId],
  );

  // Debounced typeahead for the Search tab.
  useEffect(() => {
    if (!open || tab !== "search" || !isOnline) {
      setSearching(false);
      return;
    }
    if (classifyCustomerQuery(debounced).kind === "incomplete") {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    find(debounced)
      .then((r) => { if (!cancelled) setResults(r); })
      .catch((e) => { if (!cancelled) toast({ variant: "destructive", title: "Search failed", description: e?.message }); })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [debounced, open, tab, isOnline, find, toast]);

  const handleScan = useCallback(
    async (payload: string) => {
      const phone = parseCardQrPayload(payload);
      if (!phone) {
        toast({ variant: "destructive", title: "Not a Sharelebrator card", description: "That QR is not a loyalty card. Try again or search instead." });
        setScannerKey((k) => k + 1); // remount scanner to resume scanning
        return;
      }
      const req = scanReqRef.current;
      try {
        const hits = await find(phone);
        if (req !== scanReqRef.current) return; // dialog closed/reset/tab changed while looking up
        if (hits.length === 0) {
          toast({ variant: "destructive", title: "No account found", description: "No Sharelebrator account for that number." });
          setScannerKey((k) => k + 1);
          return;
        }
        setCandidate(hits[0]);
      } catch (e: any) {
        if (req !== scanReqRef.current) return;
        toast({ variant: "destructive", title: "Lookup failed", description: e?.message });
        setScannerKey((k) => k + 1);
      }
    },
    [find, toast],
  );

  const confirmLink = async () => {
    if (!candidate) return;
    setLinking(true);
    try {
      const res = await api("/api/loyalty/link-session", {
        method: "POST",
        body: JSON.stringify({ storeId, sessionId, phone: candidate.phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ variant: "destructive", title: "Could not link card", description: data?.error || "Something went wrong." });
        if (res.status === 409 || res.status === 404) setCandidate(null);
        return;
      }
      toast({ title: "Card linked", description: `${data.name || candidate.name} will earn points on this bill.` });
      onLinked?.({ phone: data.phone, name: data.name });
      onOpenChange(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not link card", description: e?.message || "Network error." });
    } finally {
      setLinking(false);
    }
  };

  // Reset when closed so a reopened dialog never shows a stale candidate.
  useEffect(() => {
    if (!open) {
      scanReqRef.current += 1;
      setSearching(false);
      setCandidate(null);
      setQuery("");
      setResults([]);
      setTab("scan");
      setScannerKey((k) => k + 1);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!linking) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link Sharelebrator card</DialogTitle>
          <DialogDescription>
            {sessionLabel ? `${sessionLabel} — ` : ""}scan the customer&apos;s card QR or look them up.
          </DialogDescription>
        </DialogHeader>

        {!isOnline ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Linking needs an internet connection.</p>
        ) : candidate ? (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 text-center space-y-1">
              <p className="text-lg font-semibold">★ {candidate.name || "Customer"}</p>
              <p className="text-sm text-muted-foreground">{maskPhone(candidate.phone)}</p>
              <p className="text-sm">{candidate.pointsBalance.toLocaleString("en-US")} points</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { scanReqRef.current += 1; setCandidate(null); setScannerKey((k) => k + 1); }} disabled={linking}>
                Back
              </Button>
              <Button className="flex-1" onClick={confirmLink} disabled={linking}>
                {linking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Link to this bill
              </Button>
            </div>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(v) => { scanReqRef.current += 1; setTab(v as "scan" | "search"); }}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="scan"><ScanLine className="mr-2 h-4 w-4" /> Scan QR</TabsTrigger>
              <TabsTrigger value="search"><Search className="mr-2 h-4 w-4" /> Search</TabsTrigger>
            </TabsList>
            <TabsContent value="scan" className="pt-3">
              {open && tab === "scan" && (
                <QrScanner key={scannerKey} onResult={handleScan} onCancel={() => { scanReqRef.current += 1; setTab("search"); }} />
              )}
            </TabsContent>
            <TabsContent value="search" className="pt-3 space-y-3">
              <Input
                autoFocus
                placeholder="Phone number or name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Full phone number finds any customer. Names search this store&apos;s past customers only.
              </p>
              <div className="max-h-56 overflow-y-auto space-y-1">
                {searching && <p className="text-sm text-muted-foreground py-2 text-center"><Loader2 className="inline h-4 w-4 animate-spin" /></p>}
                {!searching && results.length === 0 && classifyCustomerQuery(query).kind !== "incomplete" && (
                  <p className="text-sm text-muted-foreground py-2 text-center">No matches.</p>
                )}
                {results.map((r) => (
                  <button
                    key={r.phone}
                    type="button"
                    onClick={() => setCandidate(r)}
                    className="w-full flex items-center justify-between rounded-md border px-3 py-2 text-left hover:bg-muted/50"
                  >
                    <span className="font-medium truncate">{r.name || "Customer"}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2">{maskPhone(r.phone)}</span>
                  </button>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

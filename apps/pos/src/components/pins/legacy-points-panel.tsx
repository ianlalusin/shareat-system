"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthContext } from "@/context/auth-context";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Search, ShieldAlert, Undo2, History } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

/** Mirrors the `Row` shape served by GET /api/loyalty/legacy. */
export type LegacyRow = {
  id: string;
  name: string;
  altNames: string[];
  legacyIds: string[];
  ledgerRows: number;
  firstVisitMs: number;
  lastVisitMs: number;
  legacyPoints: number;
  newPoints: number;
  emails: string[];
  warnings: string[];
  status: "parked" | "claimed";
  claimedAtMs?: number;
  claimedPhone?: string;
  claimedByUid?: string;
  claimedByName?: string;
  claimNote?: string;
  idVerified?: boolean;
};

type Summary = { parked: number; claimed: number; pointsRemaining: number; pointsClaimed: number };

const EMPTY_SUMMARY: Summary = { parked: 0, claimed: 0, pointsRemaining: 0, pointsClaimed: 0 };

const fmtDate = (ms?: number | null) => (ms ? format(new Date(ms), "MMM d, yyyy") : "—");

const Stat = ({ label, value }: { label: string; value: number }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="text-xl font-black">{value.toLocaleString()}</p>
  </div>
);

export function LegacyPointsPanel() {
  const { user, appUser } = useAuthContext();
  const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();
  const { toast } = useToast();

  const [rows, setRows] = useState<LegacyRow[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "parked" | "claimed">("parked");
  const [claimTarget, setClaimTarget] = useState<LegacyRow | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  // Admin-only: unclaiming rewrites a settled record, so managers can mark
  // claimed but only an admin can take it back.
  const canUndo = appUser?.role === "admin" || appUser?.isPlatformAdmin;

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/loyalty/legacy", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error || "Failed to load legacy customers.");
      setRows(Array.isArray(json.rows) ? json.rows : []);
      setSummary({ ...EMPTY_SUMMARY, ...(json.summary || {}) });
      setLoadError(null);
    } catch (err: any) {
      console.error("Failed to load legacy loyalty rows:", err);
      setLoadError(err?.message || "Failed to load legacy customers.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [r.name, ...(r.altNames || []), ...(r.legacyIds || []), r.claimedPhone || ""];
      return haystack.some((v) => String(v).toLowerCase().includes(q));
    });
  }, [rows, query, statusFilter]);

  async function handleUndo(row: LegacyRow) {
    if (!user) return;
    const ok = await confirm({
      title: "Undo this claim?",
      description: `${row.name} goes back to parked. Do this only if the claim was a mistake — points already transferred from the owner card are not reversed here.`,
      confirmText: "Undo claim",
      destructive: true,
    });
    if (!ok) return;
    setUndoingId(row.id);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/loyalty/legacy/unclaim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: row.id }),
      });
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error || "Undo failed.");
      toast({ title: "Claim undone", description: `${row.name} is parked again.` });
      await load();
    } catch (err: any) {
      toast({ title: "Undo failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setUndoingId(null);
    }
  }

  return (
    <Card>
      {ConfirmDialog}
      <CardHeader className="pb-3 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              Legacy points (old card)
            </CardTitle>
            <CardDescription>
              Customers from the old Google Sheet program. Verify name + government ID, mark claimed,
              then transfer the shown points from the SharEat owner card.
            </CardDescription>
          </div>
          <div className="flex items-center gap-4 text-right">
            <Stat label="Parked" value={summary.parked} />
            <Stat label="Claimed" value={summary.claimed} />
            <Stat label="Points to hand out" value={summary.pointsRemaining} />
            <Stat label="Points handed out" value={summary.pointsClaimed} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, old ID, or claimed phone..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="parked">Parked</SelectItem>
              <SelectItem value="claimed">Claimed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {loadError && <p className="text-[11px] leading-snug text-destructive">{loadError}</p>}
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 text-sm text-center text-muted-foreground">
            No legacy customers seeded yet.
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-8 text-sm text-center text-muted-foreground">
            No legacy customers match this search.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Name</TableHead>
                <TableHead className="text-xs">Last visit</TableHead>
                <TableHead className="text-xs text-right">Legacy pts</TableHead>
                <TableHead className="text-xs text-right">New pts</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm font-medium">
                    <span className="flex items-center gap-1.5">
                      {r.name || "—"}
                      {r.warnings?.length > 0 && (
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500">
                          <title>{r.warnings.join(" · ")}</title>
                        </ShieldAlert>
                      )}
                    </span>
                    {r.altNames?.length > 0 && (
                      <span className="block text-[11px] text-muted-foreground truncate max-w-[220px]">
                        also: {r.altNames.join(", ")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(r.lastVisitMs)}</TableCell>
                  <TableCell className="text-xs text-right font-mono">
                    {r.legacyPoints.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm text-right font-mono font-bold">
                    {r.newPoints.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={r.status === "claimed" ? "default" : "secondary"} className="text-[10px]">
                      {r.status === "claimed" ? "Claimed" : "Parked"}
                    </Badge>
                    {r.status === "claimed" && (
                      <span className="block text-[10px] text-muted-foreground mt-1">
                        {r.claimedByName || "staff"}
                        {r.claimedAtMs
                          ? ` · ${formatDistanceToNow(new Date(r.claimedAtMs), { addSuffix: true })}`
                          : ""}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === "parked" ? (
                      <Button size="sm" variant="outline" onClick={() => setClaimTarget(r)}>
                        Mark claimed
                      </Button>
                    ) : canUndo ? (
                      <Button size="sm" variant="ghost" disabled={undoingId === r.id} onClick={() => void handleUndo(r)}>
                        {undoingId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <><Undo2 className="h-3.5 w-3.5 mr-1" /> Undo</>
                        )}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {claimTarget && (
        <ClaimDialog
          row={claimTarget}
          onClose={() => setClaimTarget(null)}
          onClaimed={(transferPoints, customerName) => {
            setClaimTarget(null);
            toast({
              title: `Claimed — transfer ${transferPoints.toLocaleString()} points to ${customerName}`,
              description: "Hub > Transfer points, from the SharEat card.",
            });
            void load();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Claim flow for one parked row. Errors render inside the dialog rather than
 * only as a toast: the 404 ("no loyalty card at that phone yet") is an
 * instruction to sign the walk-in up first, and staff need it still on screen
 * with the phone they typed.
 */
function ClaimDialog({
  row,
  onClose,
  onClaimed,
}: {
  row: LegacyRow;
  onClose: () => void;
  onClaimed: (transferPoints: number, customerName: string) => void;
}) {
  const { user } = useAuthContext();
  const [phone, setPhone] = useState("");
  const [idVerified, setIdVerified] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = phone.trim().length > 0 && idVerified && !submitting;

  async function submit() {
    if (!user || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/loyalty/legacy/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          id: row.id,
          phone: phone.trim(),
          idVerified: true,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error || "Claim failed.");
      onClaimed(Number(json.transferPoints) || 0, json.customerName || row.name);
    } catch (err: any) {
      setError(err?.message || "Claim failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark claimed</DialogTitle>
          <DialogDescription>
            Points are not moved here. After claiming, transfer them from the SharEat owner card in
            the Hub.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Old card</p>
              <p className="text-sm font-semibold truncate">{row.name}</p>
              {row.altNames?.length > 0 && (
                <p className="text-[11px] text-muted-foreground truncate">also: {row.altNames.join(", ")}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">New pts</p>
              <p className="text-2xl font-black">{row.newPoints.toLocaleString()}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legacy-claim-phone">Customer phone</Label>
            <Input
              id="legacy-claim-phone"
              inputMode="tel"
              placeholder="09XXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              The phone on their new Sharelebrator account. They must be signed up first.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="legacy-claim-id"
              className="mt-0.5"
              checked={idVerified}
              onCheckedChange={(v) => setIdVerified(v === true)}
            />
            <Label htmlFor="legacy-claim-id" className="text-sm font-normal leading-snug">
              I checked a government ID matching this name
            </Label>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legacy-claim-note">Note (optional)</Label>
            <Textarea
              id="legacy-claim-note"
              className="min-h-[60px]"
              placeholder="e.g. ID type / seen by"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Confirm claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Printer } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { useOutboxStatus } from "@/hooks/useOutboxStatus";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { API_BASE, POS2_API_BASE } from "@/lib/api-base";
import { APP_VERSION } from "@/lib/appVersion";
import { formatCentavos } from "@/lib/money/format";
import { listEvents, retryStuck, type LedgerEvent } from "@/lib/outbox/ledger";
import { listFailedEffectItems, retryFailedEffectItem } from "@/lib/outbox/effects-store";
import type { QueuedPayment } from "@/lib/offline/payment-queue";
import { notifyOutboxChanged } from "@/lib/outbox/outboxStatus";
import { canShowUpdateLink, checkForUpdate, unsentSalesWarningText } from "@/lib/outbox/updateGate";
import { buildXSlipText, printXSlipText } from "@/lib/outbox/xSlipRun";
import { loadOfflinePeriod } from "@/lib/outbox/offlinePeriod";

const APK_URL = process.env.NEXT_PUBLIC_POS_APK_URL || "";

const when = (ms: number) => new Date(ms).toLocaleString();

function Row({ ev, action }: { ev: LedgerEvent; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b py-2 text-sm last:border-b-0">
      <div className="min-w-0">
        <div className="font-medium">{ev.kind === "void" ? "Void" : ev.kind === "refund" ? "Refund" : "Sale"} {ev.receiptNumber}{ev.kind === "sale" ? `  ₱${formatCentavos(ev.totalCentavos)}` : ""}</div>
        <div className="text-xs text-muted-foreground">{when(ev.createdAtClientMs)} · session {ev.receiptId.slice(0, 8)}</div>
        {ev.lastError && <div className="text-xs text-destructive">{ev.lastError}</div>}
      </div>
      {action}
    </div>
  );
}

/**
 * T-425 Settings section: the unsent-sales warning and update gate (Ruling 8), the on-demand X-slip (Ruling 7), and the manager lists
 * (quarantined / rejected / stuck sales, failed effects, "Review after outage").
 */
export function OutboxSection() {
  const { toast } = useToast();
  const { appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const online = useOnlineStatus();
  const status = useOutboxStatus();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [failed, setFailed] = useState<QueuedPayment[]>([]);
  const [latest, setLatest] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  const isManager = appUser?.role === "manager" || appUser?.role === "admin" || appUser?.isPlatformAdmin === true;

  const reload = useCallback(async () => {
    try {
      setEvents(await listEvents());
      setFailed(await listFailedEffectItems());
    } catch (e) {
      console.warn("[outbox] could not read the lists", e);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload, status]);

  const check = async () => {
    setBusy(true);
    const r = await checkForUpdate({ fetch: (...a) => fetch(...a), apiBase: API_BASE ? POS2_API_BASE : "", currentVersion: APP_VERSION });
    setBusy(false);
    setChecked(true);
    setLatest(r.latestVersion);
    if (!r.reachable) toast({ variant: "destructive", title: "Cannot check", description: "The POS server cannot be reached right now." });
  };

  const printX = async () => {
    if (!activeStore) return;
    setBusy(true);
    try {
      const now = Date.now();
      const period = await loadOfflinePeriod();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const { text, widthMm } = await buildXSlipText({ storeId: activeStore.id, storeName: activeStore.name, periodStartMs: period.periodStartMs ?? start.getTime(), periodEndMs: now });
      const outcome = await printXSlipText(text, widthMm);
      if (outcome === "printed") toast({ title: "X-slip printed" });
      else {
        toast({ variant: outcome === "failed" ? "destructive" : "default", title: outcome === "failed" ? "Print failed" : "No printer paired", description: "Copy the slip from the screen." });
        window.alert(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const by = (...s: LedgerEvent["status"][]) => events.filter((e) => s.includes(e.status));
  const refundConflicts = events.filter((e) => e.kind === "refund" && e.status === "reserved" && e.lastError);
  const review = events.filter((e) => e.status !== "skipped" && (e.kind === "void" || e.tenders.some((t) => t.toCheck))).slice(-50);
  const showLink = canShowUpdateLink({ unsentCount: status.unsentCount, currentVersion: APP_VERSION, latestVersion: latest });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Inbox className="h-5 w-5" /> Unsent sales</CardTitle>
        <CardDescription>Sales made without the internet stay on this tablet until the server has them. Do not remove them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`rounded-md border p-3 text-sm ${status.unsentCount > 0 ? "border-amber-500 bg-amber-50 text-amber-900" : ""}`}>
          {unsentSalesWarningText(status.unsentCount)}
          {status.unsentCount > 0 && <div className="mt-1 text-xs">Unsent total: ₱{formatCentavos(status.unsentTotalCentavos)}</div>}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={check} disabled={busy || !online}>Check for update</Button>
            <Button variant="outline" size="sm" onClick={printX} disabled={busy || !activeStore}><Printer className="mr-1 h-4 w-4" /> Print X-slip</Button>
          </div>
          {checked && latest === null && <p className="text-xs text-muted-foreground">No version information available.</p>}
          {checked && latest !== null && latest === APP_VERSION && <p className="text-xs text-muted-foreground">This tablet has the latest version ({APP_VERSION}).</p>}
          {checked && latest !== null && latest !== APP_VERSION && !showLink && (
            <p className="text-xs text-amber-700">Version {latest} is available, but {status.unsentCount} sale(s) are still unsent. Update after this is 0.</p>
          )}
          {showLink && (APK_URL
            ? <a className="text-sm underline" href={APK_URL}>Download version {latest}</a>
            : <p className="text-sm">Version {latest} is available. Ask the manager to install it.</p>)}
        </div>

        {isManager && (
          <div className="space-y-3 border-t pt-3">
            <ListBlock title="Quarantined (the server has something different)" badge={by("quarantined").length}>
              {by("quarantined").map((e) => <Row key={`${e.deviceId}-${e.terminalSeq}`} ev={e} />)}
            </ListBlock>
            <ListBlock title="Rejected (the server refused them)" badge={by("rejected").length}>
              {by("rejected").map((e) => <Row key={`${e.deviceId}-${e.terminalSeq}`} ev={e} />)}
            </ListBlock>
            <ListBlock title="Stuck (10 tries failed)" badge={by("stuck").length}>
              {by("stuck").map((e) => (
                <Row key={`${e.deviceId}-${e.terminalSeq}`} ev={e}
                  action={<Button size="sm" variant="outline" onClick={async () => { await retryStuck(e.deviceId, e.terminalSeq); notifyOutboxChanged(); await reload(); }}>Retry</Button>} />
              ))}
            </ListBlock>
            <ListBlock title="Refund number conflict — ask the manager" badge={refundConflicts.length}>
              {refundConflicts.map((e) => <Row key={`${e.deviceId}-${e.terminalSeq}`} ev={e} />)}
            </ListBlock>
            <ListBlock title="Follow-ups that failed (analytics, loyalty, PIN)" badge={failed.length}>
              {failed.map((f) => (
                <div key={f.id} className="flex items-start justify-between gap-2 border-b py-2 text-sm last:border-b-0">
                  <div className="min-w-0">
                    <div className="font-medium">Session {f.sessionId.slice(0, 8)}</div>
                    {f.errorMessage && <div className="text-xs text-destructive">{f.errorMessage}</div>}
                  </div>
                  <Button size="sm" variant="outline" onClick={async () => { await retryFailedEffectItem(f.id); notifyOutboxChanged(); await reload(); }}>Retry</Button>
                </div>
              ))}
            </ListBlock>
            <ListBlock title="Review after outage (offline voids and e-wallet sales to check)" badge={review.length}>
              {review.map((e) => (
                <div key={`${e.deviceId}-${e.terminalSeq}`} className="border-b py-2 text-sm last:border-b-0">
                  <Row ev={e} />
                  {e.tenders.filter((t) => t.toCheck).map((t, i) => (
                    <div key={i} className="text-xs text-muted-foreground">TO CHECK: {t.method} ₱{formatCentavos(t.centavos)} · ref {t.reference ?? "-"}</div>
                  ))}
                </div>
              ))}
            </ListBlock>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ListBlock({ title, badge, children }: { title: string; badge: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-medium">{title} <Badge variant={badge > 0 ? "destructive" : "secondary"}>{badge}</Badge></div>
      {badge > 0 && <div className="mt-1 rounded-md border px-3">{children}</div>}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import { useStoreContext } from '@/context/store-context';
import { Loader2, Printer, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePinPrint } from '@/hooks/use-print';
import { getReceiptSettingsCacheFirst } from '@/lib/receipts/receipt-settings';
import { QRCodeSVG } from 'qrcode.react';
import { sessionTableLabel } from '@/lib/sessionLabel';

export default function PrintPinPage() {
  // Query-param route (static-export / APK friendly): /print/session-pin?sessionId=<id>.
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get("sessionId") ?? undefined;
  const { activeStore } = useStoreContext();

  const [pin, setPin] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [tableLabel, setTableLabel] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [joinUrlStatus, setJoinUrlStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  // Paper width for the slip — the single source of truth the print follows. Defaults to
  // 80mm (store/app default), gets refined to the store's actual configured width by the
  // effect below, and is overridable via the on-screen selector.
  const [paperSize, setPaperSize] = useState<"58mm" | "80mm">(() => {
    try {
      const stored = localStorage.getItem("receiptPaperWidth:global");
      if (stored === "58mm" || stored === "80mm") return stored;
    } catch {}
    return "80mm";
  });
  const paperSeededRef = useRef(false);

  const { printPin, isPrintingPin } = usePinPrint({ pin, customerName, tableLabel, storeName: activeStore?.name, storeId: activeStore?.id, joinUrl, paperSize });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeStore?.id || !sessionId) {
      setIsLoading(false);
      if (!activeStore?.id) setError("Store not selected.");
      if (!sessionId) setError("Session ID is missing.");
      return;
    }

    const sessionRef = doc(db, 'stores', activeStore.id, 'activeSessions', sessionId);
    const unsubscribe = onSnapshot(
      sessionRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data() as any;
          setPin(data.customerPin || null);
          setCustomerName(data.customerName || data.customer?.name || null);
          setTableLabel(
            sessionTableLabel({
              sessionMode: data.sessionMode,
              tableDisplayName: data.tableDisplayName,
              tableNumber: data.tableNumber,
            }),
          );
          setError(null);
        } else {
          setError("Active session not found. It may have been closed.");
          setPin(null);
          setCustomerName(null);
          setTableLabel(null);
        }
        setIsLoading(false);
      },
      (err) => {
        console.error("Error fetching session for PIN print:", err);
        setError("Failed to load session data.");
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [activeStore?.id, sessionId]);

  // Auto-print exactly once per page load: a ref guard makes this idempotent
  // even though `printPin`'s identity can change as `isPrintingPin` toggles.
  const hasAutoPrintedRef = useRef(false);
  useEffect(() => {
    // Print once the join URL has settled — either it's ready, or it failed/timed out
    // and we proceed with the fallback QR. Never block the auto-print indefinitely.
    const joinUrlSettled = joinUrlStatus === "ready" || joinUrlStatus === "error";
    if (pin && !isLoading && !error && joinUrlSettled && !hasAutoPrintedRef.current) {
      hasAutoPrintedRef.current = true;
      const timer = setTimeout(() => printPin(), 500);
      return () => clearTimeout(timer);
    }
  }, [pin, isLoading, error, joinUrlStatus, printPin]);

  useEffect(() => {
    if (!pin || !activeStore?.id || !sessionId) return;
    // Bound the join-URL fetch: the App Hosting backend can cold-start for 30-60s,
    // and we must never block the print that long. After 6s we give up and print
    // with the generic fallback QR (manual-PIN join) — the slip still works.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    async function fetchJoinUrl() {
      setJoinUrlStatus("loading");
      try {
        const { getAuth } = await import("firebase/auth");
        const user = getAuth().currentUser;
        if (!user) {
          setJoinUrlStatus("error");
          return;
        }
        const idToken = await user.getIdToken();
        const res = await fetch(
          `/api/pins/join-url?storeId=${activeStore!.id}&sessionId=${sessionId}`,
          { headers: { Authorization: `Bearer ${idToken}` }, signal: controller.signal }
        );
        const json = await res.json();
        if (json.ok && json.joinUrl) {
          setJoinUrl(json.joinUrl);
          setJoinUrlStatus("ready");
          return;
        }
      } catch {}
      setJoinUrlStatus("error");
    }
    fetchJoinUrl();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [pin, activeStore?.id, sessionId]);

  // Seed the paper selector from the store's configured receipt width the first time the
  // store loads (cache-first, instant), so the auto-print starts on the RIGHT paper (e.g.
  // 80mm) instead of a stale default. Runs once per store; a manual selector change after
  // that wins and is persisted below.
  useEffect(() => {
    if (paperSeededRef.current || !activeStore?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getReceiptSettingsCacheFirst(db, activeStore.id);
        if (!cancelled) {
          paperSeededRef.current = true;
          setPaperSize(s.paperWidth === "58mm" ? "58mm" : "80mm");
        }
      } catch {
        // Keep the current default if settings can't be read.
      }
    })();
    return () => { cancelled = true; };
  }, [activeStore?.id]);

  useEffect(() => {
    try { localStorage.setItem("receiptPaperWidth:global", paperSize); } catch {}
  }, [paperSize]);



  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-48">
          <Loader2 className="h-12 w-12 mx-auto my-4 animate-spin" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="my-4 text-destructive flex flex-col items-center gap-2 p-4">
          <WifiOff className="h-10 w-10" />
          <span>{error}</span>
        </div>
      );
    }

    if (!pin) {
      return (
        <div className="my-4 text-muted-foreground p-4 text-center">
          <p>No PIN issued for this session.</p>
        </div>
      );
    }

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

    return (
      <div
        className={`receipt-view ${paperSize === "80mm" ? "receipt-80" : "receipt-58"} bg-white text-black p-2 text-center`}
        style={{ fontFamily: mono }}
      >
        <p className="text-xs leading-snug">
          Welcome {customerName || 'Valued Customer'},
        </p>

        {tableLabel && <p className="text-xs leading-snug font-bold">{tableLabel}</p>}

        <p className="text-xs leading-snug mt-2">
          Scan the QR code or go to
          <br />
          <b>CUSTOMER.SHAREAT.NET</b>
          <br />
          and enter this PIN to access
          <br />
          our smart refilling system.
        </p>

        <div className="my-3 flex flex-col items-center gap-2">
          <QRCodeSVG value={joinUrl || "https://customer.shareat.net"} size={paperSize === "80mm" ? 160 : 140} />
        </div>

        <div className="my-2">
          <div className="text-2xl font-bold tracking-wider font-mono bg-zinc-100 px-3 py-2 rounded-lg inline-block min-w-[140px]">
            {pin}
          </div>
        </div>

        <p className="text-[10px] mt-2 font-bold">
          - {activeStore?.name || 'The SharEat Team'}
        </p>
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900 print:bg-white">
      <div id="receipt-print-root" data-paper={paperSize}>
        <div id="print-receipt-area">{renderContent()}</div>
      </div>

      <div className="mt-6 flex items-center gap-4 no-print">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Paper:</span>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={paperSize}
            onChange={(e) => setPaperSize(e.target.value as any)}
          >
            <option value="58mm">58mm</option>
            <option value="80mm">80mm</option>
          </select>
        </div>

        <Button variant="outline" onClick={() => window.history.back()}>
          Back
        </Button>

        <Button onClick={printPin} disabled={isLoading || !pin || isPrintingPin || joinUrlStatus === "loading"}>
          <Printer className="mr-2" /> Print
        </Button>
      </div>
    </div>
  );
}

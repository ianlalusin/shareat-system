"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Check, Copy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useAuthContext } from "@/context/auth-context";
import { useStoreContext } from "@/context/store-context";
import { getBrowserDeviceId } from "@/lib/offline/browserDevice";
import { formatTerminalReceiptNumber, readTerminal, type TerminalRecord } from "@/lib/terminal/counter";
import { checkTerminalHolder, claimTerminal, releaseTerminal } from "@/lib/terminal/claim";
import { getFirestorePort } from "@/lib/terminal/port";

/**
 * T-423 S2 (Ruling 6): choose this tablet's terminal number. Every receipt from this tablet is numbered
 * `<STORECODE>-<TT>-<NNNNNN>` from one series that never restarts. A manager can release a terminal held by
 * another tablet (for example a lost or replaced one).
 */
export function TerminalSection() {
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const { appUser } = useAuthContext();
  const { activeStore } = useStoreContext();
  const [record, setRecord] = useState<TerminalRecord | null>(null);
  const [holder, setHolder] = useState<"mine" | "other" | "unclaimed" | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [busy, setBusy] = useState(false);
  // T-424 S5: the device id the person registering this tablet for manager approvals copies into ERP (the provision-terminal script).
  const [deviceId, setDeviceId] = useState("");
  useEffect(() => {
    try {
      setDeviceId(getBrowserDeviceId());
    } catch {
      setDeviceId("");
    }
  }, []);
  const copyDeviceId = async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      toast({ title: "Copied", description: "The device id is on the clipboard." });
    } catch {
      toast({ variant: "destructive", title: "Could not copy", description: "Select the device id and copy it by hand." });
    }
  };

  const isManager = appUser?.role === "manager" || appUser?.isPlatformAdmin === true;

  const refresh = useCallback(async () => {
    try {
      const rec = await readTerminal();
      setRecord(rec);
      if (rec && isOnline) {
        setHolder(await checkTerminalHolder(getFirestorePort(), { storeId: rec.storeId, terminalNo: rec.terminalNo, deviceId: rec.deviceId }));
      } else {
        setHolder(null);
      }
    } catch (e) {
      console.warn("[Terminal] could not read this tablet's terminal record", e);
    }
  }, [isOnline]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const parseTerminalNo = (): number | null => {
    const n = Number(terminalInput.trim());
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      toast({ variant: "destructive", title: "Terminal number", description: "Enter a whole number from 1 to 99." });
      return null;
    }
    return n;
  };

  const handleClaim = async () => {
    const terminalNo = parseTerminalNo();
    if (terminalNo === null || !activeStore || !appUser) return;
    setBusy(true);
    try {
      const res = await claimTerminal(getFirestorePort(), {
        storeId: activeStore.id,
        storeCode: activeStore.code,
        terminalNo,
        deviceId: getBrowserDeviceId(),
        uid: appUser.uid,
      });
      toast({ title: "Terminal set up", description: `This tablet is terminal ${String(res.terminalNo).padStart(2, "0")}.` });
      await refresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Could not set up the terminal", description: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Release asks first, in a toast that stays up for 15 s. That question belongs to ONE store and ONE signed-in person on THIS
  // screen: it is dismissed when either changes or the section unmounts, and the action re-checks before it calls release.
  const live = useRef({ storeId: activeStore?.id ?? null, uid: appUser?.uid ?? null });
  live.current = { storeId: activeStore?.id ?? null, uid: appUser?.uid ?? null };
  const mounted = useRef(true);
  const question = useRef<{ dismiss: () => void } | null>(null);
  // Synchronous, so a double click (two events before React re-renders `busy`) sends one release, not two.
  const releasing = useRef(false);
  const closeQuestion = () => {
    question.current?.dismiss();
    question.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      closeQuestion();
    };
  }, []);
  useEffect(() => closeQuestion, [activeStore?.id, appUser?.uid]);

  const handleRelease = () => {
    const terminalNo = parseTerminalNo();
    if (terminalNo === null || !activeStore || !appUser) return;
    const label = String(terminalNo).padStart(2, "0");
    const { id: storeId, name: storeName } = activeStore;
    const uid = appUser.uid;
    const what = `terminal ${label} at ${storeName}`;

    const release = async () => {
      if (releasing.current) return;
      if (!mounted.current || live.current.storeId !== storeId || live.current.uid !== uid) {
        closeQuestion();
        toast({ variant: "destructive", title: "Release cancelled", description: "The store or the signed-in person changed. Ask again." });
        return;
      }
      releasing.current = true;
      // Nothing is left to click while the release runs.
      shown.update({ id: shown.id, action: <ToastAction altText={`Release ${what}`} disabled>Release</ToastAction> });
      closeQuestion();
      setBusy(true);
      try {
        await releaseTerminal(getFirestorePort(), { storeId, terminalNo, uid });
        toast({ title: "Terminal released", description: `Terminal ${label} at ${storeName} can be set up on another tablet.` });
        if (mounted.current) await refresh();
      } catch (e: any) {
        toast({ variant: "destructive", title: "Could not release the terminal", description: e?.message ?? String(e) });
      } finally {
        releasing.current = false;
        if (mounted.current) setBusy(false);
      }
    };

    // T-568: a browser confirm() blocks the tablet and cannot be styled. The confirmation is a
    // toast with one explicit action; closing it leaves the terminal exactly as it was.
    closeQuestion();
    const shown = toast({
      variant: "destructive",
      title: `Release ${what}?`,
      description: "The tablet using it will stop taking payment until it is set up again.",
      duration: 15000,
      action: (
        <ToastAction altText={`Release ${what}`} onClick={() => { void release(); }}>
          Release
        </ToastAction>
      ),
    });
    question.current = { dismiss: shown.dismiss };
  };

  let nextNumber: string | null = null;
  if (record && activeStore) {
    try {
      nextNumber = formatTerminalReceiptNumber(activeStore.code, record.terminalNo, record.nextSeq);
    } catch {
      nextNumber = null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hash className="h-5 w-5" /> Terminal
        </CardTitle>
        <CardDescription>
          Every receipt from this tablet is numbered from its own terminal series. Set it up once, with an internet connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {record ? (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Check className="h-4 w-4 text-green-500" />
              This tablet: <Badge variant="secondary">Terminal {String(record.terminalNo).padStart(2, "0")}</Badge>
              {holder === "other" && <Badge variant="destructive">Now used by another tablet</Badge>}
              {holder === "unclaimed" && <Badge variant="destructive">Released: set up again</Badge>}
            </div>
            {nextNumber && <div className="text-muted-foreground">Next receipt number: {nextNumber}</div>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This tablet has no terminal number yet. Payment is off until you set one.</p>
        )}
        <div className="flex gap-2">
          <Input
            inputMode="numeric"
            placeholder="Terminal number (1 to 99)"
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            disabled={busy}
          />
          <Button onClick={handleClaim} disabled={busy || !isOnline || !activeStore || !terminalInput.trim()}>
            Set up this tablet
          </Button>
        </div>
        {isManager && (
          <Button variant="outline" onClick={handleRelease} disabled={busy || !isOnline || !activeStore || !terminalInput.trim()}>
            Release this terminal number
          </Button>
        )}
        {!isOnline && <p className="text-xs text-muted-foreground">Connect to the internet to set up or release a terminal.</p>}
        <div className="space-y-1 border-t pt-3 text-sm">
          <div className="text-muted-foreground">This tablet&apos;s device id (an administrator registers it in ERP so managers can approve refunds here)</div>
          <div className="flex items-center gap-2">
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{deviceId || "not available"}</code>
            <Button type="button" variant="outline" size="sm" onClick={copyDeviceId} disabled={!deviceId}>
              <Copy className="mr-1 h-4 w-4" /> Copy
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

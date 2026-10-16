"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthContext } from "@/context/auth-context";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, KeyRound, Copy, Printer, Sparkles, Users, Coins, ScrollText, KeyRound as KeyIcon, UserPlus, Coins as CoinIcon, MapPin, LogIn, ShieldAlert } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { isNativeBluetoothAvailable, getLastPrinterAddress, printViaNativeBluetooth } from "@/lib/printing/printHub";
import { formatSharelebratorPasswordText } from "@/lib/printing/receiptFormatter";
import { LegacyPointsPanel } from "@/components/pins/legacy-points-panel";

type LedgerEntry = {
  id: string;
  type: "earn" | "redeem" | "adjust";
  points: number;
  amount: number;
  storeId: string;
  storeName?: string;
  sessionId: string;
  createdAtMs: number | null;
};

type StoreVisit = { visits: number; pointsEarned: number; lastVisitAtMs: number; storeName?: string };

type Customer = {
  phone: string;
  name: string;
  visitCount?: number;
  storeVisits?: Record<string, StoreVisit>;
  address: string;
  email: string | null;
  bday: string;
  pointsBalance: number;
  createdAtMs: number | null;
  passwordResetAtMs: number | null;
};

/** Strip a PH number to its local subscriber digits so +63917…, 0917… and 917… all compare equal. */
function toLocalDigits(value: string): string {
  return value.replace(/\D/g, "").replace(/^63/, "").replace(/^0/, "");
}

/**
 * "2 hours" / "90 minutes" — the presence window comes from the server
 * (PRESENCE_WINDOW_MS) so this copy cannot drift from the rule it describes.
 */
function formatWindow(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function CustomersAdmin({ storeId }: { storeId?: string }) {
  const { user, appUser } = useAuthContext();
  const { confirm, Dialog } = useConfirmDialog();
  const { toast } = useToast();

  const [phoneInput, setPhoneInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [notFound, setNotFound] = useState(false);
  /**
   * Set when the account exists but nothing puts it inside this store's
   * presence window. Carries the window and this store's own last-visit stamp
   * so the card can name the real blocker — recency — instead of implying the
   * record lives at another branch. It does not: `customers` is global.
   */
  const [outOfScope, setOutOfScope] = useState<{
    storeName: string;
    lastVisitHereMs: number | null;
  } | null>(null);
  /** Presence window in minutes, served alongside the scoped payload. */
  const [windowMinutes, setWindowMinutes] = useState(120);
  const [scope, setScope] = useState<"store" | "global">("store");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  // Accounts in scope. `presence` is null in global (admin) scope.
  const [allAccounts, setAllAccounts] = useState<
    {
      phone: string;
      name: string;
      pointsBalance: number;
      createdAtMs: number | null;
      presence?: "active" | "recent" | null;
      lastActiveAtMs?: number | null;
      reason?: string | null;
    }[]
  >([]);
  const [accountsLoading, setAccountsLoading] = useState(true);

  // Audit logs, scoped to this store unless the caller is an admin.
  const [logs, setLogs] = useState<
    Array<{
      id: string;
      type: "account_created" | "points_earned" | "password_reset" | "login" | "login_failed";
      phone: string;
      customerName: string;
      actorUid: string;
      storeId?: string;
      storeName?: string;
      points?: number;
      amount?: number;
      createdAtMs: number | null;
    }>
  >([]);
  const [logsLoading, setLogsLoading] = useState(true);

  // Aggregates arrive with the scoped payload above: all-branch totals for
  // admins, this store's in-scope customers for everyone else.
  const [stats, setStats] = useState<{
    label: string;
    totalAccounts: number;
    totalPointsOutstanding: number;
  } | null>(null);

  // One scoped load replaces the old direct subscriptions to `customers` and
  // `loyaltyLogs`. Those showed every branch's customers to every branch, and
  // both collections are admin-only in firestore.rules now. The server returns
  // data already scoped: global for admins, this store's presence window for
  // everyone else. Polled rather than live because the scope is computed from
  // a time window, which is not expressible as a Firestore listener.
  const loadScoped = useCallback(async () => {
    if (!user) return;
    try {
      const token = await user.getIdToken();
      const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
      const res = await fetch(`/api/loyalty/store-customers${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load customers.");
      setScope(json.scope === "global" ? "global" : "store");
      if (Number(json.windowMinutes) > 0) setWindowMinutes(Number(json.windowMinutes));
      setAllAccounts(json.customers || []);
      setLogs(json.logs || []);
      setStats(json.stats || null);
      setLoadError(null);
    } catch (err: any) {
      console.error("Failed to load scoped customers:", err);
      setLoadError(err?.message || "Failed to load customers.");
    } finally {
      setAccountsLoading(false);
      setLogsLoading(false);
    }
  }, [user, storeId]);

  useEffect(() => {
    if (!user) return;
    void loadScoped();
    const timer = setInterval(() => void loadScoped(), 30_000);
    return () => clearInterval(timer);
  }, [user, loadScoped]);


  // Fallback to summing the loaded rows if the payload carried no stats block,
  // so the header numbers stay useful rather than rendering zero.
  const totalPointsOutstanding = useMemo(
    () =>
      stats?.totalPointsOutstanding ??
      allAccounts.reduce((sum, a) => sum + (a.pointsBalance || 0), 0),
    [stats, allAccounts]
  );
  const totalAccounts = stats?.totalAccounts ?? allAccounts.length;

  // In store scope the list is only the customers inside the presence window,
  // so showing it unfiltered IS the useful view — the manager sees who is in
  // the restaurant. Global scope can be 500 rows, so it keeps the search gate.
  const accountQuery = phoneInput.trim().toLowerCase();
  const filteredAccounts = useMemo(() => {
    if (!accountQuery) return scope === "store" ? allAccounts : [];
    // Phones are stored canonically as +63XXXXXXXXXX (normalizePhone), but
    // staff type 0917..., 917... or +63917... A plain substring match on the
    // stored form only ever matched the last of those, so strip both sides to
    // the local subscriber digits before comparing.
    const queryDigits = toLocalDigits(accountQuery);
    return allAccounts.filter((a) => {
      if (a.name.toLowerCase().includes(accountQuery)) return true;
      return queryDigits.length > 0 && toLocalDigits(a.phone).includes(queryDigits);
    });
  }, [allAccounts, accountQuery, scope]);

  // Pagination state
  const ACCOUNTS_PAGE_SIZE = 10;
  const TRANSACTIONS_PAGE_SIZE = 10;
  const LOGS_PAGE_SIZE = 10;
  const [accountsPage, setAccountsPage] = useState(0);
  const [txnsPage, setTxnsPage] = useState(0);
  const [logsPage, setLogsPage] = useState(0);

  // Reset to first page when data or filter changes
  useEffect(() => {
    setAccountsPage(0);
  }, [accountQuery]);
  useEffect(() => {
    setTxnsPage(0);
  }, [customer?.phone]);
  // Clamp pages if total shrinks underneath the user
  useEffect(() => {
    setLogsPage((p) => Math.min(p, Math.max(0, Math.ceil(logs.length / LOGS_PAGE_SIZE) - 1)));
  }, [logs.length]);
  useEffect(() => {
    setAccountsPage((p) => Math.min(p, Math.max(0, Math.ceil(filteredAccounts.length / ACCOUNTS_PAGE_SIZE) - 1)));
  }, [filteredAccounts.length]);
  useEffect(() => {
    setTxnsPage((p) => Math.min(p, Math.max(0, Math.ceil(ledger.length / TRANSACTIONS_PAGE_SIZE) - 1)));
  }, [ledger.length]);

  const accountsTotalPages = Math.max(1, Math.ceil(filteredAccounts.length / ACCOUNTS_PAGE_SIZE));
  const txnsTotalPages = Math.max(1, Math.ceil(ledger.length / TRANSACTIONS_PAGE_SIZE));
  const logsTotalPages = Math.max(1, Math.ceil(logs.length / LOGS_PAGE_SIZE));

  const accountsPageRows = useMemo(
    () => filteredAccounts.slice(accountsPage * ACCOUNTS_PAGE_SIZE, (accountsPage + 1) * ACCOUNTS_PAGE_SIZE),
    [filteredAccounts, accountsPage]
  );
  const txnsPageRows = useMemo(
    () => ledger.slice(txnsPage * TRANSACTIONS_PAGE_SIZE, (txnsPage + 1) * TRANSACTIONS_PAGE_SIZE),
    [ledger, txnsPage]
  );
  const logsPageRows = useMemo(
    () => logs.slice(logsPage * LOGS_PAGE_SIZE, (logsPage + 1) * LOGS_PAGE_SIZE),
    [logs, logsPage]
  );

  const canReset =
    appUser?.role === "admin" || appUser?.role === "manager" || appUser?.isPlatformAdmin;

  const windowLabel = formatWindow(windowMinutes);

  function handlePickAccount(phone: string) {
    setPhoneInput(phone);
    // Pass phone directly so we don't race the React state update.
    searchByPhone(phone);
  }

  async function searchByPhone(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !user) return;
    setLoading(true);
    setNotFound(false);
    setOutOfScope(null);
    setCustomer(null);
    setLedger([]);
    setTempPassword(null);
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams({ phone: trimmed });
      if (storeId) params.set("storeId", storeId);
      const res = await fetch(`/api/loyalty/lookup?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Lookup failed.");
      if (!json.found) {
        setNotFound(true);
        // The account exists, it is just outside this store's presence window.
        // Say that rather than "not found", which reads as a typo and leaves
        // the cashier retyping while the customer waits.
        if (json.outOfScope === true) {
          if (Number(json.windowMinutes) > 0) setWindowMinutes(Number(json.windowMinutes));
          setOutOfScope({
            storeName: json.storeName || "this store",
            lastVisitHereMs: Number(json.lastVisitHereMs) || null,
          });
        } else {
          setOutOfScope(null);
        }
      } else {
        setCustomer(json.customer);
        setLedger(json.ledger || []);
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch() {
    return searchByPhone(phoneInput);
  }

  async function handleResetPassword() {
    if (!customer || !user) return;
    const ok = await confirm({
      title: "Reset password?",
      description: `A new temporary password will be generated for ${customer.name}. The old password will no longer work.`,
      confirmText: "Reset",
      destructive: true,
    });
    if (!ok) return;

    setResetting(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/loyalty/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone: customer.phone, storeId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Reset failed.");
      setTempPassword(json.newPassword);
      toast({ title: "Password reset", description: "Share the new password with the customer." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setResetting(false);
    }
  }

  function copyPassword() {
    if (!tempPassword) return;
    navigator.clipboard.writeText(tempPassword);
    toast({ title: "Copied", description: "Temporary password copied to clipboard." });
  }

  async function printPassword() {
    if (!tempPassword || !customer) return;

    // Native Android (Capacitor) → Bluetooth thermal printer
    if (isNativeBluetoothAvailable()) {
      const addr = getLastPrinterAddress();
      if (!addr) {
        toast({
          title: "No printer",
          description: "Connect a printer in Settings first.",
          variant: "destructive",
        });
        return;
      }
      try {
        const paperWidth = ((): 58 | 80 => {
          try {
            return localStorage.getItem("receiptPaperWidth:global") === "58mm" ? 58 : 80;
          } catch {
            return 80;
          }
        })();
        const text = formatSharelebratorPasswordText({
          name: customer.name,
          phone: customer.phone,
          tempPassword,
          resetAtMs: Date.now(),
          width: paperWidth,
        });
        await printViaNativeBluetooth({
          target: "pin",
          text,
          widthMm: paperWidth,
          cut: true,
          beep: true,
          encoding: "CP437",
        });
        toast({ title: "Printed", description: "Slip sent to thermal printer." });
      } catch (err: any) {
        toast({ title: "Print failed", description: err.message || "Unknown error", variant: "destructive" });
      }
      return;
    }

    // Web fallback → browser print via pop-up window
    const resetDate = format(new Date(), "MMM d, yyyy h:mm a");
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Sharelebrator Password Reset</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; max-width: 380px; margin: 0 auto; color: #1a1a1a; }
    .brand { text-align: center; font-weight: 900; font-size: 20px; letter-spacing: 2px; margin-bottom: 4px; }
    .tagline { text-align: center; font-size: 11px; color: #666; margin-bottom: 24px; letter-spacing: 3px; text-transform: uppercase; }
    .section { margin-bottom: 16px; }
    .label { font-size: 10px; text-transform: uppercase; color: #666; letter-spacing: 1px; margin-bottom: 2px; }
    .value { font-size: 15px; font-weight: 600; }
    .pw-box { border: 2px dashed #000; padding: 16px; text-align: center; margin: 20px 0; border-radius: 8px; }
    .pw-label { font-size: 10px; text-transform: uppercase; color: #666; letter-spacing: 1px; margin-bottom: 8px; }
    .pw-value { font-family: 'Courier New', monospace; font-size: 28px; font-weight: 900; letter-spacing: 4px; }
    .footer { font-size: 10px; color: #666; text-align: center; margin-top: 24px; line-height: 1.5; border-top: 1px solid #ddd; padding-top: 12px; }
    .date { font-size: 10px; color: #999; text-align: center; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="brand">★ SHARELEBRATOR ★</div>
  <div class="tagline">Password Reset</div>
  <div class="section">
    <div class="label">Cardholder</div>
    <div class="value">${customer.name}</div>
  </div>
  <div class="section">
    <div class="label">Phone</div>
    <div class="value">${customer.phone}</div>
  </div>
  <div class="pw-box">
    <div class="pw-label">Temporary Password</div>
    <div class="pw-value">${tempPassword}</div>
  </div>
  <div class="footer">
    Use this password to log in to your Sharelebrator account.
    Please change your password after logging in for security.
  </div>
  <div class="date">Reset on ${resetDate}</div>
  <script>window.onload = function() { window.print(); setTimeout(function() { window.close(); }, 500); };</script>
</body>
</html>`;

    const w = window.open("", "_blank", "width=420,height=600");
    if (!w) {
      toast({ title: "Pop-up blocked", description: "Allow pop-ups to print the password.", variant: "destructive" });
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  return (
    <div className="space-y-4">
      {Dialog}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start [&>*]:min-w-0">
      {/* LEFT COLUMN WRAPPER — will hold Cardholder+Transactions on top and All Accounts below */}
      <div className="space-y-4 lg:order-1">

      {/* Cardholder details + Recent transactions (single card) */}
      <Card>
        <CardContent className="p-6 h-full">
          {!customer ? (
            <div className="flex flex-col items-center justify-center gap-2 min-h-[160px] px-6 text-sm text-center text-muted-foreground">
              {outOfScope ? (
                <>
                  <ShieldAlert className="h-5 w-5 text-amber-500" />
                  <p className="font-medium text-foreground">
                    No activity at {outOfScope.storeName} in the last {windowLabel}.
                  </p>
                  <p className="text-xs max-w-xs">
                    The account exists. A record opens here while the customer is linked
                    to an open session, or was active at this branch within the last{" "}
                    {windowLabel} — this one is neither.
                  </p>
                  {outOfScope.lastVisitHereMs ? (
                    <p className="text-xs max-w-xs">
                      Last recorded visit here:{" "}
                      {format(new Date(outOfScope.lastVisitHereMs), "MMM d, h:mm a")} (
                      {formatDistanceToNow(new Date(outOfScope.lastVisitHereMs), {
                        addSuffix: true,
                      })}
                      ).
                    </p>
                  ) : null}
                  <p className="text-xs max-w-xs">
                    Link them to their table or have them log in here to bring the record
                    into scope — or ask an admin, who can view points and reset passwords
                    for any branch.
                  </p>
                </>
              ) : notFound ? (
                <p>No account found for that number.</p>
              ) : (
                <p>No card to display</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Cardholder</p>
                  <p className="text-2xl font-bold">{customer.name}</p>
                  <p className="text-sm font-mono">{customer.phone}</p>
                  {customer.bday && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Birthday: {format(new Date(customer.bday), "MMMM d, yyyy")}
                    </p>
                  )}
                  {customer.email && <p className="text-xs text-muted-foreground">{customer.email}</p>}
                  <p className="text-xs text-muted-foreground">{customer.address}</p>
                  {customer.createdAtMs && (
                    <p className="text-[11px] text-muted-foreground mt-2">
                      Member since {format(new Date(customer.createdAtMs), "MMM d, yyyy")}
                    </p>
                  )}
                  {customer.passwordResetAtMs && (
                    <Badge variant="outline" className="mt-1 text-[10px]">
                      Password reset {format(new Date(customer.passwordResetAtMs), "MMM d, yyyy")}
                    </Badge>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Balance</p>
                  <p className="text-3xl font-black text-foreground">{customer.pointsBalance.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">points</p>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Visits: <span className="font-bold text-foreground">{customer.visitCount ?? 0}</span>
                  </p>
                </div>
              </div>

              {/* Stores visited */}
              {customer.storeVisits && Object.keys(customer.storeVisits).length > 0 && (
                <div className="pt-3 border-t">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1 mb-2">
                    <MapPin className="h-3 w-3" /> Stores Visited
                  </p>
                  <div className="space-y-1">
                    {Object.entries(customer.storeVisits)
                      .sort((a, b) => b[1].visits - a[1].visits)
                      .map(([sid, v]) => (
                        <div key={sid} className="flex items-center justify-between text-xs">
                          <span className="font-medium">{v.storeName || sid}</span>
                          <span className="text-muted-foreground">
                            {v.visits} visit{v.visits === 1 ? "" : "s"} · +{v.pointsEarned} pts
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {canReset && (
                <div className="pt-4 border-t flex flex-col gap-2">
                  {tempPassword ? (
                    <div className="rounded-lg border-2 border-green-300 bg-green-50 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
                        <KeyRound className="h-4 w-4" /> Temporary password (share with customer)
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-lg font-bold bg-white px-3 py-1.5 rounded border flex-1">
                          {tempPassword}
                        </code>
                        <Button size="sm" variant="outline" onClick={copyPassword} title="Copy">
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={printPassword} title="Print">
                          <Printer className="h-4 w-4" />
                        </Button>
                      </div>
                      <p className="text-[11px] text-green-700">
                        This password is shown only once. The customer should change it after logging in.
                      </p>
                    </div>
                  ) : (
                    <Button variant="outline" onClick={handleResetPassword} disabled={resetting} className="w-full">
                      {resetting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
                      Reset Password
                    </Button>
                  )}
                </div>
              )}

              {/* Recent transactions (inside same card) */}
              <div className="pt-4 border-t">
                <p className="text-sm font-semibold mb-2">Recent Transactions</p>
                {ledger.length === 0 ? (
                  <p className="py-4 text-sm text-center text-muted-foreground">No transactions yet.</p>
                ) : (
                  <>
                    <div className="border rounded-lg overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">Date</TableHead>
                            <TableHead className="text-xs">Type</TableHead>
                            <TableHead className="text-xs">Store</TableHead>
                            <TableHead className="text-xs text-right">Amount</TableHead>
                            <TableHead className="text-xs text-right">Points</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {txnsPageRows.map((e) => (
                            <TableRow key={e.id}>
                              <TableCell className="text-xs">
                                {e.createdAtMs ? format(new Date(e.createdAtMs), "MMM d, h:mma") : "—"}
                              </TableCell>
                              <TableCell className="text-xs capitalize">{e.type}</TableCell>
                              <TableCell className="text-xs">{e.storeName || e.storeId.substring(0, 8)}</TableCell>
                              <TableCell className="text-xs text-right font-mono">
                                ₱{e.amount.toLocaleString()}
                              </TableCell>
                              <TableCell
                                className={`text-xs text-right font-mono font-bold ${
                                  e.points > 0 ? "text-green-600" : e.points < 0 ? "text-red-600" : ""
                                }`}
                              >
                                {e.points > 0 ? "+" : ""}
                                {e.points}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {txnsTotalPages > 1 && (
                      <div className="flex items-center justify-between mt-2 text-xs">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setTxnsPage((p) => Math.max(0, p - 1))}
                          disabled={txnsPage === 0}
                        >
                          Prev
                        </Button>
                        <span className="text-muted-foreground">
                          Page {txnsPage + 1} of {txnsTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setTxnsPage((p) => Math.min(txnsTotalPages - 1, p + 1))}
                          disabled={txnsPage >= txnsTotalPages - 1}
                        >
                          Next
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
      {/* END LEFT COLUMN */}

      {/* RIGHT COLUMN: All Accounts + Activity Log */}
      <div className="space-y-4 lg:order-2">
        {/* Accounts — with built-in search */}
        <Card>
          <CardHeader className="pb-3 space-y-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                {scope === "store" ? "Customers Here Now" : "All Accounts"}
              </CardTitle>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {scope === "store" ? "Here" : "Accounts"}
                  </p>
                  <p className="text-xl font-black">{totalAccounts.toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1 justify-end">
                    <Coins className="h-3 w-3" /> Points out
                  </p>
                  <p className="text-xl font-black">{totalPointsOutstanding.toLocaleString()}</p>
                </div>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or phone..."
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                className="pl-8"
              />
            </div>
            {scope === "store" && (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Customers linked to an open session here, or active at this branch in
                the last {windowLabel}. Older records are visible to admins only.
              </p>
            )}
            {loadError && (
              <p className="text-[11px] leading-snug text-destructive">{loadError}</p>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {accountsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !accountQuery && scope === "global" ? (
              <p className="px-6 py-8 text-sm text-center text-muted-foreground">
                Type a name or phone above to search.
              </p>
            ) : filteredAccounts.length === 0 ? (
              <p className="px-6 py-8 text-sm text-center text-muted-foreground">
                {scope === "store"
                  ? accountQuery
                    ? `No customers match here. If they have been away over ${windowLabel}, ask an admin.`
                    : "No customers active at this store right now."
                  : "No accounts match."}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Name</TableHead>
                      <TableHead className="text-xs">Phone</TableHead>
                      <TableHead className="text-xs text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountsPageRows.map((a) => (
                      <TableRow
                        key={a.phone}
                        className={`cursor-pointer hover:bg-muted/50 ${
                          customer?.phone === a.phone ? "bg-muted/70" : ""
                        }`}
                        onClick={() => handlePickAccount(a.phone)}
                      >
                        <TableCell className="text-sm font-medium">
                          <span className="flex items-center gap-1.5">
                            {a.name || "—"}
                            {a.presence === "active" && (
                              <Badge variant="secondary" className="text-[9px] px-1 py-0">
                                In session
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs font-mono">{a.phone}</TableCell>
                        <TableCell className="text-sm text-right font-mono font-bold">
                          {a.pointsBalance.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {accountsTotalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-2 border-t text-xs">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAccountsPage((p) => Math.max(0, p - 1))}
                      disabled={accountsPage === 0}
                    >
                      Prev
                    </Button>
                    <span className="text-muted-foreground">
                      Page {accountsPage + 1} of {accountsTotalPages} · {filteredAccounts.length} matches
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAccountsPage((p) => Math.min(accountsTotalPages - 1, p + 1))}
                      disabled={accountsPage >= accountsTotalPages - 1}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
        {/* Logs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              Activity Log
            </CardTitle>
            <CardDescription>
              Account creations, points earned, and password resets
              {scope === "store" ? " at this store, today and yesterday." : " across all stores."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {logsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : logs.length === 0 ? (
              <p className="px-6 py-8 text-sm text-center text-muted-foreground">
                No activity yet.
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">When</TableHead>
                      <TableHead className="text-xs">Event</TableHead>
                      <TableHead className="text-xs">Customer</TableHead>
                      <TableHead className="text-xs">Store</TableHead>
                      <TableHead className="text-xs text-right">Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logsPageRows.map((log) => {
                      const icon =
                        log.type === "account_created" ? (
                          <UserPlus className="h-3 w-3 text-blue-600" />
                        ) : log.type === "password_reset" ? (
                          <KeyIcon className="h-3 w-3 text-red-600" />
                        ) : log.type === "login" ? (
                          <LogIn className="h-3 w-3 text-slate-600" />
                        ) : log.type === "login_failed" ? (
                          <ShieldAlert className="h-3 w-3 text-amber-600" />
                        ) : (
                          <CoinIcon className="h-3 w-3 text-green-600" />
                        );
                      const label =
                        log.type === "account_created"
                          ? "New account"
                          : log.type === "password_reset"
                            ? "Password reset"
                            : log.type === "login"
                              ? "Login"
                              : log.type === "login_failed"
                                ? "Login failed"
                                : "Earned";
                      return (
                        <TableRow
                          key={log.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => handlePickAccount(log.phone)}
                        >
                          <TableCell className="text-xs text-muted-foreground">
                            {log.createdAtMs ? format(new Date(log.createdAtMs), "MMM d, h:mma") : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="inline-flex items-center gap-1">
                              {icon}
                              {label}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[120px]">
                            {log.customerName || log.phone}
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[100px]">
                            {log.storeName || (log.storeId ? log.storeId.substring(0, 8) : "—")}
                          </TableCell>
                          <TableCell className="text-xs text-right font-mono">
                            {log.type === "points_earned" ? (
                              <span className="text-green-600 font-bold">+{log.points}</span>
                            ) : log.type === "password_reset" ? (
                              <span className="text-red-600">reset</span>
                            ) : log.type === "login" ? (
                              <span className="text-slate-600">ok</span>
                            ) : log.type === "login_failed" ? (
                              <span className="text-amber-600">failed</span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {logsTotalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-2 border-t text-xs">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLogsPage((p) => Math.max(0, p - 1))}
                      disabled={logsPage === 0}
                    >
                      Prev
                    </Button>
                    <span className="text-muted-foreground">
                      Page {logsPage + 1} of {logsTotalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLogsPage((p) => Math.min(logsTotalPages - 1, p + 1))}
                      disabled={logsPage >= logsTotalPages - 1}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
      </div>

      {/* Legacy (old Google Sheet) loyalty customers — same gate as the reset
          controls, so cashiers never see the claim flow. */}
      {canReset && <LegacyPointsPanel />}
    </div>
  );
}

/**
 * T-424 slice T - shared seeds, request builder and ports for the POS v2 server tests.
 * docs/tasks/424-pos-v2-server-approvals.md. No app imports except the vendored v1 analytics fixtures and `lib/money`.
 *
 * ====================================================================================================================
 * THE CONTRACT THE BUILDER MATCHES (module paths, exported names, request/response shapes). Test files cite this header.
 * ====================================================================================================================
 * Modules (all server code starts with the server-only marker import; tests stub that module with vi.mock):
 *   @/server/pos2/deps               export type Pos2Deps; export const POS2_NOT_CONFIGURED = 'POS server is not configured';
 *                                    export async function getPos2Deps(env: Record<string, string | undefined>):
 *                                      Promise<{ ok: true; deps: Pos2Deps } | { ok: false; status: 503; error: string }>
 *                                    `ok:false` (error === POS2_NOT_CONFIGURED) when POS_FIREBASE_SA_KEY_FILE or DATABASE_URL is missing/blank.
 *   @/server/pos2/refunds            export async function handleRefund(req: Request, deps: Pos2Deps): Promise<Response>
 *   @/server/pos2/tender-corrections export async function handleTenderCorrection(req: Request, deps: Pos2Deps): Promise<Response>
 *   @/server/pos2/session-voids      export async function handleSessionVoid(req: Request, deps: Pos2Deps): Promise<Response>
 *   @/server/pos2/apply-delta        export async function handleApplyDelta(req: Request, deps: Pos2Deps): Promise<Response>
 *   @/app/api/pos2/refunds/route, .../tender-corrections/route, .../session-voids/route, .../analytics/apply-delta/route
 *                                    each `export async function POST(req: Request)`: builds deps with getPos2Deps(process.env);
 *                                    not configured => Response 503 JSON { ok:false, error:'POS server is not configured' }; importing
 *                                    the module must not touch firebase-admin or the database.
 *   @/middleware                     `export function middleware(req: NextRequest)` + `export const config = { matcher: '/api/:path*' }`;
 *                                    CORS for the single origin https://localhost (the APK).
 *   @/lib/api-base                   installApiBaseFetch(): a fetch of '/api/pos2/...' goes to NEXT_PUBLIC_POS2_API_BASE (default
 *                                    https://pos2.shareat.net); every other '/api/...' keeps NEXT_PUBLIC_API_BASE.
 *   @/lib/analytics/applyReceiptDeltaServerFirst   sends sale and void deltas to '/api/pos2/analytics/apply-delta' ONLY when
 *                                    process.env.NEXT_PUBLIC_POS2_ANALYTICS === '1'; otherwise to v1's '/api/analytics/apply-delta'.
 *
 * Pos2Deps (the injected ports; production builds them from firebase-admin and @shareat/auth):
 *   db: the firebase-admin shaped Firestore (the fake's `.admin`): doc(path), collection(path), runTransaction(fn),
 *       FieldValue.{serverTimestamp,increment,delete,arrayUnion,arrayRemove}, FieldPath.documentId();  tx.get(ref|query), tx.create/set/update/delete
 *   verifyIdToken(token): Promise<{ uid }>          rejects for an invalid token or one from another Firebase project
 *   approveManagerPin({ posStoreId, deviceId, pin }): Promise<{ ok: true; approverPersonId } | { ok: false; message }>
 *       posStoreId = the request's `storeId` (the Firestore store id the caller is authorised for); deviceId = the request's `deviceId`.
 *       NOTHING from Firestore (a terminals/{TT} claim doc) is consulted for the store or the bucket (B1).
 *   openTillShift(posStoreId): Promise<{ openedAtMs: number } | null>     the ERP till shift for that store
 *   resolveTerminalNo({ posStoreId, deviceId }): Promise<number | null>    T-477: the device's registered terminal (default 1); null = no link
 *   nowMs(): number        the server clock;       newId(): string       a fresh document id
 *
 * Caller identity (every route, in this order): body must be JSON (else 400); `Authorization: Bearer <token>` (else 401); verifyIdToken
 * (rejects => 401); `staff/{uid}` must exist with status === 'active' and `assignedStoreIds` containing the request's `storeId`
 * (else 403). The approval port is called only AFTER identity passes. The body's `role`/`uid` fields are never read.
 * Responses are JSON `{ ok: true, ... }` (200) or `{ ok: false, error: string }` with status: 400 bad body (incl. a non-uuid
 * `deviceId`), 401, 403 (identity, or `approveManagerPin` ok:false with error === its message), 404 unknown record, 409 any other business refusal.
 *
 * POST /api/pos2/refunds   { storeId, parentReceiptId, lines:[{lineId, qty}], tenderMethodId, reason, terminalNo, terminalSeq,
 *                            receiptNumber, pin, deviceId }
 *   200 { ok:true, refundReceiptId, receiptNumber, refundTotalCentavos, replayed:boolean }. Writes stores/{s}/receipts/{refundReceiptId}
 *   (v1 shape: isRefund, parentReceiptId, status 'final', positive-qty line clones, negative `total` in pesos, NO analytics.mop,
 *   receiptNumber/terminalNo/terminalSeq from the request, receiptSeq = terminalSeq, refundTender {methodId, methodName},
 *   refundTotalCentavos, approvedByPersonId, analyticsApplied true, createdAtClientMs = deps.nowMs()), stores/{s}/receiptNumbers/{receiptNumber}
 *   = { receiptId, terminalNo, terminalSeq, createdAt }, bumps the parent's refundedQtys.{lineId}, totalRefunded (pesos), refundCount, and
 *   applies the refund's analytics in the same transaction. Only a cash tender (storeModesOfPayment type 'cash') is accepted.
 * POST /api/pos2/tender-corrections   { storeId, receiptId, fromMethod, toMethod, amount (integer CENTAVOS), reference, reason, pin,
 *                                       requestId (uuid), deviceId }     fromMethod/toMethod are method NAMES (the analytics.mop keys)
 *   200 { ok:true, conversionId (= requestId), replayed:boolean }. Writes stores/{s}/paymentConversions/{requestId} in v1's shape
 *   (storeId, dayId, dayStartMs of the RECEIPT's day, amount in pesos, fromMethod, toMethod, status 'active', createdBy, createdAt,
 *   createdAtClientMs, voidedAt null, voidedBy null) + receiptId, reference, requestedBy {uid, name}, approvedByPersonId,
 *   source 'pos2-correction'; moves payments.byMethod on the receipt's day/month/year/preset docs exactly as v1; never writes the receipt.
 * POST /api/pos2/session-voids   { storeId, sessionId, reason, pin?, deviceId? }    200 { ok:true, sessionId }
 *   allowed for staff role manager|admin without a PIN; any other role needs a PIN (approveManagerPin); a paid/closed/voided session => 409.
 * POST /api/pos2/analytics/apply-delta   { storeId, receiptId, op: 'payment'|'refund'|'void' }   (port of v1's route)
 *   200 { ok:true, applied:boolean, skipped:boolean, op }; idempotent on receipt.analyticsApplied / analyticsReversed; other ops 501.
 */
import { FakeTimestamp, createFakeFirestore, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { applyAnalyticsDeltaServer } from '@/lib/__fixtures__/v1-analytics/applyAnalyticsDeltaServer';

export const STORE = 'S1';
export const OTHER_STORE = 'S2';
export const DEVICE = '3f2b8c1e-8d5a-4b7e-9c11-0a1b2c3d4e5f';
export const PIN_OK = '482913';
export const PIN_BAD = '000000';
export const MANAGER_PERSON = 'person-mgr-1';
/** 2026-10-15 01:00 Manila (just after midnight) - "corrected after midnight". */
export const NOW = Date.parse('2026-10-15T01:00:00+08:00');
/** The sale: 2026-10-14 10:00 Manila. */
export const T_SALE = Date.parse('2026-10-14T10:00:00+08:00');
/** A clock on the SALE's own day (the refund lands on the day of its own createdAtClientMs = deps.nowMs()). */
export const SAME_DAY = T_SALE + 2 * 3600 * 1000;
export const SHIFT_OPENED = Date.parse('2026-10-14T08:00:00+08:00');

export interface Calls { approve: { posStoreId: string; deviceId: string; pin: string }[]; shift: string[]; terminal: { posStoreId: string; deviceId: string }[] }

export interface TestDeps {
  db: FakeFirestore['admin'];
  verifyIdToken: (t: string) => Promise<{ uid: string }>;
  approveManagerPin: (i: { posStoreId: string; deviceId: string; pin: string }) => Promise<{ ok: true; approverPersonId: string } | { ok: false; message: string }>;
  openTillShift: (posStoreId: string) => Promise<{ openedAtMs: number } | null>;
  /** T-477: the terminal number the device is registered for (trusted ERP link, no PIN); null when there is no link. */
  resolveTerminalNo: (i: { posStoreId: string; deviceId: string }) => Promise<number | null>;
  nowMs: () => number;
  newId: () => string;
}

export function makeDeps(fs: FakeFirestore, over: Partial<TestDeps> = {}) {
  const calls: Calls = { approve: [], shift: [], terminal: [] };
  let n = 0;
  const deps: TestDeps = {
    db: fs.admin,
    verifyIdToken: async (t) => {
      if (!t.startsWith('tok-')) throw new Error('auth/argument-error: invalid token');
      return { uid: t.slice(4) };
    },
    approveManagerPin: async (i) => {
      calls.approve.push(i);
      return i.pin === PIN_OK ? { ok: true, approverPersonId: MANAGER_PERSON } : { ok: false, message: 'That PIN cannot approve this. Ask a store manager.' };
    },
    openTillShift: async (s) => { calls.shift.push(s); return { openedAtMs: SHIFT_OPENED }; },
    resolveTerminalNo: async (i) => { calls.terminal.push(i); return 1; },
    nowMs: () => NOW,
    newId: () => `gen${++n}`,
    ...over,
  };
  return { deps, calls };
}

export function post(path: string, body: unknown, token: string | null = 'tok-cashier'): Request {
  return new Request(`http://pos2.test/api/pos2/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
export async function json(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

/** staff/{uid}: cashier and manager at S1, someone at S2 only, an inactive one; `nobody` has no doc. */
export function seedStaff(fs: FakeFirestore) {
  fs.seed('staff/cashier', { uid: 'cashier', status: 'active', role: 'cashier', assignedStoreIds: [STORE], displayName: 'Cora Cashier' });
  fs.seed('staff/manager', { uid: 'manager', status: 'active', role: 'manager', assignedStoreIds: [STORE], displayName: 'Mara Manager' });
  fs.seed('staff/admin', { uid: 'admin', status: 'active', role: 'admin', assignedStoreIds: [STORE], displayName: 'Ada Admin' });
  fs.seed('staff/elsewhere', { uid: 'elsewhere', status: 'active', role: 'manager', assignedStoreIds: [OTHER_STORE], displayName: 'Else Where' });
  fs.seed('staff/inactive', { uid: 'inactive', status: 'disabled', role: 'manager', assignedStoreIds: [STORE], displayName: 'In Active' });
}

export function seedStore(fs: FakeFirestore) {
  fs.seed(`stores/${STORE}`, { name: 'Shareat Test', code: 'SHT', taxType: 'VAT_INCLUSIVE', taxRatePct: 12 });
  const mop = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) =>
    fs.seed(`stores/${STORE}/storeModesOfPayment/${id}`, { id, name, type, sortOrder: 1, isActive: true, hasRef: false, isArchived: false, ...extra });
  mop('m-cash', 'Cash', 'cash');
  mop('m-gcash', 'GCash', 'online', { hasRef: true });
  mop('m-card', 'Card', 'card', { hasRef: true });
  mop('m-maya', 'Maya', 'online', { hasRef: true, isActive: false });
}

export interface LineSpec { id: string; unit: number; qty: number; name?: string; free?: number; voided?: number; type?: 'package' | 'addon' }
export function lineDoc(l: LineSpec) {
  return {
    id: l.id, type: l.type ?? 'addon', itemId: `item-${l.id}`, itemName: l.name ?? `Item ${l.id}`, category: 'Food', unitPrice: l.unit,
    qtyOrdered: l.qty, discountType: null, discountValue: null, discountQty: 0, freeQty: l.free ?? 0, voidedQty: l.voided ?? 0,
  };
}

export interface ReceiptSpec {
  id: string;
  lines: LineSpec[];
  /** What the customer paid for the whole receipt, in PESOS (VAT, discounts, charges all inside). */
  total: number;
  mop?: Record<string, number>;
  createdAtClientMs?: number;
  receiptNumber?: string;
  extra?: Record<string, unknown>;
}
export function receiptDoc(r: ReceiptSpec) {
  return {
    id: r.id, receiptId: r.id, storeId: STORE, sessionId: `sess-${r.id}`, status: 'final', sessionMode: 'alacarte', tableId: null, tableNumber: null,
    customerName: null, createdByUid: 'cashier', createdByUsername: 'cora', createdAtClientMs: r.createdAtClientMs ?? T_SALE,
    createdAt: FakeTimestamp.fromMillis(r.createdAtClientMs ?? T_SALE),
    lines: r.lines.map(lineDoc), total: r.total, totalPaid: r.total, change: 0,
    receiptSeq: 1, receiptNumber: r.receiptNumber ?? 'SHT-01-000001', receiptNoFormatUsed: 'TERMINAL', terminalNo: 1, terminalSeq: 1, deviceId: DEVICE,
    analytics: { v: 2, subtotal: r.total, discountsTotal: 0, chargesTotal: 0, taxAmount: 0, grandTotal: r.total, totalPaid: r.total, change: 0, mop: r.mop ?? { Cash: r.total } },
    analyticsApplied: false,
    ...(r.extra ?? {}),
  };
}

/** Seeds a paid receipt and (default) books its sale with v1's REAL delta code, as v1's server did, so the day docs exist. */
export async function seedSale(fs: FakeFirestore, spec: ReceiptSpec, opts: { book?: boolean; nowMs?: number } = {}) {
  const doc = receiptDoc(spec);
  fs.seed(`stores/${STORE}/receipts/${spec.id}`, doc);
  if (opts.book !== false) {
    await fs.admin.runTransaction(async (tx) => {
      applyAnalyticsDeltaServer(fs.admin as any, STORE, null, doc as any, tx as any, new Date(opts.nowMs ?? NOW));
    });
    fs.seed(`stores/${STORE}/receipts/${spec.id}`, { ...doc, analyticsApplied: true });
  }
  fs.commits.length = 0; // seeding is setup: tests assert on commits made by the route only
  return doc;
}

/** An existing v1-shaped refund receipt of `parentId` (what already exists when the route counts refunded qty). */
export function seedRefundRecord(fs: FakeFirestore, id: string, parentId: string, lines: { id: string; qty: number; unit: number }[], totalPesos: number, extra: Record<string, unknown> = {}) {
  fs.seed(`stores/${STORE}/receipts/${id}`, {
    id, receiptId: id, parentReceiptId: parentId, isRefund: true, storeId: STORE, status: 'final',
    lines: lines.map((l) => lineDoc({ id: l.id, unit: l.unit, qty: l.qty })), total: -totalPesos, totalPaid: -totalPesos,
    receiptNumber: `SHT-01-0009${id.length}`, createdAtClientMs: NOW - 1000, ...extra,
  });
}

export const dayIdOf = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).replace(/-/g, '');

export function analyticsDocs(fs: FakeFirestore): Record<string, any> {
  const out: Record<string, any> = {};
  for (const col of ['analytics', 'analyticsMonths', 'analyticsYears', 'dashPresets']) {
    for (const d of fs.list(`stores/${STORE}/${col}`)) out[`${col}/${d.id}`] = d.data;
  }
  return out;
}
/** Canonical text of the day/month/year/preset docs with the server timestamp removed (for byte comparisons). */
export function canonicalAnalytics(fs: FakeFirestore): string {
  const strip = (v: any): any => {
    if (v instanceof FakeTimestamp) return '<ts>';
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const k of Object.keys(v).sort()) o[k] = strip(v[k]);
      return o;
    }
    return v;
  };
  const docs = analyticsDocs(fs);
  for (const d of Object.values(docs)) if (d?.meta) delete d.meta.updatedAt;
  return JSON.stringify(strip(docs));
}
export const byMethodOf = (fs: FakeFirestore, col: 'analytics' | 'analyticsMonths' | 'analyticsYears', id: string): Record<string, number> =>
  fs.get(`stores/${STORE}/${col}/${id}`)?.payments?.byMethod ?? {};

/** True when `text` appears anywhere in any stored document (used to prove a PIN is never persisted). */
export const storedAnywhere = (fs: FakeFirestore, text: string) => JSON.stringify([...fs.docs.entries()]).includes(text);

export { createFakeFirestore };

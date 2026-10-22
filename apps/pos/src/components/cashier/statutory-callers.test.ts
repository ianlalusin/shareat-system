/**
 * T-426 slice T - screen total = charged total, on every caller; the receipt document; privacy at bill-out; the payment-time guards.
 * Acceptance 5 (at payment), 7 (wire), 8 (VAT-exempt row), 9, 10 (refused before payment), Ruling 10.
 *
 * CONTRACT for the builder (S2, S3) - NEW module `apps/pos/src/lib/statutory/session.ts`:
 *   statutoryInputOf(session: { statutoryDiners?: StatutoryDiner[] | null; sessionMode?: string; guestCountFinal?: number | null;
 *                               guestCountServerVerified?: number | null; guestCountCashierInitial?: number | null; statutoryHeadCount?: number | null;
 *                               packageSnapshot?: { isBundle?: boolean; bundleMaxCap?: number } | null } | null | undefined): StatutoryInput | null
 *     - null when there are no diners; else { diners: session.statutoryDiners, heads: resolveHeads(session), package: { isBundle, bundleMaxCap } | null }.
 *   ALL FOUR callers pass `statutoryInputOf(session)` as the sixth argument of calculateBillTotals, so the screen total equals the charged total:
 *     components/cashier/bill-totals.tsx (new optional prop `statutory?: StatutoryInput | null`), components/cashier/session-detail-view.tsx,
 *     components/cashier/firestore.ts (completePaymentFromUnits), components/cashier/offlinePayment.ts (completePaymentOffline).
 *   `getCurrentSessionBillingState` keeps its signature; the session's `statutoryDiners` and head-count fields are read from the SAME session document.
 *   BillTotals with diners shows, per diner: the kind, the name, the MASKED ID (****1187) and the discount; the VAT block shows whenever
 *     `taxTotal > 0 OR vatExemptSales > 0` (Acceptance 8: the old hidden-row bug).
 *   completePaymentFromUnits / completePaymentOffline, with diners on the session:
 *     - amount due = totals with the diners; `expectedTotal` that does not match refuses with the existing "Bill changed before payment..." message.
 *     - BEFORE anything is written they run `statutoryPaymentBlockers` (capture.test.ts) and throw Error(<first blocker message>) on any blocker.
 *     - receipt doc (additive): `statutoryDiners: [{ kind, name, idNo (FULL), share, discount, vatRemoved, vatExempt, promoWasHigher }]` in pesos;
 *       `analytics.statutoryDiscountTotal`, `analytics.statutoryVatRemovedTotal`; `analytics.discountsTotal = totalDiscounts` (includes the statutory
 *       discount); `analytics.vatableSales / vatExemptSales / taxAmount` the mixed split; every v1 field keeps its meaning (`billDiscount` stays the promo, null here).
 *     - at bill-out the closed session document and its `closedSessions` copy keep only the MASKED ID (`****1187`) and no `idNoNormalized`;
 *       the receipt keeps the full ID.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, setActiveFake, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import { STORE_ID, cashPayment, memoryLocalStorage, paymentMethods, store, user, writtenReceipt } from '@/test-helpers/posFixtures';
import { loadMod, mkDiner, mkLine, mkStore, need, workedCase, type Diner } from '@/test-helpers/statutoryOracle';

vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({ db: { __fake: true }, auth: { currentUser: { getIdToken: async () => 'test-token' } } }));
vi.mock('@/context/auth-context', () => ({}));
vi.mock('@/components/cashier/activity-log', () => ({ writeActivityLog: vi.fn(async () => {}) }));
vi.mock('@/lib/server-profiles/activeLocalProfile', () => ({ getActiveLocalProfile: () => null }));
vi.mock('@/lib/printing/kitchenBackupPrint', () => ({ printKitchenTicketBackup: vi.fn() }));
vi.mock('@/lib/printing/kitchenBackupDeps', () => ({ makeKitchenBackupDeps: vi.fn(() => ({})) }));
vi.mock('@/lib/analytics/applyAnalyticsDeltaV2', () => ({ applyAnalyticsDeltaV2: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyReceiptDeltaServerFirst', () => ({ applyReceiptDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsTicketDelta', () => ({ applyKdsTicketDelta: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsDeltaServerFirst', () => ({ applyKdsDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/offline/browserDevice', () => ({ getBrowserDeviceId: () => 'DEV-A' }));

import * as counter from '@/lib/terminal/counter';
import { completePaymentFromUnits } from '@/components/cashier/firestore';
import { completePaymentOffline } from '@/components/cashier/offlinePayment';
import { BillTotals } from '@/components/cashier/bill-totals';

const FULL_ID = 'OSCA-2024-001187';
const FULL_ID_NORM = 'OSCA2024001187';
const ZERO_SHARE = 'Mark at least one dish for each senior/PWD diner, or remove them.';
const cashier = { ...user, role: 'cashier' } as any;

let fs: FakeFirestore;

/** The worked case on a real session document: package P449 x 4 + shared P318, VAT-inclusive 12%, one senior (no dish assigned). */
function seedStatutorySession(sessionId = 'sess1', o: { diners?: Diner[]; lines?: 'worked' | 'alacarte'; session?: Record<string, unknown>; projection?: boolean } = {}) {
  const sp = `stores/${STORE_ID}/sessions/${sessionId}`;
  const w = workedCase();
  const diners = o.diners ?? [w.diner];
  const alacarte = o.lines === 'alacarte';
  fs.seed(sp, {
    status: 'active', isPaid: false, billingRevision: 3, sessionMode: alacarte ? 'alacarte' : 'package_dinein',
    tableId: alacarte ? null : 't1', tableNumber: alacarte ? null : '1', customer: { name: 'Ana' }, startedAtClientMs: 1_700_000_000_000,
    loyaltyRedemptions: [], guestCountCashierInitial: alacarte ? 0 : 4, guestCountFinal: alacarte ? null : 4,
    statutoryDiners: diners, ownerTerminalId: 'DEV-A', revision: 1, ...(o.session ?? {}),
  });
  const lines = alacarte
    ? [mkLine({ id: 'a1', type: 'addon', name: 'Sisig', priceC: 50000, qty: 1 })]
    : w.lines;
  lines.forEach((l, i) => fs.seed(`${sp}/sessionBillLines/${l.id}`, { ...l, createdAt: i + 1, updatedAt: i + 1 }));
  fs.seed(`stores/${STORE_ID}/activeSessions/${sessionId}`, { status: 'active', customerPin: null, ...(o.projection ? { statutoryDiners: diners } : {}) });
  if (!alacarte) {
    fs.seed(`stores/${STORE_ID}/tables/t1`, { status: 'occupied', currentSessionId: sessionId });
    fs.seed(`stores/${STORE_ID}/storeConfig/current/tables/t1`, { status: 'occupied', currentSessionId: sessionId, customerName: 'Ana' });
  }
  return { sessionId, sp };
}

async function claimThisTablet(nextSeq = 5) {
  await counter.saveTerminalClaim({ storeId: STORE_ID, terminalNo: 1, deviceId: 'DEV-A', nextSeq });
  fs.seed(`stores/${STORE_ID}/terminals/01`, { deviceId: 'DEV-A', claimedByUid: 'mgr', releaseEpoch: 0 });
}
const payOnline = (sessionId = 'sess1', amount = 2000, expected: number | undefined = 1985.71) =>
  completePaymentFromUnits(STORE_ID, sessionId, cashier, cashPayment(amount), store, paymentMethods, expected);
const payOffline = (sessionId = 'sess1', amount = 2000, expected: number | undefined = 1985.71) =>
  completePaymentOffline(STORE_ID, sessionId, cashier, cashPayment(amount), store, paymentMethods, expected);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const receipt = (id = 'sess1') => writtenReceipt(fs, id) ?? (fs.get(`stores/${STORE_ID}/receipts/${id}`) as Record<string, any> | undefined);

beforeEach(async () => {
  fs = createFakeFirestore();
  setActiveFake(fs);
  vi.stubGlobal('indexedDB', createFakeIdb({ commitDelayMs: 0 }));
  vi.stubGlobal('localStorage', memoryLocalStorage());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await claimThisTablet();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------------------------
describe('statutoryInputOf', () => {
  const fn = async () => need<(s: any) => any>(await loadMod('@/lib/statutory/session'), 'statutoryInputOf', 'apps/pos/src/lib/statutory/session.ts');
  it('null without diners; else the diners, the resolved head count and the package info', async () => {
    const statutoryInputOf = await fn();
    expect(statutoryInputOf(null)).toBeNull();
    expect(statutoryInputOf({ statutoryDiners: [] })).toBeNull();
    expect(statutoryInputOf({ sessionMode: 'package_dinein' })).toBeNull();
    const d = [mkDiner(1)];
    expect(statutoryInputOf({ statutoryDiners: d, guestCountFinal: 4 })).toEqual({ diners: d, heads: 4, package: null });
    expect(statutoryInputOf({ statutoryDiners: d, guestCountFinal: 6, packageSnapshot: { isBundle: true, bundleMaxCap: 4 } })).toEqual({ diners: d, heads: 6, package: { isBundle: true, bundleMaxCap: 4 } });
    expect(statutoryInputOf({ statutoryDiners: d, sessionMode: 'alacarte', guestCountCashierInitial: 0, statutoryHeadCount: 2 })!.heads).toBe(2);
  });
});

describe('Acceptance 9: screen total = online charged = offline charged, for the same session', () => {
  it('the screen calculation (statutoryInputOf + calculateBillTotals) gives P1,985.71 for the worked session', async () => {
    const tax = await loadMod('@/lib/tax');
    const input = need<(s: any) => any>(await loadMod('@/lib/statutory/session'), 'statutoryInputOf', 'session.ts')(fs.get(seedStatutorySession().sp));
    const w = workedCase();
    const t = tax.calculateBillTotals(w.lines, store, null, [], null, input);
    expect(t.grandTotal).toBe(1985.71);
  });

  it('online: charges P1,985.71 (not the whole-bill P2,114.00), the receipt total and analytics agree, change is P14.29', async () => {
    seedStatutorySession();
    await payOnline();
    await settle();
    const r = receipt()!;
    expect(r.total).toBe(1985.71);
    expect(r.analytics.grandTotal).toBe(1985.71);
    expect(r.change).toBe(14.29);
  });

  it('offline: charges the same P1,985.71 and writes the same receipt figures', async () => {
    seedStatutorySession();
    await payOffline();
    await settle();
    const r = receipt()!;
    expect(r.total).toBe(1985.71);
    expect(r.analytics.grandTotal).toBe(1985.71);
  });

  it('online and offline write the SAME statutory figures for the same bill', async () => {
    seedStatutorySession('on1');
    seedStatutorySession('off1');
    await payOnline('on1');
    await payOffline('off1');
    await settle();
    const a = receipt('on1')!, b = receipt('off1')!;
    const pick = (r: Record<string, any>) => ({
      total: r.total, statutoryDiners: r.statutoryDiners,
      analytics: Object.fromEntries(['subtotal', 'discountsTotal', 'chargesTotal', 'taxAmount', 'vatableSales', 'vatExemptSales', 'grandTotal', 'statutoryDiscountTotal', 'statutoryVatRemovedTotal'].map((k) => [k, r.analytics?.[k]])),
    });
    expect(pick(a)).toEqual(pick(b));
    expect(pick(a).analytics.statutoryDiscountTotal).toBe(80.18);
  });

  it('a caller that forgets the diners is caught: an expected total of P2,114.00 (no diners) is refused online and offline', async () => {
    seedStatutorySession('on1');
    seedStatutorySession('off1');
    await expect(payOnline('on1', 2200, 2114)).rejects.toThrow(/Bill changed before payment/);
    await expect(payOffline('off1', 2200, 2114)).rejects.toThrow(/Bill changed before payment/);
    expect(fs.has(`stores/${STORE_ID}/receipts/on1`)).toBe(false);
    expect(fs.has(`stores/${STORE_ID}/receipts/off1`)).toBe(false);
  });

  it('the four callers all use statutoryInputOf (source check)', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const f of ['./bill-totals.tsx', './session-detail-view.tsx', './firestore.ts', './offlinePayment.ts']) {
      const src = read(f);
      expect(src, `${f} must call statutoryInputOf(`).toContain('statutoryInputOf(');
      expect(src, `${f} must import from the statutory module`).toMatch(/@\/lib\/statutory\/session/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the receipt document (Acceptance 7, wire is additive)', () => {
  it.each([['online', payOnline], ['offline', payOffline]] as const)('%s: statutoryDiners with the FULL ID and exact peso amounts; v1 fields keep their meaning', async (_name, pay) => {
    seedStatutorySession();
    await pay();
    await settle();
    const r = receipt()!;
    expect(r.statutoryDiners).toEqual([{
      kind: 'senior', name: 'Lola Remedios Cruz', idNo: FULL_ID, share: 449, discount: 80.18, vatRemoved: 48.11, vatExempt: 320.71, promoWasHigher: false,
    }]);
    expect(r.analytics).toMatchObject({
      subtotal: 2114, discountsTotal: 80.18, chargesTotal: 0, taxAmount: 178.39, vatableSales: 1486.61, vatExemptSales: 320.71,
      grandTotal: 1985.71, statutoryDiscountTotal: 80.18, statutoryVatRemovedTotal: 48.11,
    });
    expect(r.billDiscount ?? null).toBeNull(); // the promo slot is untouched: no whole-bill senior/PWD discount any more
    expect(r.lines).toHaveLength(2);
    for (const v of [r.total, r.analytics.grandTotal, r.analytics.vatableSales, r.analytics.vatExemptSales, r.analytics.taxAmount]) expect(Math.round(v * 100) / 100).toBe(v);
  });

  it('a session with no diners writes a receipt with no statutory fields beyond zero totals (v1 shape)', async () => {
    seedStatutorySession('plain', { diners: [] });
    await payOnline('plain', 2200, 2114);
    await settle();
    const r = receipt('plain')!;
    expect(r.total).toBe(2114);
    expect(r.statutoryDiners ?? []).toEqual([]);
    expect(r.analytics.discountsTotal).toBe(0);
    expect(r.analytics.vatExemptSales).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Ruling 10: bill-out keeps only the masked ID on the session and the closedSessions copy', () => {
  it.each([['online', payOnline], ['offline', payOffline]] as const)('%s: the receipt holds the full ID; the closed session and its closedSessions copy hold ****1187 only', async (_name, pay) => {
    seedStatutorySession('sess1', { projection: true });
    await pay();
    await settle();
    expect(JSON.stringify(receipt())).toContain(FULL_ID);
    const closed = fs.get(`stores/${STORE_ID}/sessions/sess1`)!;
    const copy = fs.get(`stores/${STORE_ID}/closedSessions/sess1`);
    expect(closed.status).toBe('closed');
    expect(copy).toBeTruthy();
    for (const [label, doc] of [['session', closed], ['closedSessions', copy]] as const) {
      const text = JSON.stringify(doc);
      expect(text, `${label} must not keep the full ID`).not.toContain(FULL_ID);
      expect(text, `${label} must not keep the normalised ID`).not.toContain(FULL_ID_NORM);
      expect(text, `${label} must not keep idNoNormalized`).not.toContain('idNoNormalized');
    }
    expect(closed.statutoryDiners[0].idNo).toBe('****1187');
    expect(closed.statutoryDiners[0].name).toBe('Lola Remedios Cruz');
  });
});

// ---------------------------------------------------------------------------------------------
describe('payment-time guards: refused BEFORE anything is written (Acceptance 5 at payment, Acceptance 10)', () => {
  const noWrites = (id = 'sess1') => {
    expect(fs.has(`stores/${STORE_ID}/receipts/${id}`)).toBe(false);
    expect(fs.get(`stores/${STORE_ID}/sessions/${id}`)).toMatchObject({ status: 'active', isPaid: false });
  };

  it.each([['online', payOnline], ['offline', payOffline]] as const)('%s: a la carte diner with no dish assigned is refused with the exact sentence', async (_n, pay) => {
    seedStatutorySession('sess1', { lines: 'alacarte', diners: [mkDiner(1)], session: { statutoryHeadCount: 1 } });
    await expect(pay('sess1', 1000, undefined)).rejects.toThrow(ZERO_SHARE);
    noWrites();
  });

  it.each([['online', payOnline], ['offline', payOffline]] as const)('%s: diners > heads after a guest-count drop is refused', async (_n, pay) => {
    const diners = [mkDiner(1), mkDiner(2)];
    seedStatutorySession('sess1', { diners, session: { guestCountFinal: 1, guestCountCashierInitial: 1 } });
    await expect(pay('sess1', 2200, undefined)).rejects.toThrow(/diner|senior|pwd|guest/i);
    noWrites();
  });

  it.each([['online', payOnline], ['offline', payOffline]] as const)('%s: loyalty with every diner qualifying is refused before payment', async (_n, pay) => {
    const diners = [mkDiner(1, { dishLineIds: ['a1'] })];
    seedStatutorySession('sess1', {
      lines: 'alacarte', diners,
      session: { statutoryHeadCount: 1, loyaltyRedemptions: [{ redemptionId: 'r1', type: 'fixed', value: 50, rewardName: 'P50 off' }] },
    });
    await expect(pay('sess1', 1000, undefined)).rejects.toThrow('Points cannot be used when every diner gets the senior/PWD discount');
    noWrites();
  });

  it('a complete a la carte session (every diner has a dish, no loyalty) pays: P500 sisig, one senior, non-exempt part nil -> P357.14', async () => {
    seedStatutorySession('sess1', { lines: 'alacarte', diners: [mkDiner(1, { dishLineIds: ['a1'] })], session: { statutoryHeadCount: 1 } });
    await payOnline('sess1', 400, 357.14);
    await settle();
    expect(receipt()!.total).toBe(357.14);
    expect(receipt()!.analytics).toMatchObject({ vatExemptSales: 357.14, vatableSales: 0, taxAmount: 0, statutoryDiscountTotal: 89.29 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('BillTotals on screen (Acceptance 8, Ruling 6)', () => {
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(BillTotals as any, { billDiscount: null, customAdjustments: [], totalPaid: 0, ...props }));

  it('lists each diner (kind, name, masked ID, discount), the exempt row and the amount due of the worked case', () => {
    const w = workedCase();
    const html = render({ lines: w.lines, store: w.store, statutory: w.input });
    expect(html).toMatch(/Senior/i);
    expect(html).toContain('Lola Remedios Cruz');
    expect(html).toContain('****1187');
    expect(html).not.toContain(FULL_ID);
    expect(html).toContain('80.18');
    expect(html).toMatch(/VAT-Exempt Sales/);
    expect(html).toContain('320.71');
    expect(html).toContain('1,985.71');
  });

  it('shows the VAT-Exempt row when taxTotal = 0 and vatExemptSales > 0 (the hidden-row bug)', () => {
    const lines = [mkLine({ id: 'a1', type: 'addon', name: 'Sisig', priceC: 50000, qty: 1 })];
    const html = render({ lines, store: mkStore('VAT_INCLUSIVE', 12), statutory: { diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 1, package: null } });
    expect(html).toMatch(/VAT-Exempt Sales/);
    expect(html).toContain('357.14');
  });

  it('with no diners nothing new appears and the old bill is unchanged', () => {
    const w = workedCase();
    const html = render({ lines: w.lines, store: w.store });
    expect(html).not.toMatch(/\*\*\*\*/);
    expect(html).toContain('2,114.00');
  });
});

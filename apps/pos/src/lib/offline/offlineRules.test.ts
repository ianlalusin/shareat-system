/**
 * T-425 slice T - the offline tender / refund / void / owner rules as PURE functions (Ruling 5; ADR A3; bible row 356). Acceptance 11.
 *
 * CONTRACT for the builder (S4) - file `apps/pos/src/lib/offline/offlineRules.ts` (no firebase, no React). Exports exactly:
 *   NEEDS_INTERNET = 'Needs the internet'
 *   OFFLINE_REFUND_MESSAGE = 'Refunds need the internet.'
 *   OFFLINE_VOID_ROLE_MESSAGE = 'Only a manager or admin can void a table while offline.'
 *   OWNER_OTHER_TABLET_MESSAGE = 'This table was opened on another tablet. Pay it there, or wait for the internet.'
 *   interface OfflineMop { id: string; name?: string; type?: string; gateway?: string | null }          (the ModeOfPayment fields that matter)
 *   offlineTenderRule(mop: OfflineMop): { enabled: boolean; requiresReference: boolean; toCheck: boolean; disabledReason?: string }
 *        cash (type 'cash') -> enabled, no reference, not toCheck.
 *        e-wallet (type 'online' with no gateway: GCash, Maya) -> enabled, requiresReference true, toCheck true.
 *        card (type 'card'), QR Ph (gateway 'paymongo_qrph') and anything else (type 'other' / unknown) -> enabled false, disabledReason NEEDS_INTERNET.
 *   buildOfflineTenders(payments: { methodId?: string; amount?: number; reference?: string | null }[], mops: OfflineMop[]): LedgerTender[]
 *        one tender per payment: { method: mop.name, centavos: storedPesosToCentavos(amount), toCheck, reference: trimmed reference or null }.
 *        THROWS Error: a disabled method -> message contains NEEDS_INTERNET and the method name; an e-wallet with a missing/blank reference ->
 *        message contains the word "reference" and the method name. An unknown methodId throws too.
 *   tendersToCheck(tenders: LedgerTender[]): { method: string; centavos: number; reference: string | null }[]   - only toCheck tenders (the receipt's additive field)
 *   canRefundOffline(): false
 *   canVoidOffline(role: string | null | undefined): boolean         - 'manager' | 'admin' only (cashier, server, kitchen, unknown, missing: false)
 *   assertOfflineVoidAllowed(role): void                              - throws Error(OFFLINE_VOID_ROLE_MESSAGE) when !canVoidOffline
 *   assertOfflineSessionOwner(session: { ownerTerminalId?: string | null }, deviceId: string): void
 *        throws Error(OWNER_OTHER_TABLET_MESSAGE) unless session.ownerTerminalId === deviceId. A session with NO ownerTerminalId (opened by v1)
 *        is refused offline too (allowed only online).
 */
import { describe, expect, it } from 'vitest';
import * as rules from '@/lib/offline/offlineRules';

const cash = { id: 'm-cash', name: 'Cash', type: 'cash' };
const gcash = { id: 'm-gcash', name: 'GCash', type: 'online' };
const maya = { id: 'm-maya', name: 'Maya', type: 'online' };
const card = { id: 'm-card', name: 'Visa', type: 'card' };
const qrph = { id: 'm-qr', name: 'QR Ph', type: 'online', gateway: 'paymongo_qrph' };
const other = { id: 'm-other', name: 'Voucher', type: 'other' };
const mops = [cash, gcash, maya, card, qrph, other];

describe('offlineTenderRule (Acceptance 11)', () => {
  it('cash: enabled, no reference, nothing to check', () => {
    expect(rules.offlineTenderRule(cash)).toMatchObject({ enabled: true, requiresReference: false, toCheck: false });
  });
  it.each([gcash, maya])('e-wallet $name: enabled, reference REQUIRED, marked to check', (m) => {
    expect(rules.offlineTenderRule(m)).toMatchObject({ enabled: true, requiresReference: true, toCheck: true });
  });
  it.each([card, qrph, other])('$name is disabled with "Needs the internet"', (m) => {
    const r = rules.offlineTenderRule(m);
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toBe('Needs the internet');
    expect(rules.NEEDS_INTERNET).toBe('Needs the internet');
  });
});

describe('buildOfflineTenders / tendersToCheck', () => {
  it('cash is a plain tender in centavos', () => {
    expect(rules.buildOfflineTenders([{ methodId: 'm-cash', amount: 598 }], mops)).toEqual([{ method: 'Cash', centavos: 59800, toCheck: false, reference: null }]);
  });
  it('GCash with a reference is saved toCheck:true, reference trimmed, and appears in tendersToCheck', () => {
    const t = rules.buildOfflineTenders([{ methodId: 'm-cash', amount: 100 }, { methodId: 'm-gcash', amount: 498, reference: '  GC-8841 ' }], mops);
    expect(t[1]).toEqual({ method: 'GCash', centavos: 49800, toCheck: true, reference: 'GC-8841' });
    expect(rules.tendersToCheck(t)).toEqual([{ method: 'GCash', centavos: 49800, reference: 'GC-8841' }]);
  });
  it('GCash with no, empty or blank reference is refused naming the method and the word reference', () => {
    for (const reference of [undefined, null, '', '   ']) {
      expect(() => rules.buildOfflineTenders([{ methodId: 'm-gcash', amount: 598, reference }], mops)).toThrow(/reference/i);
      expect(() => rules.buildOfflineTenders([{ methodId: 'm-gcash', amount: 598, reference }], mops)).toThrow(/GCash/);
    }
  });
  it.each(['m-card', 'm-qr', 'm-other'])('%s is refused with the "Needs the internet" sentence', (id) => {
    expect(() => rules.buildOfflineTenders([{ methodId: id, amount: 598 }], mops)).toThrow(/Needs the internet/);
  });
  it('an unknown method id is refused', () => {
    expect(() => rules.buildOfflineTenders([{ methodId: 'nope', amount: 1 }], mops)).toThrow();
  });
  it('tendersToCheck of an all-cash sale is empty', () => {
    expect(rules.tendersToCheck(rules.buildOfflineTenders([{ methodId: 'm-cash', amount: 5 }], mops))).toEqual([]);
  });
});

describe('refund, void and owner rules (bible row 356; ADR-015 section 5)', () => {
  it('refunds are never available offline, with the planner\'s sentence', () => {
    expect(rules.canRefundOffline()).toBe(false);
    expect(rules.OFFLINE_REFUND_MESSAGE).toBe('Refunds need the internet.');
  });
  it.each(['cashier', 'server', 'kitchen', '', undefined, null, 'owner'])('role %s cannot void offline', (role) => {
    expect(rules.canVoidOffline(role as any)).toBe(false);
    expect(() => rules.assertOfflineVoidAllowed(role as any)).toThrow('Only a manager or admin can void a table while offline.');
  });
  it.each(['manager', 'admin'])('role %s can void offline', (role) => {
    expect(rules.canVoidOffline(role)).toBe(true);
    expect(() => rules.assertOfflineVoidAllowed(role)).not.toThrow();
  });
  it('one tablet bills a table: another device, or a v1 session with no owner, is refused offline', () => {
    const msg = 'This table was opened on another tablet. Pay it there, or wait for the internet.';
    expect(() => rules.assertOfflineSessionOwner({ ownerTerminalId: 'DEV-B' }, 'DEV-A')).toThrow(msg);
    expect(() => rules.assertOfflineSessionOwner({}, 'DEV-A')).toThrow(msg);
    expect(() => rules.assertOfflineSessionOwner({ ownerTerminalId: null }, 'DEV-A')).toThrow(msg);
    expect(() => rules.assertOfflineSessionOwner({ ownerTerminalId: 'DEV-A' }, 'DEV-A')).not.toThrow();
    expect(rules.OWNER_OTHER_TABLET_MESSAGE).toBe(msg);
    expect(rules.OFFLINE_VOID_ROLE_MESSAGE).toBe('Only a manager or admin can void a table while offline.');
  });
});

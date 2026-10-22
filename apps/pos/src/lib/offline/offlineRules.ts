/**
 * T-425 S4 - what a tablet may do WITHOUT the internet (Ruling 5; ADR A3; bible row 356). Pure: no firebase, no React.
 *  - Tenders: cash; GCash/Maya only with a required reference (saved `toCheck`: a manager checks them against the wallet later);
 *    card, QR Ph and anything else are disabled ("Needs the internet").
 *  - Refunds: never offline.
 *  - Void of an unpaid table: only a signed-in manager or admin.
 *  - One tablet bills a table (ADR-015 section 5): pay or void offline only a session THIS tablet opened.
 */
import { storedPesosToCentavos } from '@/lib/money/centavos';
import type { LedgerTender } from '@/lib/outbox/ledger';

export const NEEDS_INTERNET = 'Needs the internet';
export const OFFLINE_REFUND_MESSAGE = 'Refunds need the internet.';
export const OFFLINE_VOID_ROLE_MESSAGE = 'Only a manager or admin can void a table while offline.';
export const OWNER_OTHER_TABLET_MESSAGE = 'This table was opened on another tablet. Pay it there, or wait for the internet.';

/** The ModeOfPayment fields that matter here. */
export interface OfflineMop {
  id: string;
  name?: string;
  type?: string;
  gateway?: string | null;
}

export interface OfflineTenderRule {
  enabled: boolean;
  requiresReference: boolean;
  toCheck: boolean;
  disabledReason?: string;
}

export function offlineTenderRule(mop: OfflineMop): OfflineTenderRule {
  const type = String(mop.type ?? '').toLowerCase();
  if (type === 'cash') return { enabled: true, requiresReference: false, toCheck: false };
  if (type === 'online' && !mop.gateway) return { enabled: true, requiresReference: true, toCheck: true };
  return { enabled: false, requiresReference: false, toCheck: false, disabledReason: NEEDS_INTERNET };
}

export interface OfflinePaymentInput {
  methodId?: string;
  amount?: number;
  reference?: string | null;
}

/** One ledger tender per payment. Throws a plain sentence for a method that cannot be used offline or an e-wallet with no reference. */
export function buildOfflineTenders(payments: OfflinePaymentInput[], mops: OfflineMop[]): LedgerTender[] {
  return payments.map((p) => {
    const mop = mops.find((m) => m.id === p.methodId);
    if (!mop) throw new Error(`Payment method ${p.methodId ?? '(none)'} is not available on this tablet.`);
    const name = mop.name || mop.id;
    const rule = offlineTenderRule(mop);
    if (!rule.enabled) throw new Error(`${name}: ${NEEDS_INTERNET}. Use Cash or an e-wallet with a reference number.`);
    const reference = typeof p.reference === 'string' && p.reference.trim() !== '' ? p.reference.trim() : null;
    if (rule.requiresReference && !reference) throw new Error(`${name} needs a reference number while offline. Enter the reference from the customer's phone.`);
    return { method: name, centavos: storedPesosToCentavos(p.amount), toCheck: rule.toCheck, reference };
  });
}

/** The receipt's additive field: only the tenders a manager must check later. */
export function tendersToCheck(tenders: LedgerTender[]): { method: string; centavos: number; reference: string | null }[] {
  return tenders.filter((t) => t.toCheck).map((t) => ({ method: t.method, centavos: t.centavos, reference: t.reference }));
}

export function canRefundOffline(): false {
  return false;
}

export function canVoidOffline(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

export function assertOfflineVoidAllowed(role: string | null | undefined): void {
  if (!canVoidOffline(role)) throw new Error(OFFLINE_VOID_ROLE_MESSAGE);
}

/** A session with no `ownerTerminalId` (opened by v1) is refused offline too: it is allowed only online. */
export function assertOfflineSessionOwner(session: { ownerTerminalId?: string | null }, deviceId: string): void {
  if (!session.ownerTerminalId || session.ownerTerminalId !== deviceId) throw new Error(OWNER_OTHER_TABLET_MESSAGE);
}

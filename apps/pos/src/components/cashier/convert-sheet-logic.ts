import { storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { formatCentavos } from '@/lib/money/format';

export type Direction = 'cash_in' | 'cash_out';
export interface ConversionAttempt {
  requestId: string; direction: Direction; walletMethod: string; amountCentavos: number; note: string;
}
/** A stored retry envelope is data, never permission to post automatically or to invent a new request id. */
export function decodeConversionAttempt(input: unknown): ConversionAttempt | null {
  if (!input || typeof input !== 'object') return null;
  const v = input as Record<string, unknown>;
  if (typeof v.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.requestId) ||
      (v.direction !== 'cash_in' && v.direction !== 'cash_out') || typeof v.walletMethod !== 'string' || !v.walletMethod.trim() ||
      typeof v.amountCentavos !== 'number' || !Number.isSafeInteger(v.amountCentavos) || v.amountCentavos <= 0 || typeof v.note !== 'string') return null;
  return { requestId: v.requestId, direction: v.direction, walletMethod: v.walletMethod, amountCentavos: v.amountCentavos, note: v.note };
}
export const DIRECTION_LABELS: Record<Direction, string> = {
  cash_in: 'Cash-in (customer gives cash, gets GCash)', cash_out: 'Cash-out (customer gets cash)',
};
export function directionLabel(direction: Direction, wallet = 'GCash'): string {
  return direction === 'cash_in' ? `Cash-in (customer gives cash, gets ${wallet})` : DIRECTION_LABELS.cash_out;
}
export function convertEffectText(direction: Direction, wallet: string, cents: number, cash = 'Drawer cash'): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) return '';
  const amount = `₱${formatCentavos(cents)}`;
  return `${cash} ${direction === 'cash_in' ? '+' : '−'}${amount} · ${wallet} ${direction === 'cash_in' ? '−' : '+'}${amount}`;
}
export function convertButtonState(online: boolean) {
  return { disabled: !online, label: 'Convert', hint: online ? null : 'Needs the internet' };
}
export interface ConversionDoc {
  id: string; source?: string; status: string; fromMethod: string; toMethod: string;
  amount: number; createdAtClientMs: number; note?: string | null;
  tillShiftOpenedAtMs?: number;
}
export function conversionRows(docs: readonly ConversionDoc[]) {
  return docs.filter((doc) => doc.source !== 'pos2-correction')
    .slice().sort((a, b) => b.createdAtClientMs - a.createdAtClientMs || a.id.localeCompare(b.id))
    .map((doc) => ({ ...doc,
      text: `${doc.fromMethod} → ${doc.toMethod} · ₱${formatCentavos(storedPesosToCentavos(doc.amount))}${doc.note ? ` · ${doc.note}` : ''}`,
      struck: doc.status === 'voided', canVoid: doc.source === 'pos2-convert' && doc.status === 'active',
    }));
}
export function conversionsNet(docs: readonly ConversionDoc[]): Record<string, number> {
  const cents: Record<string, number> = Object.create(null);
  for (const doc of docs) {
    if (doc.source === 'pos2-correction' || doc.status !== 'active') continue;
    const amount = storedPesosToCentavos(doc.amount);
    cents[doc.fromMethod] = (cents[doc.fromMethod] ?? 0) - amount;
    cents[doc.toMethod] = (cents[doc.toMethod] ?? 0) + amount;
  }
  return Object.fromEntries(Object.entries(cents).map(([method, total]) => [method, toWirePesos(total)]));
}

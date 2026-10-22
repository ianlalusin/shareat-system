import { lineAmounts } from '@/lib/money/line-amounts';
import { statutoryShares, type StatutoryInput } from './shares';
import type { SessionBillLine, StatutoryDiner } from '@/lib/types';

export const normalizeIdNo = (raw: string): string => raw.trim().replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
export const maskIdNo = (raw: string): string => `****${normalizeIdNo(raw).slice(-4)}`;
const positiveCount = (value: number | null | undefined) => Number.isInteger(value) && (value ?? 0) > 0 ? value as number : 0;
export function resolveHeads(session: { guestCountFinal?: number | null; guestCountCashierInitial?: number | null;
  guestCountServerVerified?: number | null; statutoryHeadCount?: number | null }): number | null {
  return positiveCount(session.guestCountFinal) || Math.max(positiveCount(session.guestCountCashierInitial),
    positiveCount(session.guestCountServerVerified)) || positiveCount(session.statutoryHeadCount) || null;
}
type FailureCode = 'kind-invalid' | 'name-required' | 'id-required' | 'duplicate-id' | 'head-count-required' | 'diners-exceed-heads';
const refusal = (code: FailureCode, message: string) => ({ ok: false as const, code, message });
const sameName = (name: string) => name.trim().replace(/\s+/g, ' ').toUpperCase();
export function addStatutoryDiner(input: { diners: StatutoryDiner[]; entry: { kind?: string; name?: string; idNo?: string };
  heads: number | null; actor: { uid: string }; nowMs: number }) {
  const { diners, entry, heads, actor, nowMs } = input;
  if (entry.kind !== 'senior' && entry.kind !== 'pwd') return refusal('kind-invalid', 'Choose Senior or PWD.');
  const name = entry.name?.trim() ?? '';
  if (!name) return refusal('name-required', 'Enter the qualifying diner’s full name.');
  const idNo = entry.idNo?.trim() ?? '';
  const idNoNormalized = normalizeIdNo(idNo);
  if (!idNoNormalized) return refusal('id-required', 'Enter the qualifying diner’s ID number.');
  if (diners.some(diner => normalizeIdNo(diner.idNo) === idNoNormalized)) {
    return refusal('duplicate-id', 'That ID is already recorded on this bill. One person can claim only once.');
  }
  if (!positiveCount(heads)) return refusal('head-count-required', 'Enter the number of diners before adding a senior or PWD.');
  if (diners.length + 1 > (heads ?? 0)) return refusal('diners-exceed-heads', 'There cannot be more qualifying diners than people at the table.');
  const diner: StatutoryDiner = { id: crypto.randomUUID(), kind: entry.kind, name, idNo, idNoNormalized,
    addedByUid: actor.uid, addedAtClientMs: nowMs, dishLineIds: [] };
  return { ok: true as const, diners: [...diners, diner], diner,
    warnings: diners.some(existing => sameName(existing.name) === sameName(name)) ? ['same-name'] : [] };
}
export function removeStatutoryDiner(diners: StatutoryDiner[], id: string): StatutoryDiner[] {
  return diners.filter(diner => diner.id !== id);
}
export function assignDishToDiner(diners: StatutoryDiner[], dinerId: string, lineId: string): StatutoryDiner[] {
  if (!diners.some(diner => diner.id === dinerId)) return [...diners];
  return diners.map(diner => ({ ...diner, dishLineIds: diner.id === dinerId
    ? [...new Set([...diner.dishLineIds, lineId])] : diner.dishLineIds.filter(id => id !== lineId) }));
}
interface PaymentBlocker { code: 'zero-share' | 'diners-exceed-heads' | 'head-count-required' | 'loyalty-remainder-zero' | 'invalid-diner' | 'duplicate-id';
  message: string; dinerId?: string; releaseRedemptionIds?: string[] }
export function statutoryPaymentBlockers(input: StatutoryInput & { lines: SessionBillLine[]; loyaltyRedemptions?: { redemptionId: string }[] }): PaymentBlocker[] {
  if (!input.diners.length) return [];
  const blockers: PaymentBlocker[] = [];
  const ids = new Set<string>(), people = new Set<string>();
  for (const diner of input.diners) {
    if (!diner || (diner.kind !== 'senior' && diner.kind !== 'pwd') || typeof diner.name !== 'string' || !diner.name.trim()
      || typeof diner.idNo !== 'string' || !normalizeIdNo(diner.idNo) || typeof diner.id !== 'string' || !diner.id
      || !Array.isArray(diner.dishLineIds) || diner.dishLineIds.some(id => typeof id !== 'string') || ids.has(diner.id)) {
      blockers.push({ code: 'invalid-diner', message: 'Review the Senior / PWD list. Each person needs a name, ID and their own entry.' });
      continue;
    }
    const normalized = normalizeIdNo(diner.idNo);
    if (people.has(normalized)) blockers.push({ code: 'duplicate-id', message: 'That ID is recorded more than once. One person can claim only once.' });
    ids.add(diner.id); people.add(normalized);
  }
  if (blockers.length) return blockers;
  if (!positiveCount(input.heads)) blockers.push({ code: 'head-count-required', message: 'Enter the number of diners before payment.' });
  else if (input.diners.length > (input.heads ?? 0)) blockers.push({ code: 'diners-exceed-heads', message: 'There are more qualifying diners than people at the table. Review the list before payment.' });
  const shares = statutoryShares(input);
  for (const dinerId of shares.zeroShareDinerIds) blockers.push({ code: 'zero-share', dinerId,
    message: 'Mark at least one dish for each senior/PWD diner, or remove them.' });
  const a = lineAmounts(input.lines, { taxType: 'NON_VAT', taxRatePct: 0 });
  if (input.loyaltyRedemptions?.length && a.grossSubtotal.sub(a.lineDiscountsTotal).roundHalfUp() <= shares.totalCentavos) {
    blockers.push({ code: 'loyalty-remainder-zero', message: 'Points cannot be used when every diner gets the senior/PWD discount. Remove the points redemption before payment.',
      releaseRedemptionIds: input.loyaltyRedemptions.map(reward => reward.redemptionId) });
  }
  return blockers;
}
export function statutoryActivityEntry(action: 'add' | 'remove', diner: StatutoryDiner, actor: { uid: string }, nowMs: number) {
  return { type: action === 'add' ? 'statutory_diner_added' : 'statutory_diner_removed', byUid: actor.uid,
    atClientMs: nowMs, kind: diner.kind, idMasked: maskIdNo(diner.idNo) };
}
export function maskDinersForClosedSession(diners: StatutoryDiner[]): StatutoryDiner[] {
  return diners.map(diner => {
    const masked = { ...diner, idNo: maskIdNo(diner.idNo) };
    delete masked.idNoNormalized;
    return masked;
  });
}

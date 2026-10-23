import { allocate, allocateExact } from '@/lib/money/centavos';
import { lineAmounts } from '@/lib/money/line-amounts';
import { ZERO } from '@/lib/money/exact';
import type { SessionBillLine, StatutoryDiner } from '@/lib/types';

export interface StatutoryInput {
  diners: StatutoryDiner[];
  heads: number | null;
  package?: { isBundle?: boolean; bundleMaxCap?: number } | null;
}
interface DinerShare { dinerId: string; centavos: number; packageCentavos: number; dishCentavos: number; dishLineIds: string[] }
const units = (line: SessionBillLine) => Math.max(0, line.qtyOrdered - (line.voidedQty ?? 0) - (line.freeQty ?? 0));
export function statutoryShares(input: StatutoryInput & { lines: SessionBillLine[] }) {
  const { lines, diners, heads } = input;
  const settings = { taxType: 'NON_VAT' as const, taxRatePct: 0 };
  const bill = lineAmounts(lines, settings);
  const budget = Math.max(0, bill.grossSubtotal.roundHalfUp() - bill.lineDiscountsTotal.roundHalfUp());
  const weights = lines.map(line => {
    const amount = lineAmounts([line], settings);
    return amount.grossSubtotal.sub(amount.lineDiscountsTotal).max(ZERO);
  });
  const amounts = weights.some(weight => weight.gt(ZERO)) ? allocateExact(budget, weights) : weights.map(() => 0);
  const byId = new Map(lines.map((line, index) => [line.id, amounts[index] ?? 0]));
  const net = (line: SessionBillLine) => byId.get(line.id) ?? 0;
  const packageLine = lines.find(line => line.type === 'package');
  const extra = input.package?.isBundle ? lines.find(line => line.id.startsWith('bundleextra_')) : undefined;
  const covered = input.package?.isBundle
    ? Math.max(0, Math.min(heads ?? 0, input.package.bundleMaxCap ?? heads ?? 0))
    : packageLine ? Math.floor(units(packageLine)) : 0;
  const packageParts = packageLine && covered > 0 ? allocate(net(packageLine), Array(covered).fill(1)) : [];
  const extraCount = extra ? Math.floor(units(extra)) : 0;
  const extraParts = extra && extraCount > 0 ? allocate(net(extra), Array(extraCount).fill(1)) : [];
  const assigned = new Set<string>();
  const shares: DinerShare[] = diners.map((diner, index) => {
    const packageCentavos = index < covered ? packageParts[index] ?? 0 : extraParts[index - covered] ?? 0;
    const dishLineIds: string[] = [];
    let dishCentavos = 0;
    for (const id of diner.dishLineIds) {
      const line = lines.find(line => line.id === id && line.type === 'addon' && line !== extra && units(line) > 0);
      if (!line || assigned.has(id)) continue;
      assigned.add(id); dishLineIds.push(id); dishCentavos += net(line);
    }
    return { dinerId: diner.id, centavos: packageCentavos + dishCentavos, packageCentavos, dishCentavos, dishLineIds };
  });
  return { shares, totalCentavos: shares.reduce((sum, share) => sum + share.centavos, 0),
    zeroShareDinerIds: shares.filter(share => share.centavos === 0).map(share => share.dinerId) };
}
export function pruneDishAssignments(diners: StatutoryDiner[], lines: SessionBillLine[]): StatutoryDiner[] {
  const live = new Set(lines.filter(line => units(line) > 0).map(line => line.id));
  return diners.map(diner => ({ ...diner, dishLineIds: diner.dishLineIds.filter(id => live.has(id)) }));
}

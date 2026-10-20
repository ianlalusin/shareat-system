import { storedPesosToCentavos } from "@/lib/money/centavos";
import { Exact, HUNDRED, ONE, ZERO } from "@/lib/money/exact";
import type { Store, SessionBillLine, LineAdjustment } from "@/lib/types";

/** Shared T-423 exact line stages, before their bill-level rounding. */
export function lineAmounts(billLines: SessionBillLine[], store: Pick<Store, "taxRatePct" | "taxType">) {
  const pct = (x: unknown) => Exact.of(Number(x || 0)).div(HUNDRED);
  const taxRate = Exact.of(Number(store.taxRatePct || 0)).div(HUNDRED);
  const hasRate = taxRate.gt(ZERO);
  const onePlus = ONE.add(taxRate);
  const isVatInclusive = store.taxType === 'VAT_INCLUSIVE';
  const isVatExclusive = store.taxType === 'VAT_EXCLUSIVE';
  const storedC = (x: unknown) => Exact.int(storedPesosToCentavos(x));

  let grossSubtotal = ZERO;
  let lineDiscountsTotal = ZERO;
  let lineChargesTotal = ZERO;

  const activeLines = billLines.filter(line => {
    const qty = line.qtyOrdered - (line.voidedQty || 0);
    if (qty < 0) {
      console.warn(`[Tax] Line "${line.itemName}" has voidedQty (${line.voidedQty}) > qtyOrdered (${line.qtyOrdered}). Skipping.`);
      return false;
    }
    return qty > 0;
  });

  activeLines.forEach(line => {
    const billableQty = line.qtyOrdered - (line.voidedQty || 0) - (line.freeQty || 0);
    if (billableQty <= 0) return;

    const baseUnitOnly = Number.isFinite(Number(line.unitPrice)) ? Math.max(0, storedPesosToCentavos(Number(line.unitPrice))) : 0;
    // Modifiers contribute their priceDelta to the per-unit price. Modifier
    // selections live on the bill line at order time; see OptionGroup type.
    const modPerUnit = storedPesosToCentavos((line as any).modifiersTotal || 0);
    const unitPrice = Exact.int(baseUnitOnly + modPerUnit);
    const qty = Exact.of(billableQty);

    grossSubtotal = grossSubtotal.add(qty.mul(unitPrice));

    const baseUnitPrice = (isVatInclusive && hasRate) ? unitPrice.div(onePlus) : unitPrice;
    // Discounts apply to the gross (VAT-inclusive) shelf price; VAT is derived
    // afterward. For VAT-exclusive / non-VAT stores unitPrice already is net,
    // so this matches their existing behavior.
    const discountUnitBase = unitPrice;
    const adjs = Object.values((line as any).lineAdjustments ?? {}).sort((a: any, b: any) => (a.createdAtClientMs || 0) - (b.createdAtClientMs || 0)) as LineAdjustment[];
    const hasAdjDiscount = adjs.some(a => a.kind === "discount");

    let remainingQtyForDiscounts = billableQty;

    for (const adj of adjs) {
        if (adj.kind === "discount") {
            if (remainingQtyForDiscounts <= 0) continue;
            const qtyToApply = Math.min(Number(adj.qty || 0), remainingQtyForDiscounts);
            if (qtyToApply <= 0) continue;

            if (adj.type === "percent") {
                lineDiscountsTotal = lineDiscountsTotal.add(Exact.of(qtyToApply).mul(discountUnitBase).mul(pct(adj.value)));
            } else { // fixed
                lineDiscountsTotal = lineDiscountsTotal.add(discountUnitBase.min(storedC(Number(adj.value || 0))).mul(Exact.of(qtyToApply)));
            }
            remainingQtyForDiscounts -= qtyToApply;

        } else if (adj.kind === "charge") {
            const qtyToApply = Math.min(Number(adj.qty || 0), billableQty);
            if (qtyToApply <= 0) continue;

            if (adj.type === "percent") {
                lineChargesTotal = lineChargesTotal.add(Exact.of(qtyToApply).mul(baseUnitPrice).mul(pct(adj.value)));
            } else { // fixed
                lineChargesTotal = lineChargesTotal.add(storedC(Number(adj.value || 0)).mul(Exact.of(qtyToApply)));
            }
        }
    }

    // Legacy fallback:
    if (!hasAdjDiscount && line.discountValue && line.discountValue > 0 && line.discountQty > 0) {
      const discountedQty = Exact.of(Math.min(line.discountQty, billableQty));

      if (line.discountType === "percent") {
        lineDiscountsTotal = lineDiscountsTotal.add(discountedQty.mul(discountUnitBase).mul(pct(line.discountValue)));
      } else { // fixed
        lineDiscountsTotal = lineDiscountsTotal.add(discountUnitBase.min(storedC(line.discountValue ?? 0)).mul(discountedQty));
      }
    }
  });

  return { grossSubtotal, lineDiscountsTotal, lineChargesTotal };
}

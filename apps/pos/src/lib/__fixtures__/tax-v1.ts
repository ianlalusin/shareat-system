
import type { SessionBillLine, Charge, Discount, Store, Adjustment, LineAdjustment } from "@/lib/types";

export interface TaxAndTotals {
  subtotal: number;
  taxableAmount: number; // The amount on which tax is calculated (net of discounts)
  taxTotal: number;
  lineDiscountsTotal: number;
  billDiscountTotal: number;
  loyaltyDiscountTotal: number; // Sharelebrator reward redeemed against this bill
  totalDiscounts: number;
  chargesTotal: number;
  grandTotal: number; // The final, gross amount due by the customer
  vatableSales: number;
  vatExemptSales: number;
}

/** Redeemed loyalty rewards applied to the bill as stacking discounts. */
export type LoyaltyDiscountInput = { type: "fixed" | "percent"; value: number }[] | null;

/** Rounds to 2 decimal places using standard half-up rounding. EPSILON avoids floating-point edge cases (e.g., 1.005 -> 1.01). */
function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}


/**
 * Calculates all billing totals, including tax, based on the store's tax settings.
 * @param billLines The array of all billable line items.
 * @param store The store object containing taxType and taxRatePct.
 * @param billDiscount An optional bill-wide discount.
 * @param customAdjustments An array of additional charges or fixed adjustments.
 * @returns A comprehensive object with all calculated totals.
 */
export function calculateBillTotals(
  billLines: SessionBillLine[],
  store: Store | null,
  billDiscount: Discount | null,
  customAdjustments: Adjustment[],
  loyaltyDiscount: LoyaltyDiscountInput = null
): TaxAndTotals {

  if (!store) {
    console.warn("[Tax] calculateBillTotals called with null store — returning zero totals. This may indicate a loading race.");
    return {
      subtotal: 0, taxableAmount: 0, taxTotal: 0, lineDiscountsTotal: 0,
      billDiscountTotal: 0, loyaltyDiscountTotal: 0, totalDiscounts: 0, chargesTotal: 0, grandTotal: 0,
      vatableSales: 0, vatExemptSales: 0
    };
  }

  const taxRate = (store.taxRatePct || 0) / 100;
  const isVatInclusive = store.taxType === 'VAT_INCLUSIVE';
  const isVatExclusive = store.taxType === 'VAT_EXCLUSIVE';

  let grossSubtotal = 0;
  let lineDiscountsTotal = 0;
  let lineChargesTotal = 0;
  let vatableSales = 0;
  let vatExemptSales = 0;
  let taxTotal = 0;

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

    const baseUnitOnly = Number.isFinite(Number(line.unitPrice)) ? Math.max(0, Number(line.unitPrice)) : 0;
    // Modifiers contribute their priceDelta to the per-unit price. Modifier
    // selections live on the bill line at order time; see OptionGroup type.
    const modPerUnit = Number((line as any).modifiersTotal || 0);
    const unitPrice = baseUnitOnly + modPerUnit;

    grossSubtotal += billableQty * unitPrice;

    const baseUnitPrice = (isVatInclusive && taxRate > 0) ? (unitPrice / (1 + taxRate)) : unitPrice;
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
                lineDiscountsTotal += (qtyToApply * discountUnitBase) * (Number(adj.value || 0) / 100);
            } else { // fixed
                lineDiscountsTotal += Math.min(discountUnitBase, Number(adj.value || 0)) * qtyToApply;
            }
            remainingQtyForDiscounts -= qtyToApply;

        } else if (adj.kind === "charge") {
            const qtyToApply = Math.min(Number(adj.qty || 0), billableQty);
            if (qtyToApply <= 0) continue;

            if (adj.type === "percent") {
                lineChargesTotal += (qtyToApply * baseUnitPrice) * (Number(adj.value || 0) / 100);
            } else { // fixed
                lineChargesTotal += Number(adj.value || 0) * qtyToApply;
            }
        }
    }

    // Legacy fallback:
    if (!hasAdjDiscount && line.discountValue && line.discountValue > 0 && line.discountQty > 0) {
      const discountedQty = Math.min(line.discountQty, billableQty);
      
      if (line.discountType === "percent") {
        lineDiscountsTotal += (discountedQty * discountUnitBase) * ((line.discountValue ?? 0) / 100);
      } else { // fixed
        lineDiscountsTotal += Math.min(discountUnitBase, (line.discountValue ?? 0)) * discountedQty;
      }
    }
  });
  
  grossSubtotal = round(grossSubtotal);
  lineDiscountsTotal = round(lineDiscountsTotal);
  lineChargesTotal = round(lineChargesTotal);

  // Bill-level discount (gross-world). A VAT-exempt (senior/PWD) bill discount
  // is special: the whole bill becomes VAT-exempt AND the discount (e.g. 20%) is
  // taken on the VAT-removed net price. It is handled as its own branch and is
  // not stacked with loyalty rewards.
  const isVatExemptBill = !!billDiscount?.vatExempt;
  let billDiscountTotal = 0;
  let loyaltyDiscountTotal = 0;

  if (isVatExemptBill && billDiscount) {
    const grossAfterLine = grossSubtotal - lineDiscountsTotal;
    const netBeforeExempt = (isVatInclusive && taxRate > 0)
      ? grossAfterLine / (1 + taxRate)
      : grossAfterLine;
    const exemptDiscount = billDiscount.type === "percent"
      ? netBeforeExempt * (billDiscount.value / 100)
      : Math.min(netBeforeExempt, billDiscount.value);
    billDiscountTotal = round(exemptDiscount);
    vatExemptSales = round(Math.max(0, netBeforeExempt - exemptDiscount));
    vatableSales = 0;
    taxTotal = 0;
  } else {
    if (billDiscount) {
      // Discount taken on the gross (VAT-inclusive) amount after line discounts.
      const discountBaseTotal = grossSubtotal - lineDiscountsTotal;
      if (billDiscount.type === 'percent') {
        billDiscountTotal = discountBaseTotal * (billDiscount.value / 100);
      } else { // fixed
        billDiscountTotal = Math.min(discountBaseTotal, billDiscount.value);
      }
    }
    billDiscountTotal = round(billDiscountTotal);

    // Loyalty rewards stack after line + bill discounts on the running remaining
    // gross. Multiple rewards compound on what's left. Reward values are gross
    // (peso off the shelf price), matching the corrected discount model.
    if (Array.isArray(loyaltyDiscount) && loyaltyDiscount.length > 0) {
      let remainingGross = grossSubtotal - lineDiscountsTotal - billDiscountTotal;
      for (const lr of loyaltyDiscount) {
        if (!lr || !(lr.value > 0) || remainingGross <= 0) continue;
        const amt = lr.type === "percent" ? remainingGross * (lr.value / 100) : Math.min(remainingGross, lr.value);
        loyaltyDiscountTotal += amt;
        remainingGross -= amt;
      }
    }
    loyaltyDiscountTotal = round(Math.max(0, loyaltyDiscountTotal));
  }

  const totalDiscounts = lineDiscountsTotal + billDiscountTotal + loyaltyDiscountTotal;
  const netSalesAfterAllDiscounts = isVatExemptBill ? vatExemptSales : (grossSubtotal - totalDiscounts);

  if (!isVatExemptBill) {
    if (isVatInclusive) {
        vatableSales = netSalesAfterAllDiscounts / (1 + taxRate);
        taxTotal = netSalesAfterAllDiscounts - vatableSales;
    } else if (isVatExclusive) {
        vatableSales = netSalesAfterAllDiscounts;
        taxTotal = vatableSales * taxRate;
    } else { // NON_VAT
        vatableSales = netSalesAfterAllDiscounts;
        taxTotal = 0;
    }
  }

  // Corrected grand total calculation (VAT-exclusive adds tax on top of net).
  const totalBeforeCharges = (isVatExclusive && !isVatExemptBill)
    ? netSalesAfterAllDiscounts + taxTotal
    : netSalesAfterAllDiscounts;

  const billChargesTotal = customAdjustments.reduce((sum, charge) => {
    const value = Number(charge.amount || 0);
    if (charge.type === "percent") {
      const base = charge.appliesTo === "total" ? totalBeforeCharges : netSalesAfterAllDiscounts;
      return sum + base * (value / 100);
    }
    return sum + value;
  }, 0);

  const chargesTotal = round(billChargesTotal + lineChargesTotal);

  const grandTotal = totalBeforeCharges + chargesTotal;

  return {
    subtotal: grossSubtotal,
    taxableAmount: round(vatableSales), 
    taxTotal: round(taxTotal),
    lineDiscountsTotal: lineDiscountsTotal,
    billDiscountTotal: billDiscountTotal,
    loyaltyDiscountTotal: loyaltyDiscountTotal,
    totalDiscounts: round(totalDiscounts),
    chargesTotal,
    grandTotal: round(grandTotal),
    vatableSales: round(vatableSales),
    vatExemptSales: round(vatExemptSales),
  };
}

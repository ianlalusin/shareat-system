import { storedPesosToCentavos, toWirePesos } from "@/lib/money/centavos";
import { Exact, HUNDRED, ONE, ZERO } from "@/lib/money/exact";
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

/** The same eleven totals as whole centavos (T-423 Ruling 2). */
export type TaxAndTotalsCentavos = TaxAndTotals;

const ZERO_TOTALS: TaxAndTotalsCentavos = {
  subtotal: 0, taxableAmount: 0, taxTotal: 0, lineDiscountsTotal: 0,
  billDiscountTotal: 0, loyaltyDiscountTotal: 0, totalDiscounts: 0, chargesTotal: 0, grandTotal: 0,
  vatableSales: 0, vatExemptSales: 0,
};

/**
 * Bill totals in INTEGER CENTAVOS. Same stages and the same rounding points as POS v1's `calculateBillTotals`
 * (gross subtotal, line discounts, line charges, the VAT split, bill discount, loyalty, charges, grand total), but the
 * arithmetic between those points is exact (fractions), so float error cannot move a centavo. Stored peso inputs enter
 * through `storedPesosToCentavos`; percents and rates are read as exact decimals. Percent charges on "total" use the
 * UNROUNDED tax, as v1 does.
 */
export function calculateBillTotalsCentavos(
  billLines: SessionBillLine[],
  store: Store | null,
  billDiscount: Discount | null,
  customAdjustments: Adjustment[],
  loyaltyDiscount: LoyaltyDiscountInput = null
): TaxAndTotalsCentavos {

  if (!store) {
    console.warn("[Tax] calculateBillTotals called with null store — returning zero totals. This may indicate a loading race.");
    return { ...ZERO_TOTALS };
  }

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

  const subtotalC = grossSubtotal.roundHalfUp();
  const lineDiscountsC = lineDiscountsTotal.roundHalfUp();
  const lineChargesC = lineChargesTotal.roundHalfUp();
  const grossAfterLine = Exact.int(subtotalC - lineDiscountsC);

  // Bill-level discount (gross-world). A VAT-exempt (senior/PWD) bill discount
  // is special: the whole bill becomes VAT-exempt AND the discount (e.g. 20%) is
  // taken on the VAT-removed net price. It is handled as its own branch and is
  // not stacked with loyalty rewards.
  const isVatExemptBill = !!billDiscount?.vatExempt;
  let billDiscountC = 0;
  let loyaltyDiscountC = 0;
  let vatExemptC = 0;
  let vatableSales = ZERO;
  let taxTotal = ZERO;

  if (isVatExemptBill && billDiscount) {
    const netBeforeExempt = (isVatInclusive && hasRate) ? grossAfterLine.div(onePlus) : grossAfterLine;
    const exemptDiscount = billDiscount.type === "percent"
      ? netBeforeExempt.mul(pct(billDiscount.value))
      : netBeforeExempt.min(storedC(billDiscount.value));
    billDiscountC = exemptDiscount.roundHalfUp();
    vatExemptC = netBeforeExempt.sub(exemptDiscount).max(ZERO).roundHalfUp();
  } else {
    if (billDiscount) {
      // Discount taken on the gross (VAT-inclusive) amount after line discounts.
      billDiscountC = (billDiscount.type === 'percent'
        ? grossAfterLine.mul(pct(billDiscount.value))
        : grossAfterLine.min(storedC(billDiscount.value))).roundHalfUp();
    }

    // Loyalty rewards stack after line + bill discounts on the running remaining
    // gross. Multiple rewards compound on what's left. Reward values are gross
    // (peso off the shelf price), matching the corrected discount model.
    if (Array.isArray(loyaltyDiscount) && loyaltyDiscount.length > 0) {
      let remainingGross = grossAfterLine.sub(Exact.int(billDiscountC));
      let sum = ZERO;
      for (const lr of loyaltyDiscount) {
        if (!lr || !(lr.value > 0) || !remainingGross.gt(ZERO)) continue;
        const amt = lr.type === "percent" ? remainingGross.mul(pct(lr.value)) : remainingGross.min(storedC(lr.value));
        sum = sum.add(amt);
        remainingGross = remainingGross.sub(amt);
      }
      loyaltyDiscountC = sum.max(ZERO).roundHalfUp();
    }
  }

  const totalDiscountsC = lineDiscountsC + billDiscountC + loyaltyDiscountC;
  const netSalesAfterAllDiscounts = isVatExemptBill ? Exact.int(vatExemptC) : Exact.int(subtotalC - totalDiscountsC);

  if (!isVatExemptBill) {
    if (isVatInclusive) {
        vatableSales = netSalesAfterAllDiscounts.div(onePlus);
        taxTotal = netSalesAfterAllDiscounts.sub(vatableSales);
    } else if (isVatExclusive) {
        vatableSales = netSalesAfterAllDiscounts;
        taxTotal = vatableSales.mul(taxRate);
    } else { // NON_VAT
        vatableSales = netSalesAfterAllDiscounts;
        taxTotal = ZERO;
    }
  }

  // Corrected grand total calculation (VAT-exclusive adds tax on top of net).
  const totalBeforeCharges = (isVatExclusive && !isVatExemptBill)
    ? netSalesAfterAllDiscounts.add(taxTotal)
    : netSalesAfterAllDiscounts;

  const billChargesTotal = customAdjustments.reduce((sum, charge) => {
    if (charge.type === "percent") {
      const base = charge.appliesTo === "total" ? totalBeforeCharges : netSalesAfterAllDiscounts;
      return sum.add(base.mul(pct(charge.amount)));
    }
    return sum.add(storedC(Number(charge.amount || 0)));
  }, ZERO);

  const chargesC = billChargesTotal.add(Exact.int(lineChargesC)).roundHalfUp();
  const grandTotalC = totalBeforeCharges.add(Exact.int(chargesC)).roundHalfUp();
  const vatableC = vatableSales.roundHalfUp();

  return {
    subtotal: subtotalC,
    taxableAmount: vatableC,
    taxTotal: taxTotal.roundHalfUp(),
    lineDiscountsTotal: lineDiscountsC,
    billDiscountTotal: billDiscountC,
    loyaltyDiscountTotal: loyaltyDiscountC,
    totalDiscounts: totalDiscountsC,
    chargesTotal: chargesC,
    grandTotal: grandTotalC,
    vatableSales: vatableC,
    vatExemptSales: vatExemptC,
  };
}

/**
 * Calculates all billing totals, including tax, based on the store's tax settings.
 * Same signature and keys as v1; every value is a peso number made from whole centavos (`toWirePesos`).
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
  const c = calculateBillTotalsCentavos(billLines, store, billDiscount, customAdjustments, loyaltyDiscount);
  return {
    subtotal: toWirePesos(c.subtotal),
    taxableAmount: toWirePesos(c.taxableAmount),
    taxTotal: toWirePesos(c.taxTotal),
    lineDiscountsTotal: toWirePesos(c.lineDiscountsTotal),
    billDiscountTotal: toWirePesos(c.billDiscountTotal),
    loyaltyDiscountTotal: toWirePesos(c.loyaltyDiscountTotal),
    totalDiscounts: toWirePesos(c.totalDiscounts),
    chargesTotal: toWirePesos(c.chargesTotal),
    grandTotal: toWirePesos(c.grandTotal),
    vatableSales: toWirePesos(c.vatableSales),
    vatExemptSales: toWirePesos(c.vatExemptSales),
  };
}

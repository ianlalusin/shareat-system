import { storedPesosToCentavos, toWirePesos } from "@/lib/money/centavos";
import { Exact, HUNDRED, ONE, ZERO } from "@/lib/money/exact";
import { lineAmounts } from '@/lib/money/line-amounts';
import { ordinaryBill } from '@/lib/money/ordinary-bill';
import { statutoryTotals } from '@/lib/statutory/totals';
import type { StatutoryInput } from '@/lib/statutory/shares';
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
  statutoryDiscountTotal: number;
  statutoryVatRemovedTotal: number;
  statutoryDiners: { dinerId: string; kind: 'senior' | 'pwd'; share: number; discount: number;
    vatRemoved: number; vatExempt: number; promoWasHigher: boolean }[];
}

/** Redeemed loyalty rewards applied to the bill as stacking discounts. */
export type LoyaltyDiscountInput = { type: "fixed" | "percent"; value: number }[] | null;

/** The same eleven totals as whole centavos (T-423 Ruling 2). */
export type TaxAndTotalsCentavos = TaxAndTotals;

const ZERO_TOTALS: TaxAndTotalsCentavos = {
  subtotal: 0, taxableAmount: 0, taxTotal: 0, lineDiscountsTotal: 0,
  billDiscountTotal: 0, loyaltyDiscountTotal: 0, totalDiscounts: 0, chargesTotal: 0, grandTotal: 0,
  vatableSales: 0, vatExemptSales: 0,
  statutoryDiscountTotal: 0, statutoryVatRemovedTotal: 0, statutoryDiners: [],
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
  loyaltyDiscount: LoyaltyDiscountInput = null,
  statutory: StatutoryInput | null = null
): TaxAndTotalsCentavos {

  if (!store) {
    console.warn("[Tax] calculateBillTotals called with null store — returning zero totals. This may indicate a loading race.");
    return { ...ZERO_TOTALS, statutoryDiners: [] };
  }

  const pct = (x: unknown) => Exact.of(Number(x || 0)).div(HUNDRED);
  const taxRate = Exact.of(Number(store.taxRatePct || 0)).div(HUNDRED);
  const hasRate = taxRate.gt(ZERO);
  const onePlus = ONE.add(taxRate);
  const isVatInclusive = store.taxType === 'VAT_INCLUSIVE';
  const isVatExclusive = store.taxType === 'VAT_EXCLUSIVE';
  const storedC = (x: unknown) => Exact.int(storedPesosToCentavos(x));

  const { grossSubtotal, lineDiscountsTotal, lineChargesTotal } = lineAmounts(billLines, store);

  const subtotalC = grossSubtotal.roundHalfUp();
  const lineDiscountsC = lineDiscountsTotal.roundHalfUp();
  const lineChargesC = lineChargesTotal.roundHalfUp();
  const grossAfterLine = Exact.int(subtotalC - lineDiscountsC);
  if (statutory?.diners.length) return statutoryTotals({ subtotalC, lineDiscountsC, lineChargesC,
    lines: billLines, store, promo: billDiscount, adjustments: customAdjustments, loyalty: loyaltyDiscount, statutory });

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
    const ordinary = ordinaryBill(grossAfterLine, store, billDiscount, loyaltyDiscount);
    billDiscountC = ordinary.billDiscountC; loyaltyDiscountC = ordinary.loyaltyDiscountC;
    vatableSales = ordinary.vatableSales; taxTotal = ordinary.taxTotal;
  }

  const totalDiscountsC = lineDiscountsC + billDiscountC + loyaltyDiscountC;
  const netSalesAfterAllDiscounts = isVatExemptBill ? Exact.int(vatExemptC) : Exact.int(subtotalC - totalDiscountsC);

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
    statutoryDiscountTotal: 0, statutoryVatRemovedTotal: 0, statutoryDiners: [],
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
  loyaltyDiscount: LoyaltyDiscountInput = null,
  statutory: StatutoryInput | null = null
): TaxAndTotals {
  const c = calculateBillTotalsCentavos(billLines, store, billDiscount, customAdjustments, loyaltyDiscount, statutory);
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
    statutoryDiscountTotal: toWirePesos(c.statutoryDiscountTotal),
    statutoryVatRemovedTotal: toWirePesos(c.statutoryVatRemovedTotal),
    statutoryDiners: c.statutoryDiners.map(diner => ({ ...diner, share: toWirePesos(diner.share),
      discount: toWirePesos(diner.discount), vatRemoved: toWirePesos(diner.vatRemoved), vatExempt: toWirePesos(diner.vatExempt) })),
  };
}

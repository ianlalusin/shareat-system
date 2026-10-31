import type { ModeOfPayment } from "@/lib/types";

/**
 * The cash tenders a refund can be paid out in. A method is cash when its type is "cash" OR its name is exactly "Cash"
 * (the payment screen matches any name containing "cash"; that would also take "Gcash", wrong for paying money out). v1's live data labels Cash as type "other" at every store (found at Lipa, 31 Oct),
 * so the type alone matched nothing and the refund screen said "no cash payment method set up". Ian: ERP 2 will label cash as
 * "cash"; the name check then does nothing and can stay.
 */
export function refundCashMethods(methods: readonly ModeOfPayment[]): ModeOfPayment[] {
  return methods.filter(
    (m) =>
      m.isActive !== false &&
      !m.isArchived &&
      (String(m.type || "").toLowerCase() === "cash" || String(m.name || "").trim().toLowerCase() === "cash"),
  );
}

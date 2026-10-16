// Single source of truth for "what tender is this order" across the online
// orders surfaces (admin route + admin client). The return value is an
// ANALYTICS KEY: it becomes the analyticsV2.mop key on the receipt written
// when an online order completes — i.e. a row in the daily sales report.
// Do not "improve" the wording of any returned string without realising you
// are renaming a revenue row that store owners reconcile against.
export function paymentLabel(order?: {
  payment?: { method?: string | null; methodLabel?: string | null } | null;
  fulfillment?: { type?: string | null } | null;
} | null): string {
  // A manually confirmed wallet transfer names the wallet the money actually
  // landed in. That string becomes the analyticsV2.mop key — i.e. a row in the
  // daily sales report — so it outranks the generic fallbacks below.
  const manual = order?.payment?.methodLabel;
  if (typeof manual === "string" && manual.trim()) return manual.trim();
  if (order?.payment?.method === "paymongo") return "Online (PayMongo)";
  return order?.fulfillment?.type === "delivery" ? "Cash on Delivery" : "Pay at Counter";
}

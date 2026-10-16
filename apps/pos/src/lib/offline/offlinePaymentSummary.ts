"use client";

export interface PaymentInput {
  methodId?: string;
  amount?: number;
}
export interface MopInput {
  id: string;
  name?: string;
  type?: string;
}
export interface PaymentSummary {
  mopMap: Record<string, number>;
  totalPaid: number;
  change: number;
}

/**
 * Pure tender/change validation + mode-of-payment breakdown for an offline
 * sale. Transcribed from the online completePaymentFromUnits balance/change
 * logic so offline and online agree. Amounts are in whole currency units;
 * `amountDueCents` is the bill total in cents. Throws on underpayment, on
 * change without a cash tender, or on change exceeding the cash tendered.
 */
export function buildOfflinePaymentSummary(args: {
  payments: PaymentInput[];
  paymentMethods: MopInput[];
  amountDueCents: number;
}): PaymentSummary {
  const { payments, paymentMethods, amountDueCents } = args;

  const totalPaidCents = payments.reduce(
    (s, p) => s + Math.round(Number(p.amount || 0) * 100),
    0,
  );

  if (totalPaidCents < amountDueCents - 1) {
    throw new Error(
      `Cannot complete payment: balance is not zero. Paid: ₱${(totalPaidCents / 100).toFixed(2)}, Due: ₱${(amountDueCents / 100).toFixed(2)}`,
    );
  }

  const mopCentsMap: Record<string, number> = {};
  for (const payment of payments) {
    const method = paymentMethods.find((m) => m.id === payment.methodId);
    const key = method?.name || payment.methodId || "unknown";
    mopCentsMap[key] =
      (mopCentsMap[key] || 0) + Math.round(Number(payment.amount || 0) * 100);
  }

  const changeCents = Math.max(0, totalPaidCents - amountDueCents);
  if (changeCents > 1) {
    const cashMethod =
      paymentMethods.find((pm) => String(pm.type || "").toLowerCase() === "cash") ||
      paymentMethods.find((pm) => String(pm.name || "").toLowerCase().includes("cash"));
    let cashKey = cashMethod?.name;
    if (!cashKey) cashKey = Object.keys(mopCentsMap).find((k) => k.toLowerCase().includes("cash"));
    if (!cashKey || mopCentsMap[cashKey] == null) {
      throw new Error("Change exists but no Cash payment was included. Add Cash payment.");
    }
    if (mopCentsMap[cashKey] < changeCents) {
      throw new Error(
        `Invalid payment: change (₱${(changeCents / 100).toFixed(2)}) exceeds cash paid (₱${(mopCentsMap[cashKey] / 100).toFixed(2)}).`,
      );
    }
    mopCentsMap[cashKey] -= changeCents;
  }

  const mopMap: Record<string, number> = {};
  for (const [key, cents] of Object.entries(mopCentsMap)) mopMap[key] = cents / 100;

  return { mopMap, totalPaid: totalPaidCents / 100, change: changeCents / 100 };
}

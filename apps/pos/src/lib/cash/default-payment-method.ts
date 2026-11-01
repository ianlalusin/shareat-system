import { isCashTender } from "@/lib/receipts/refund-cash-methods";

/** The payment method a new payment line starts on: the store's cash method (type cash OR named exactly "Cash"; DEF-808), else the first method, else none. */
export function defaultPaymentMethodId(methods: readonly { id: string; name?: unknown; type?: unknown }[]): string {
  return (methods.find(isCashTender) ?? methods[0])?.id ?? "";
}

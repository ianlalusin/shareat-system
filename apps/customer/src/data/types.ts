import type { Money } from '@shareat/core/money';

/** Plain, diner-facing shapes. Names follow docs/GLOSSARY.md; money is always a string, never a float. */

export interface Store {
  id: string;
  name: string;
  /** Where happy diners are sent. `null` when the store has no Google review page yet. */
  googleReviewUrl: string | null;
}

export interface TableSession {
  sessionId: string;
  /** Stable per device: re-joining the same table from the same device gives the same id. */
  participantId: string;
  store: Store;
  tableLabel: string;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  /** `refill` items are included in the package and price `'0.00'`. */
  kind: 'addon' | 'refill';
  price: Money;
}

/** A cart/order line carries an item and a quantity only. Never a price: the server prices from its own menu. */
export interface OrderLine {
  itemId: string;
  qty: number;
}

export type OrderStatus = 'preparing' | 'partly_served' | 'served' | 'cancelled';

export interface Order {
  orderId: string;
  clientRequestId: string;
  lines: OrderLine[];
  status: OrderStatus;
  placedAt: number;
}

export interface BillLine {
  name: string;
  qty: number;
  amount: Money;
}

export interface Bill {
  lines: BillLine[];
  subtotal: Money;
  /** Always true: the final bill is made at the cashier. */
  isEstimate: true;
}

/** `reason` is plain text meant for the diner to read. */
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface FeedbackOutcome {
  managerAlerted: boolean;
  googleReviewUrl: string | null;
}

export interface SignUpInput {
  name: string;
  phone: string;
  password: string;
  code: string;
  consent: boolean;
}

export interface Member {
  name: string;
  phone: string;
}

/** Pushed to subscribers when an order of the session changes. */
export interface OrderEvent {
  orderId: string;
  status: OrderStatus;
}

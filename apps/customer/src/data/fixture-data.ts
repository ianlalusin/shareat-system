import { fromCentavos, multiply, toCentavos, ZERO, type Money } from '@shareat/core/money';
import type { CustomerData } from './customer-data';
import { DEMO_MENU, DEMO_STORES, DEMO_TABLES, type DemoTable } from './fixtures';
import type { Bill, BillLine, Member, Order, OrderEvent, OrderStatus, Result, Store, TableSession } from './types';

/**
 * In-memory sample data behind the CustomerData door. It enforces the rules the P3 server must own (T-437 spec,
 * ADR-015 A6): per-device PIN lock, seat limit, idempotent orders, bill only for served food, one feedback per
 * diner, consent-gated sign-up, generic sign-in refusals with a lockout. One instance per page load; a reload
 * forgets everything, which the screens handle as "join a table first".
 */

export const PIN_TRIES = 5;
export const PIN_LOCK_MS = 5 * 60_000;
export const SEATS_PER_TABLE = 4;
export const SIGN_IN_TRIES = 5;
export const SIGN_IN_LOCK_MS = 15 * 60_000;
export const MAX_ORDER_QTY = 20;

export interface FixtureCustomerData extends CustomerData {
  /** Demo only: preparing -> partly_served -> served. Not part of the CustomerData interface. */
  advanceOrderForDemo(orderId: string): Promise<void>;
  /** Demo only: marks an order cancelled. Not part of the CustomerData interface. */
  cancelOrderForDemo(orderId: string): Promise<void>;
}

const NOT_FOUND_PIN = 'That PIN did not match a table. Please check the 6 digits on your table.';
const BAD_PIN = 'A table PIN is 6 digits.';
const LOCKED_PIN = 'Too many wrong tries on this phone. Please wait a few minutes, or scan the table QR code instead.';
const FULL_TABLE = 'This table is full. Please ask the staff for help.';
const BAD_QR = 'That QR code is not a Shareat table code. Please try again or use the table PIN.';
const NO_SESSION = 'Join a table first.';
const SIGN_IN_FAIL = 'Phone number or password is not right.';
const BAD_PHONE = 'Please enter a mobile number like 09171234567.';
const HAS_ACCOUNT = 'That mobile number already has an account. Try signing in.';

const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
const succeed = <T>(value: T): Result<T> => ({ ok: true, value });

interface Session {
  sessionId: string;
  table: DemoTable;
  store: Store;
  /** deviceId -> participantId */
  seats: Map<string, string>;
}

interface Account {
  name: string;
  phone: string;
  password: string;
}

interface Throttle {
  fails: number;
  lockedUntil: number;
}

export function createFixtureCustomerData(options?: { now?: () => number }): FixtureCustomerData {
  const now = options?.now ?? (() => Date.now());

  const sessions = new Map<string, Session>();
  const sessionByTable = new Map<DemoTable, Session>();
  const orders = new Map<string, Order & { sessionId: string }>();
  const orderIdByRequest = new Map<string, string>();
  const feedbackDone = new Set<string>();
  const accounts = new Map<string, Account>();
  const codes = new Map<string, string>();
  const pinThrottle = new Map<string, Throttle>();
  const signInThrottle = new Map<string, Throttle>();
  const listeners = new Map<string, Set<(event: OrderEvent) => void>>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const storeOf = (id: string): Store => DEMO_STORES.find((s) => s.id === id) ?? DEMO_STORES[0]!; // safe: DEMO_STORES is a non-empty constant
  const itemOf = (id: string) => DEMO_MENU.find((m) => m.id === id);

  function seat(table: DemoTable, deviceId: string): Result<TableSession> {
    let session = sessionByTable.get(table);
    if (!session) {
      session = { sessionId: nextId('sess'), table, store: storeOf(table.storeId), seats: new Map() };
      sessionByTable.set(table, session);
      sessions.set(session.sessionId, session);
    }
    let participantId = session.seats.get(deviceId);
    if (participantId === undefined) {
      if (session.seats.size >= SEATS_PER_TABLE) return fail(FULL_TABLE);
      participantId = nextId('diner');
      session.seats.set(deviceId, participantId);
    }
    return succeed({
      sessionId: session.sessionId,
      participantId,
      store: session.store,
      tableLabel: session.table.label,
    });
  }

  function notify(sessionId: string, event: OrderEvent) {
    for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(event);
  }

  function setStatus(orderId: string, status: OrderStatus) {
    const order = orders.get(orderId);
    if (!order || order.status === status) return;
    order.status = status;
    notify(order.sessionId, { orderId, status });
  }

  const publicOrder = (o: Order & { sessionId: string }): Order => ({
    orderId: o.orderId,
    clientRequestId: o.clientRequestId,
    lines: o.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
    status: o.status,
    placedAt: o.placedAt,
  });

  /** A lock that has run out starts a fresh count. */
  function clearExpired(t: Throttle | undefined) {
    if (t && t.lockedUntil !== 0 && now() >= t.lockedUntil) {
      t.fails = 0;
      t.lockedUntil = 0;
    }
  }

  function isLocked(t: Throttle | undefined): boolean {
    clearExpired(t);
    return t !== undefined && now() < t.lockedUntil;
  }

  function recordFail(map: Map<string, Throttle>, key: string, tries: number, lockMs: number) {
    const t = map.get(key) ?? { fails: 0, lockedUntil: 0 };
    clearExpired(t);
    t.fails += 1;
    if (t.fails >= tries) t.lockedUntil = now() + lockMs;
    map.set(key, t);
  }

  return {
    async joinByPin(pin, deviceId) {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return fail(BAD_PIN);
      if (isLocked(pinThrottle.get(deviceId))) return fail(LOCKED_PIN);
      const table = DEMO_TABLES.find((t) => t.pin === pin);
      if (!table) {
        recordFail(pinThrottle, deviceId, PIN_TRIES, PIN_LOCK_MS);
        return fail(NOT_FOUND_PIN);
      }
      pinThrottle.delete(deviceId);
      return seat(table, deviceId);
    },

    async joinByQr(qrToken, deviceId) {
      const table = DEMO_TABLES.find((t) => t.qrToken === qrToken);
      if (!table) return fail(BAD_QR);
      return seat(table, deviceId);
    },

    async getMenu(sessionId) {
      if (!sessions.has(sessionId)) return fail(NO_SESSION);
      return succeed(DEMO_MENU.map((m) => ({ ...m })));
    },

    async placeOrder(sessionId, lines, clientRequestId) {
      if (!sessions.has(sessionId)) return fail(NO_SESSION);
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
        return fail('Something went wrong sending your order. Please try again.');
      }
      const seen = orderIdByRequest.get(`${sessionId}|${clientRequestId}`);
      if (seen !== undefined) return succeed(publicOrder(orders.get(seen)!)); // safe: orderIdByRequest only holds ids that were put in orders
      if (!Array.isArray(lines) || lines.length === 0) return fail('Your cart is empty.');
      const clean: { itemId: string; qty: number }[] = [];
      for (const line of lines) {
        const item = line && typeof line.itemId === 'string' ? itemOf(line.itemId) : undefined;
        if (!item) return fail('One of the items is no longer on the menu.');
        const qty: unknown = line.qty;
        if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_ORDER_QTY) {
          return fail(`Please order between 1 and ${MAX_ORDER_QTY} of each item.`);
        }
        // Only the item id and the quantity are kept. Any price a client sends is dropped here.
        clean.push({ itemId: item.id, qty });
      }
      const order = {
        orderId: nextId('order'),
        clientRequestId,
        lines: clean,
        status: 'preparing' as OrderStatus,
        placedAt: now(),
        sessionId,
      };
      orders.set(order.orderId, order);
      orderIdByRequest.set(`${sessionId}|${clientRequestId}`, order.orderId);
      return succeed(publicOrder(order));
    },

    async getOrders(sessionId) {
      if (!sessions.has(sessionId)) return fail(NO_SESSION);
      return succeed([...orders.values()].filter((o) => o.sessionId === sessionId).map(publicOrder));
    },

    async getBill(sessionId) {
      if (!sessions.has(sessionId)) return fail(NO_SESSION);
      // Bill on serve: only food that reached the table counts. Cancelled and still-preparing orders add nothing.
      const qtyByItem = new Map<string, number>();
      for (const o of orders.values()) {
        if (o.sessionId !== sessionId) continue;
        if (o.status !== 'served' && o.status !== 'partly_served') continue;
        for (const l of o.lines) {
          const billed = o.status === 'served' ? l.qty : Math.floor(l.qty / 2);
          if (billed > 0) qtyByItem.set(l.itemId, (qtyByItem.get(l.itemId) ?? 0) + billed);
        }
      }
      const lines: BillLine[] = [];
      let subtotalCentavos = 0n;
      for (const [itemId, qty] of qtyByItem) {
        const item = itemOf(itemId);
        if (!item || item.kind === 'refill') continue; // refills are included in the package
        const amount: Money = multiply(item.price, qty);
        subtotalCentavos += toCentavos(amount);
        lines.push({ name: item.name, qty, amount });
      }
      const bill: Bill = {
        lines,
        subtotal: lines.length === 0 ? ZERO : fromCentavos(subtotalCentavos),
        isEstimate: true,
      };
      return succeed(bill);
    },

    async submitFeedback(sessionId, participantId, rating, text) {
      const session = sessions.get(sessionId);
      if (!session) return fail(NO_SESSION);
      if (![...session.seats.values()].includes(participantId)) return fail(NO_SESSION);
      if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return fail('Please choose 1 to 5 stars.');
      }
      if (typeof text !== 'string' || text.length > 500) return fail('Please keep your comment under 500 letters.');
      const key = `${sessionId}|${participantId}`;
      if (feedbackDone.has(key)) return fail('You already sent your feedback. Thank you!');
      feedbackDone.add(key);
      return succeed({
        managerAlerted: rating <= 2,
        googleReviewUrl: rating >= 4 ? session.store.googleReviewUrl : null,
      });
    },

    async requestSignUpCode(phone) {
      if (typeof phone !== 'string' || !/^09\d{9}$/.test(phone)) return fail(BAD_PHONE);
      // Same answer whether or not the number has an account (no member enumeration); signUp refuses duplicates.
      // Demo only: nothing is texted. The screen shows the code so the sign-up can be walked through.
      const code = String(100_000 + ((++seq * 7919) % 900_000));
      codes.set(phone, code);
      return succeed({ code });
    },

    async signUp(input) {
      if (!input || input.consent !== true) {
        return fail('Please tick the box to agree to the privacy notice.');
      }
      const { name, phone, password, code } = input;
      if (typeof phone !== 'string' || !/^09\d{9}$/.test(phone)) return fail(BAD_PHONE);
      if (typeof name !== 'string' || name.trim().length === 0) return fail('Please enter your name.');
      if (typeof password !== 'string' || password.length < 8) {
        return fail('Your password needs at least 8 letters or numbers.');
      }
      if (codes.get(phone) === undefined || codes.get(phone) !== code) {
        return fail('That code is not right. Please check it and try again.');
      }
      if (accounts.has(phone)) return fail(HAS_ACCOUNT);
      // Demo only: the fixture is in memory and keeps the password as typed. The real server stores a hash.
      accounts.set(phone, { name: name.trim(), phone, password });
      codes.delete(phone);
      const member: Member = { name: name.trim(), phone };
      return succeed(member);
    },

    async signIn(phone, password) {
      if (isLocked(signInThrottle.get(phone))) return fail(SIGN_IN_FAIL);
      const account = accounts.get(phone);
      if (!account || account.password !== password) {
        recordFail(signInThrottle, phone, SIGN_IN_TRIES, SIGN_IN_LOCK_MS);
        return fail(SIGN_IN_FAIL);
      }
      signInThrottle.delete(phone);
      return succeed({ name: account.name, phone: account.phone });
    },

    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      const mine = set;
      mine.add(listener);
      return () => {
        mine.delete(listener);
      };
    },

    async advanceOrderForDemo(orderId) {
      const order = orders.get(orderId);
      if (!order) return;
      if (order.status === 'preparing') setStatus(orderId, 'partly_served');
      else if (order.status === 'partly_served') setStatus(orderId, 'served');
    },

    async cancelOrderForDemo(orderId) {
      setStatus(orderId, 'cancelled');
    },
  };
}

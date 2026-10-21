'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { newId } from '@/lib/ids';
import * as cartOps from '@/lib/cart';
import type { Cart } from '@/lib/cart';
import type { CustomerData } from './customer-data';
import { createFixtureCustomerData } from './fixture-data';
import { DEMO_STORES, DEMO_TABLES } from './fixtures';
import type { OrderEvent, TableSession } from './types';

/**
 * Holds the one CustomerData, this browser's deviceId, the joined table session and the cart. Screens reach data only
 * through the hooks below; no screen imports the fixture. Session and device id are read in useEffect (never while
 * rendering) so the pre-rendered HTML always matches the first browser render. Storage is wrapped in try/catch
 * because private windows and some webviews refuse it. Money is never stored here: the session holds text only.
 */

const SESSION_KEY = 'shareat.customer.session';
const DEVICE_KEY = 'shareat.customer.device';

export interface DemoControls {
  advanceOrder(orderId: string): Promise<void>;
  /** Sample tables so a tester can walk in without a printed PIN. */
  tables: { label: string; storeName: string; pin: string; qrToken: string }[];
}

export interface Notice {
  id: number;
  text: string;
}

interface Ctx {
  data: CustomerData;
  demo: DemoControls | null;
  deviceId: string | null;
  /** True once the browser storage has been read. Before that, screens show a loading line, not "Join a table first". */
  ready: boolean;
  session: TableSession | null;
  setSession(session: TableSession | null): void;
  cart: Cart;
  addToCart(itemId: string): void;
  setCartQty(itemId: string, qty: number): void;
  removeFromCart(itemId: string): void;
  clearCart(): void;
  notice: Notice | null;
  dismissNotice(): void;
}

const CustomerContext = createContext<Ctx | null>(null);

function readStorage(kind: 'local' | 'session', key: string): string | null {
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage;
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: 'local' | 'session', key: string, value: string | null): void {
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* storage unavailable: the visit simply is not remembered after a reload */
  }
}

function parseSession(raw: string | null): TableSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TableSession> | null;
    if (
      v &&
      typeof v.sessionId === 'string' &&
      typeof v.participantId === 'string' &&
      typeof v.tableLabel === 'string' &&
      v.store &&
      typeof v.store.id === 'string' &&
      typeof v.store.name === 'string'
    ) {
      return v as TableSession;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const STATUS_TEXT: Record<OrderEvent['status'], string> = {
  preparing: 'Your order is being prepared.',
  partly_served: 'Part of your order is on its way to the table.',
  served: 'Your order has been served. Enjoy!',
  cancelled: 'An order was cancelled by the store.',
};

export function CustomerProvider({ children, data: injected }: { children: ReactNode; data?: CustomerData }) {
  // One fixture per page load. The fixture is held in a ref so React strict mode never builds two.
  const fixtureRef = useRef<ReturnType<typeof createFixtureCustomerData> | null>(null);
  if (!injected && !fixtureRef.current) fixtureRef.current = createFixtureCustomerData();
  const source: CustomerData = injected ?? fixtureRef.current!; // safe: the line above fills the ref whenever nothing was injected

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [session, setSessionState] = useState<TableSession | null>(null);
  const [cart, setCart] = useState<Cart>(cartOps.emptyCart);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeSeq = useRef(0);

  const setSession = useCallback((next: TableSession | null) => {
    setSessionState(next);
    writeStorage('session', SESSION_KEY, next ? JSON.stringify(next) : null);
    if (!next) setCart(cartOps.emptyCart());
  }, []);

  // Read browser storage after the first render. A stored session that the data source no longer knows
  // (the fixture forgets everything on reload) is dropped here.
  useEffect(() => {
    let id = readStorage('local', DEVICE_KEY);
    if (!id) {
      id = newId('dev');
      writeStorage('local', DEVICE_KEY, id);
    }
    setDeviceId(id);
    const stored = parseSession(readStorage('session', SESSION_KEY));
    if (!stored) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void source.getMenu(stored.sessionId).then((r) => {
      if (cancelled) return;
      if (r.ok) setSessionState(stored);
      else writeStorage('session', SESSION_KEY, null);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // The newest status change pushed for this table shows in the notice strip. No polling.
  const sessionId = session?.sessionId ?? null;
  useEffect(() => {
    if (!sessionId) return;
    return source.subscribe(sessionId, (event) => {
      noticeSeq.current += 1;
      setNotice({ id: noticeSeq.current, text: STATUS_TEXT[event.status] });
    });
  }, [source, sessionId]);

  // If a session-scoped call says "no", check whether the session itself is gone and, if so, forget it.
  const data = useMemo<CustomerData>(() => {
    const guard = async <T extends { ok: boolean }>(id: string, run: () => Promise<T>): Promise<T> => {
      const result = await run();
      if (!result.ok) {
        const probe = await source.getMenu(id);
        if (!probe.ok) setSession(null);
      }
      return result;
    };
    return {
      joinByPin: (pin, device) => source.joinByPin(pin, device),
      joinByQr: (token, device) => source.joinByQr(token, device),
      getMenu: (id) => guard(id, () => source.getMenu(id)),
      placeOrder: (id, lines, rid) => guard(id, () => source.placeOrder(id, lines, rid)),
      getOrders: (id) => guard(id, () => source.getOrders(id)),
      getBill: (id) => guard(id, () => source.getBill(id)),
      submitFeedback: (id, pid, rating, text) => guard(id, () => source.submitFeedback(id, pid, rating, text)),
      requestSignUpCode: (phone) => source.requestSignUpCode(phone),
      signUp: (input) => source.signUp(input),
      signIn: (phone, password) => source.signIn(phone, password),
      subscribe: (id, listener) => source.subscribe(id, listener),
    };
  }, [source, setSession]);

  const demo = useMemo<DemoControls | null>(() => {
    const f = fixtureRef.current;
    if (injected || !f) return null;
    return {
      advanceOrder: (orderId) => f.advanceOrderForDemo(orderId),
      tables: DEMO_TABLES.map((t) => ({
        label: t.label,
        storeName: DEMO_STORES.find((st) => st.id === t.storeId)?.name ?? '',
        pin: t.pin,
        qrToken: t.qrToken,
      })),
    };
  }, [injected]);

  const value = useMemo<Ctx>(
    () => ({
      data,
      demo,
      deviceId,
      ready,
      session,
      setSession,
      cart,
      addToCart: (itemId) => setCart((c) => cartOps.addItem(c, itemId)),
      setCartQty: (itemId, qty) => setCart((c) => cartOps.setQty(c, itemId, qty)),
      removeFromCart: (itemId) => setCart((c) => cartOps.removeItem(c, itemId)),
      clearCart: () => setCart(cartOps.emptyCart()),
      notice,
      dismissNotice: () => setNotice(null),
    }),
    [data, demo, deviceId, ready, session, setSession, cart, notice],
  );

  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}

function useCtx(): Ctx {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error('CustomerProvider is missing above this screen.');
  return ctx;
}

export function useCustomerData(): CustomerData {
  return useCtx().data;
}

/** Non-null only when the data source is the sample fixture, so the demo buttons vanish with the real server. */
export function useDemoControls(): DemoControls | null {
  return useCtx().demo;
}

export function useSession() {
  const { session, setSession, deviceId, ready } = useCtx();
  return { session, setSession, deviceId, ready };
}

export function useCart() {
  const { cart, addToCart, setCartQty, removeFromCart, clearCart } = useCtx();
  return { cart, addToCart, setCartQty, removeFromCart, clearCart };
}

export function useNotice() {
  const { notice, dismissNotice } = useCtx();
  return { notice, dismissNotice };
}

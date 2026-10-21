'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { RequireSession } from '@/components/app-shell';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import { useCart, useCustomerData, useSession } from '@/data/provider';
import type { MenuItem } from '@/data/types';
import { newId } from '@/lib/ids';
import { peso } from '@/lib/format';
import { toOrderLines } from '@/lib/cart';
import { useLive } from '@/lib/use-live';

function CartScreen() {
  const router = useRouter();
  const data = useCustomerData();
  const { session } = useSession();
  const { cart, addToCart, setCartQty, removeFromCart, clearCart } = useCart();
  const menu = useLive<MenuItem[]>((d, id) => d.getMenu(id), false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per send attempt: a retry after a bad connection reuses it, so the store never gets two orders.
  const requestId = useRef<string | null>(null);
  // A changed cart is a new order, so it must get a new id.
  useEffect(() => {
    requestId.current = null;
  }, [cart]);

  const byId = new Map((menu.value ?? []).map((m) => [m.id, m]));

  async function send() {
    if (!session || busy || cart.lines.length === 0) return;
    setBusy(true);
    setError(null);
    requestId.current ??= newId('req');
    const r = await data.placeOrder(session.sessionId, toOrderLines(cart), requestId.current);
    setBusy(false);
    if (r.ok) {
      clearCart();
      router.push('/orders');
    } else {
      setError(r.reason);
    }
  }

  if (cart.lines.length === 0) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Your cart is empty</p>
        <p className="mt-1 text-sm text-muted-foreground">Add something from the menu.</p>
        <Link href="/menu" className="mt-4 inline-block">
          <span className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Back to the menu
          </span>
        </Link>
      </Card>
    );
  }

  return (
    <div>
      <PageTitle>Your cart</PageTitle>
      <div className="space-y-2">
        {cart.lines.map((line) => {
          const item = byId.get(line.itemId);
          return (
            <Card key={line.itemId} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="font-medium">{item?.name ?? 'Item'}</p>
                <p className="text-sm text-muted-foreground">{item ? (item.kind === 'refill' ? 'Included' : peso(item.price)) : ''}</p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="secondary" aria-label="One less" className="w-11 px-0" onClick={() => setCartQty(line.itemId, line.qty - 1)}>
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-6 text-center font-semibold">{line.qty}</span>
                <Button variant="secondary" aria-label="One more" className="w-11 px-0" onClick={() => addToCart(line.itemId)}>
                  <Plus className="h-4 w-4" />
                </Button>
                <Button variant="ghost" aria-label="Remove" className="w-11 px-0" onClick={() => removeFromCart(line.itemId)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">Prices are checked by the store when your order arrives.</p>
      {error ? (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
      <Button className="mt-4 w-full" onClick={() => void send()} disabled={busy}>
        {busy ? 'Sending...' : 'Send order'}
      </Button>
    </div>
  );
}

export default function Page() {
  return (
    <RequireSession>
      <CartScreen />
    </RequireSession>
  );
}

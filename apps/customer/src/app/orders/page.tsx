'use client';

import Link from 'next/link';
import { RequireSession } from '@/components/app-shell';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import { useDemoControls } from '@/data/provider';
import type { MenuItem, Order, OrderStatus } from '@/data/types';
import { useLive } from '@/lib/use-live';

const STATUS_LABEL: Record<OrderStatus, string> = {
  preparing: 'Preparing',
  partly_served: 'Partly served',
  served: 'Served',
  cancelled: 'Cancelled',
};

const STATUS_STYLE: Record<OrderStatus, string> = {
  preparing: 'bg-primary/20',
  partly_served: 'bg-primary/40',
  served: 'bg-secondary',
  cancelled: 'bg-destructive/15 text-destructive',
};

function OrdersScreen() {
  const demo = useDemoControls();
  const orders = useLive<Order[]>((d, id) => d.getOrders(id));
  const menu = useLive<MenuItem[]>((d, id) => d.getMenu(id), false);
  const nameOf = new Map((menu.value ?? []).map((m) => [m.id, m.name]));
  const list = [...(orders.value ?? [])].reverse();

  return (
    <div>
      <PageTitle hint="Updates show up here as the kitchen serves your order.">Your orders</PageTitle>
      {orders.error ? <ErrorLine>{orders.error}</ErrorLine> : null}
      {!orders.loading && list.length === 0 && !orders.error ? (
        <Card className="text-center">
          <p className="font-semibold">No orders yet</p>
          <Link href="/menu" className="mt-3 inline-block">
            <span className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
              Browse the menu
            </span>
          </Link>
        </Card>
      ) : null}
      <div className="space-y-3">
        {list.map((order, i) => (
          <Card key={order.orderId}>
            <div className="flex items-center justify-between">
              <p className="font-semibold">Order {list.length - i}</p>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {order.lines.map((l) => (
                <li key={l.itemId} className="flex justify-between">
                  <span>{nameOf.get(l.itemId) ?? 'Item'}</span>
                  <span className="text-muted-foreground">x {l.qty}</span>
                </li>
              ))}
            </ul>
            {demo && (order.status === 'preparing' || order.status === 'partly_served') ? (
              <Button variant="secondary" className="mt-3 w-full" onClick={() => void demo.advanceOrder(order.orderId)}>
                Demo: advance
              </Button>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireSession>
      <OrdersScreen />
    </RequireSession>
  );
}

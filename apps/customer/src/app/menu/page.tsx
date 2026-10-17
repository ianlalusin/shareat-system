'use client';

import { Minus, Plus } from 'lucide-react';
import { RequireSession } from '@/components/app-shell';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import { useCart, useSession } from '@/data/provider';
import type { MenuItem } from '@/data/types';
import { peso } from '@/lib/format';
import { useLive } from '@/lib/use-live';

function MenuScreen() {
  const { session } = useSession();
  const { cart, addToCart, setCartQty } = useCart();
  const menu = useLive<MenuItem[]>((data, id) => data.getMenu(id), false);

  const groups = new Map<string, MenuItem[]>();
  for (const item of menu.value ?? []) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);

  return (
    <div>
      <PageTitle hint={session ? `${session.store.name} - ${session.tableLabel}` : undefined}>Menu</PageTitle>
      {menu.error ? <ErrorLine>{menu.error}</ErrorLine> : null}
      {menu.loading ? <p className="py-6 text-center text-sm text-muted-foreground">Loading the menu...</p> : null}
      <div className="space-y-5">
        {[...groups.entries()].map(([category, items]) => (
          <section key={category} aria-label={category}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{category}</h3>
            <div className="space-y-2">
              {items.map((item) => {
                const qty = cart.lines.find((l) => l.itemId === item.id)?.qty ?? 0;
                return (
                  <Card key={item.id} className="flex items-center justify-between gap-3 p-3">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">{item.kind === 'refill' ? 'Included' : peso(item.price)}</p>
                    </div>
                    {qty > 0 ? (
                      <div className="flex items-center gap-1">
                        <Button variant="secondary" aria-label={`One less ${item.name}`} className="w-11 px-0" onClick={() => setCartQty(item.id, qty - 1)}>
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="w-6 text-center font-semibold">{qty}</span>
                        <Button aria-label={`One more ${item.name}`} className="w-11 px-0" onClick={() => addToCart(item.id)}>
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <Button aria-label={`Add ${item.name}`} onClick={() => addToCart(item.id)}>
                        Add
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <RequireSession>
      <MenuScreen />
    </RequireSession>
  );
}

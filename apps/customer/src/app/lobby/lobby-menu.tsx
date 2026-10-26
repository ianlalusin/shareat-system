'use client';

import { Card } from '@/components/ui';
import { useCustomerData, useSession } from '@/data/provider';
import type { MenuItem } from '@/data/types';
import { peso } from '@/lib/format';
import { useEffect, useState } from 'react';

/**
 * T-455 S4 - the read-only menu on the lobby screen, from the customer app's existing menu data layer (the same getMenu the /menu screen reads).
 * That layer is keyed by a joined table; a diner still in the line has none, so until a lobby menu read exists the section says so instead of guessing.
 */
export function useLobbyMenu(): { items: MenuItem[] | null; loading: boolean } {
  const data = useCustomerData();
  const { session } = useSession();
  const sessionId = session?.sessionId ?? null;
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [loading, setLoading] = useState(sessionId !== null);

  useEffect(() => {
    if (!sessionId) {
      setItems(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void data.getMenu(sessionId).then((r) => {
      if (!alive) return;
      setItems(r.ok ? r.value : null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [data, sessionId]);

  return { items, loading };
}

export function LobbyMenu() {
  const { items, loading } = useLobbyMenu();
  if (loading) return <p className="py-4 text-center text-sm text-muted-foreground">Loading the menu...</p>;
  if (!items || items.length === 0) {
    return (
      <Card className="text-center">
        <p className="text-sm text-muted-foreground">The menu is shown here once you are at your table.</p>
      </Card>
    );
  }
  const groups = new Map<string, MenuItem[]>();
  for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([category, list]) => (
        <section key={category} aria-label={category}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{category}</h3>
          <div className="space-y-2">
            {list.map((item) => (
              <Card key={item.id} className="flex items-center justify-between gap-3 p-3">
                <p className="font-medium">{item.name}</p>
                <p className="text-sm text-muted-foreground">{item.kind === 'refill' ? 'Included' : peso(item.price)}</p>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

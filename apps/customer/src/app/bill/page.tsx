'use client';

import { RequireSession } from '@/components/app-shell';
import { Card, ErrorLine, PageTitle } from '@/components/ui';
import type { Bill } from '@/data/types';
import { peso } from '@/lib/format';
import { useLive } from '@/lib/use-live';

function BillScreen() {
  const bill = useLive<Bill>((d, id) => d.getBill(id));

  return (
    <div>
      <PageTitle hint="Estimate. Your final bill is at the cashier.">Your bill so far</PageTitle>
      {bill.error ? <ErrorLine>{bill.error}</ErrorLine> : null}
      {bill.value ? (
        <Card>
          {bill.value.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to add up yet. Food is added once it reaches your table.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {bill.value.lines.map((l) => (
                <li key={l.name} className="flex justify-between gap-3">
                  <span>
                    {l.name} <span className="text-muted-foreground">x {l.qty}</span>
                  </span>
                  <span>{peso(l.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex justify-between border-t border-border pt-3 font-bold">
            <span>Add-ons so far</span>
            <span>{peso(bill.value.subtotal)}</span>
          </div>
        </Card>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">Refills are included in your package and are not added here.</p>
    </div>
  );
}

export default function Page() {
  return (
    <RequireSession>
      <BillScreen />
    </RequireSession>
  );
}

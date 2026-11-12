'use client';

/**
 * T-527b - "Items so far" (new-order.png's right-hand side): the picked lines as qty x name, options, note and qty x display price, with a sum for the
 * cashier's eye. NOT a bill: no VAT and no discounts, and it says so. The server prices the real order. The sum is exact (@shareat/core/money).
 */
import { peso } from '@/lib/format';
import { cartRows, itemsSoFarSum } from './cart-sum';
import type { MenuLike } from './menu-filter';
import type { CartLine } from './payloads';

// Plain literals: the touch-target census reads them.
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const REMOVE = 'min-h-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

/** `pinTotal`: the caller shows the sum itself, pinned (ItemsSoFarTotal), so the list does not repeat it. */
export function ItemsSoFar({ cart, menu, heads, onChange, pinTotal = false, at }: { cart: CartLine[]; menu: MenuLike; heads: number | null; onChange: (cart: CartLine[]) => void; pinTotal?: boolean; at?: Date }) {
  const rows = cartRows(cart, menu, heads, at);
  const setQty = (index: number, qty: number) => onChange(qty < 1 ? cart.filter((_, i) => i !== index) : cart.map((l, i) => (i === index ? { ...l, qty } : l)));
  return (
    <section aria-label="Items so far" className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing picked yet. Tap a dish to add it.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={`${r.index}-${r.name}`} className="flex flex-col gap-2 border-b border-surface-border py-3 last:border-b-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-semibold">
                    {r.qty} × {r.name}
                  </p>
                  {r.bundleNote ? <p className="text-xs text-muted">{r.bundleNote}</p> : null}
                  {r.options.length > 0 ? <p className="text-xs text-muted">{r.options.join(', ')}</p> : null}
                  {r.note ? <p className="text-xs text-muted">Note: {r.note}</p> : null}
                </div>
                {r.unit !== null ? (
                  <p className="shrink-0 text-sm tabular-nums">
                    {r.qty} × {peso(r.unit)}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-end gap-2">
                {r.isPackage ? null : (
                  <>
                    <button type="button" data-erp-size="free" className={STEP} aria-label={`Fewer ${r.name}`} onClick={() => setQty(r.index, r.qty - 1)}>
                      −
                    </button>
                    <button type="button" data-erp-size="free" className={STEP} aria-label={`More ${r.name}`} onClick={() => setQty(r.index, r.qty + 1)}>
                      +
                    </button>
                  </>
                )}
                <button type="button" data-erp-size="free" className={REMOVE} aria-label={`Remove ${r.name}`} onClick={() => setQty(r.index, 0)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pinTotal ? null : <ItemsSoFarTotal cart={cart} menu={menu} heads={heads} at={at} />}
    </section>
  );
}

/** The running sum and its caveat; the panel pins it above the Send button (T-528 Addendum). */
export function ItemsSoFarTotal({ cart, menu, heads, at }: { cart: CartLine[]; menu: MenuLike; heads: number | null; at?: Date }) {
  const rows = cartRows(cart, menu, heads, at);
  return (
    <div className="border-t border-surface-border pt-3">
      <p className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-muted">Items so far</span>
        <span className="font-display text-2xl font-bold tabular-nums">{peso(itemsSoFarSum(rows))}</span>
      </p>
      <p className="mt-1 text-xs text-muted">Not the bill. VAT and discounts are added when the table pays.</p>
    </div>
  );
}

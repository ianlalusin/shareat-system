'use client';

/**
 * T-527 R4 - the menu picker (new-order.png): categories down the left, item tiles on the right, a choice sheet for an item with sizes or options, and the
 * (the running list of picks lives beside it: ItemsSoFar). Used by the seat dialog and by "Add items". It only builds a cart; the container turns it into one event.
 * An item that is sold out or not open yet shows greyed and cannot be tapped (row 307). Prices here are display only: the server sets the real price.
 */
import { useEffect, useMemo, useState } from 'react';
import { peso } from '@/lib/format';
import { asStoreMenu, closedPackages, closedPackagesText, displayUnitPrice, goneLines, isOptionChoiceValid, needsChoiceSheet, orderableVariants, pickerCatalog, type MenuLike, type PickerItem, type Variant } from './menu-filter';
import { POS_NOTICE_DISMISS_MS } from '../_shell/constants';
import { NOTE_MAX, type CartLine } from './payloads';

export interface MenuPickerProps {
  menu: MenuLike;
  /** A package session is open on this table (or the cart holds a package): items sold only inside a package session show up. */
  packageOpen: boolean;
  /** Take-out cannot hold a package (T-524 refuses it). */
  hidePackages?: boolean;
  /** What a package line will be billed for: the heads on the table. */
  heads: number | null;
  cart: CartLine[];
  onChange: (cart: CartLine[]) => void;
  /** T-559: the shell's menu clock. Prices and what is open are read at this instant (default: now), and the picker follows it across a daypart boundary. */
  at?: Date;
}

// Plain literals: the touch-target census reads them.
const CATEGORY = 'min-h-12 shrink-0 rounded-full border px-4 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ITEM = 'flex min-h-24 w-full flex-col justify-between gap-2 rounded-2xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed';
const CHOICE = 'min-h-12 rounded-2xl border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const STEP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface text-xl font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const PRIMARY = 'min-h-12 inline-flex items-center justify-center rounded-full border border-transparent bg-brand px-6 text-sm font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:bg-surface-border disabled:text-muted disabled:cursor-not-allowed';
const SECONDARY = 'min-h-12 inline-flex items-center justify-center rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const FIELD = 'min-h-12 w-full rounded-2xl border border-field-border bg-field px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

const chosen = 'border-ink bg-warning-soft text-ink';
const idle = 'border-surface-border bg-surface text-ink hover:bg-canvas';

const lowest = (item: PickerItem): Variant | undefined => orderableVariants(item).sort((a, b) => Number(displayUnitPrice(a, [], item.when)) - Number(displayUnitPrice(b, [], item.when)))[0];

function ChoiceSheet({ item, onAdd, onCancel }: { item: PickerItem; onAdd: (line: CartLine) => void; onCancel: () => void }) {
  const variants = orderableVariants(item);
  const [variantId, setVariantId] = useState((variants.find((v) => v.isDefault) ?? variants[0])!.id);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const variant = variants.find((v) => v.id === variantId) ?? variants[0]!; // the clock may have closed the chosen size while the sheet was open
  const ids = variant.optionGroups.flatMap((g) => picked[g.id] ?? []);
  const valid = variant.optionGroups.every((g) => isOptionChoiceValid(g, picked[g.id] ?? []));
  const isPackage = item.itemType === 'package';
  // Escape closes the innermost layer first: this sheet, before the panel behind it (the panel skips an Escape that was already handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bound once per open sheet
  }, []);
  const toggle = (groupId: string, valueId: string, single: boolean) =>
    setPicked((cur) => {
      const now = cur[groupId] ?? [];
      return { ...cur, [groupId]: now.includes(valueId) ? now.filter((x) => x !== valueId) : single ? [valueId] : [...now, valueId] };
    });
  return (
    <section aria-label={`Choose ${item.name}`} className="space-y-4 rounded-2xl border border-surface-border bg-surface p-4">
      <h3 className="text-lg font-semibold">{item.name}</h3>
      {variants.length > 1 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-muted">Size</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => (
              <button key={v.id} type="button" data-erp-size="free" aria-pressed={v.id === variantId} className={`${CHOICE} ${v.id === variantId ? chosen : idle}`} onClick={() => (setVariantId(v.id), setPicked({}))}>
                {v.label ?? 'Regular'} · {peso(displayUnitPrice(v, [], item.when))}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {variant.optionGroups.map((g) => (
        <fieldset key={g.id} className="space-y-2">
          <legend className="text-sm font-semibold text-muted">
            {g.name}
            {g.minSelections > 0 ? ' (choose)' : ' (optional)'}
          </legend>
          <div className="flex flex-wrap gap-2">
            {g.values
              .filter((v) => v.channels.store.orderable)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((v) => {
                const on = (picked[g.id] ?? []).includes(v.id);
                const more = !on && (picked[g.id] ?? []).length >= g.maxSelections && g.selectionMode === 'multi';
                return (
                  <button key={v.id} type="button" data-erp-size="free" aria-pressed={on} disabled={more} className={`${CHOICE} ${on ? chosen : idle} disabled:opacity-50`} onClick={() => toggle(g.id, v.id, g.selectionMode === 'single')}>
                    {v.name}
                    {v.channels.store.orderable && Number(v.channels.store.priceDelta) !== 0 ? ` · +${peso(v.channels.store.priceDelta)}` : ''}
                  </button>
                );
              })}
          </div>
        </fieldset>
      ))}
      {isPackage ? null : (
        <div className="flex items-center gap-3" role="group" aria-label="Quantity">
          <button type="button" data-erp-size="free" className={STEP} aria-label="Fewer" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
            −
          </button>
          <span className="min-w-8 text-center text-lg font-semibold tabular-nums">{qty}</span>
          <button type="button" data-erp-size="free" className={STEP} aria-label="More" onClick={() => setQty((q) => q + 1)}>
            +
          </button>
        </div>
      )}
      <label className="block space-y-2 text-sm font-semibold text-muted">
        <span className="block">Note (optional)</span>
        <input type="text" data-erp-size="free" className={FIELD} value={note} onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm tabular-nums text-muted">{peso(displayUnitPrice(variant, ids, item.when))}{isPackage ? ' / head' : ' each'}</p>
        <div className="flex gap-2">
          <button type="button" data-erp-size="free" className={SECONDARY} onClick={onCancel}>
            Back
          </button>
          <button
            type="button"
            data-erp-size="free"
            className={PRIMARY}
            disabled={!valid}
            aria-disabled={!valid}
            onClick={() => onAdd({ itemId: item.id, variantId: variant.id, qty: isPackage ? 1 : qty, ...(note.trim() ? { note: note.trim() } : {}), ...(ids.length > 0 ? { optionValueIds: ids } : {}) })}
          >
            Add to order
          </button>
        </div>
      </div>
    </section>
  );
}

export function MenuPicker({ menu, packageOpen, hidePackages, heads, cart, onChange, at }: MenuPickerProps) {
  const items = useMemo(() => asStoreMenu(menu).items, [menu]);
  const cartHasPackage = cart.some((l) => items.find((i) => i.id === l.itemId)?.itemType === 'package');
  // T-559: read at the shell's clock, so the list and its prices change at 17:00 with the cached menu and no network. `at` may be a new Date every render: its time is the key.
  const atMs = at?.getTime() ?? null;
  const clock = useMemo(() => (atMs === null ? new Date() : new Date(atMs)), [atMs]);
  const catalog = useMemo(
    () => pickerCatalog(menu, { packageOpen: packageOpen || cartHasPackage, takeOut: hidePackages === true, at: clock }),
    [menu, packageOpen, cartHasPackage, hidePackages, clock],
  );
  const closedLine = useMemo(() => closedPackagesText(closedPackages(menu, clock, { takeOut: hidePackages === true })), [menu, clock, hidePackages]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const active = catalog.find((c) => c.id === activeId) ?? catalog[0];
  // The sheet follows the clock: an item whose window closed under it drops back to the grid instead of pricing a closed window.
  const found = sheetId ? catalog.flatMap((c) => c.items).find((i) => i.id === sheetId) : undefined;
  const sheet = found?.orderable ? found : null;
  const setSheet = (item: PickerItem | null) => setSheetId(item?.id ?? null);
  // A package already picked whose window has since closed comes off the order, and the cashier is told (refills and a la carte lines are not judged).
  const gone = useMemo(() => goneLines(cart, menu, clock), [cart, menu, clock]);
  // The note dismisses itself (and goes with the panel when it closes: this state lives in the picker).
  useEffect(() => {
    if (note === null) return;
    const t = setTimeout(() => setNote(null), POS_NOTICE_DISMISS_MS);
    return () => clearTimeout(t);
  }, [note]);
  useEffect(() => {
    if (gone.length === 0) return;
    const names = gone.map((l) => items.find((i) => i.id === l.itemId)?.name ?? 'A package');
    setNote(`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} no longer offered, so ${names.length === 1 ? 'it was' : 'they were'} taken off the order.`);
    onChange(cart.filter((l) => !gone.includes(l)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires when the clock closes a window, not on every parent render
  }, [gone]);
  const countOf = (itemId: string) => cart.filter((l) => l.itemId === itemId).reduce((n, l) => n + (items.find((i) => i.id === itemId)?.itemType === 'package' ? (heads ?? 1) : l.qty), 0);

  const add = (line: CartLine) => {
    const isPackage = items.find((i) => i.id === line.itemId)?.itemType === 'package';
    const plain = (l: CartLine) => l.itemId === line.itemId && l.variantId === line.variantId && !l.note && !l.optionValueIds?.length;
    if (isPackage && cart.some((l) => l.itemId === line.itemId)) return; // one package line: it is billed per head
    setNote(null);
    if (!line.note && !line.optionValueIds?.length && cart.some(plain)) onChange(cart.map((l) => (plain(l) ? { ...l, qty: l.qty + line.qty } : l)));
    else onChange([...cart, line]);
  };
  const tap = (item: PickerItem) => {
    if (!item.orderable) return;
    if (needsChoiceSheet(item)) setSheet(item);
    else add({ itemId: item.id, variantId: orderableVariants(item)[0]!.id, qty: 1 });
  };

  if (catalog.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">There is nothing to order yet. The menu loads when the tablet is online.</p>
        {closedLine ? <p className="text-sm text-muted">{closedLine}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 md:flex-row">
        <nav aria-label="Menu categories" className="flex gap-2 overflow-x-auto md:w-48 md:shrink-0 md:flex-col">
          {catalog.map((c) => (
            <button key={c.id} type="button" data-erp-size="free" aria-pressed={c.id === active?.id} className={`${CATEGORY} ${c.id === active?.id ? 'border-ink bg-ink text-canvas' : idle}`} onClick={() => (setActiveId(c.id), setSheet(null))}>
              {c.name}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {sheet ? (
            <ChoiceSheet item={sheet} onCancel={() => setSheet(null)} onAdd={(line) => (add(line), setSheet(null))} />
          ) : (
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {(active?.items ?? []).map((item) => {
                const from = lowest(item);
                const n = countOf(item.id);
                return (
                  <li key={item.id}>
                    <button type="button" data-erp-size="free" disabled={!item.orderable} aria-disabled={!item.orderable} className={`${ITEM} ${item.orderable ? idle : 'border-dashed border-surface-border bg-canvas text-muted'}`} onClick={() => tap(item)}>
                      <span className="flex items-start justify-between gap-2">
                        <span className="font-semibold">{item.name}</span>
                        {n !== 0 ? <span className="rounded-full bg-brand px-2 text-xs font-bold text-white">{n}</span> : null}
                      </span>
                      <span className="text-sm tabular-nums text-muted">
                        {item.label ?? (from ? `${peso(displayUnitPrice(from, [], item.when))}${item.itemType === 'package' ? ' / head' : ''}` : '')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      {closedLine ? <p className="text-sm text-muted">{closedLine}</p> : null}
      {note ? (
        <p role="status" className="text-sm font-semibold text-ink">
          {note}
        </p>
      ) : null}
    </div>
  );
}

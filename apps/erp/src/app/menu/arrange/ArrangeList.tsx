'use client';
/**
 * T-651: one list on the Arrange menu screen, as numbered cards. The buttons are the way in on a tablet and from the keyboard: "Move Package up" /
 * "Move Package down" (44px tall). Dragging the grip does the same on a desktop (the pattern of settings/ai-hub/FallbackOrder.tsx: a pointer handler on the
 * grip, capture on the list, `touch-action: none` so a finger drags instead of scrolling).
 *
 * Nothing is saved until "Save" (the house label; each list sits under its own heading): the whole new order goes in one form to the server action (one transaction, one audit row). Rows in `pinned` are
 * not moved (the default size is always first on every screen) but are part of what is sent, because the server wants the whole list.
 * shortcut: no auto-scroll while dragging near the edge, upgrade if a list ever outgrows the screen (the buttons still work).
 */
import Link from 'next/link';
import { useRef, useState, type PointerEvent } from 'react';
import { SubmitButton } from '@/components/feedback/SubmitButton';

export interface ArrangeRow {
  id: string;
  label: string;
  /** A link to the next list down (a category's items, an item's sizes and options). */
  href?: string;
  /** A small line under the name. */
  note?: string;
  /** The row the page is showing the next list for. */
  selected?: boolean;
}

const BTN = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-[12px] border border-surface-border bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-40';
const GRIP = 'inline-flex min-h-11 min-w-11 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-full text-muted hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:cursor-grabbing';
const OPEN = 'inline-flex min-h-11 items-center text-sm underline underline-offset-4';

export function ArrangeList({
  rows,
  pinned = [],
  action,
  hidden,
  openLabel,
  noun,
}: {
  rows: ArrangeRow[];
  pinned?: ArrangeRow[];
  action: (fd: FormData) => Promise<void>;
  /** The record the list belongs to (the category, the item, the group), sent with the order. */
  hidden: Record<string, string>;
  openLabel?: string;
  /** "category", "item", "size", "option": used in the empty line. */
  noun: string;
}) {
  const start = rows.map((r) => r.id).join('\n');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const [ids, setIds] = useState(() => rows.map((r) => r.id));
  const [lifted, setLifted] = useState<string | null>(null);
  const live = useRef(ids);
  const drag = useRef<string | null>(null);
  const els = useRef(new Map<string, HTMLLIElement>());
  const list = useRef<HTMLOListElement>(null);
  const dirty = ids.join('\n') !== start;

  const put = (next: string[]) => {
    live.current = next;
    setIds(next);
  };
  const step = (id: string, by: -1 | 1) => {
    const from = live.current.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= live.current.length) return;
    const next = [...live.current];
    next.splice(from, 1);
    next.splice(to, 0, id);
    put(next);
  };
  const down = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    list.current?.setPointerCapture(e.pointerId);
    drag.current = id;
    setLifted(id);
  };
  const move = (e: PointerEvent<HTMLOListElement>) => {
    const id = drag.current;
    if (!id) return;
    const cur = live.current;
    let to = cur.length - 1;
    for (const [i, k] of cur.entries()) {
      const r = els.current.get(k)?.getBoundingClientRect();
      if (r && e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    const from = cur.indexOf(id);
    if (to === from) return;
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, id);
    put(next);
  };
  const up = (e: PointerEvent<HTMLOListElement>) => {
    drag.current = null;
    setLifted(null);
    if (list.current?.hasPointerCapture(e.pointerId)) list.current.releasePointerCapture(e.pointerId);
  };

  if (rows.length === 0 && pinned.length === 0) return <p className="text-sm text-muted">{`There is no ${noun} to arrange yet.`}</p>;
  return (
    <form action={action} className="space-y-3">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="ids" value={JSON.stringify([...pinned.map((r) => r.id), ...ids])} />
      <ol ref={list} className="space-y-2" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {pinned.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-dashed border-surface-border bg-canvas p-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold tabular-nums text-canvas" aria-hidden="true">
              1
            </span>
            <p className="min-w-0 flex-1 basis-40 break-words font-medium">{r.label}</p>
            <p className="text-sm text-muted">Always first</p>
          </li>
        ))}
        {ids.map((id, i) => {
          const r = byId.get(id);
          if (!r) return null;
          const n = pinned.length + i + 1;
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) els.current.set(id, el);
                else els.current.delete(id);
              }}
              aria-current={r.selected ? 'true' : undefined}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-surface p-3 ${lifted === id ? 'border-ink shadow-lg' : r.selected ? 'border-ink' : 'border-surface-border'}`}
            >
              <button type="button" className={GRIP} aria-label={`Drag ${r.label} to change its place`} onPointerDown={(e) => down(e, id)}>
                <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden="true" focusable="false">
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </button>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold tabular-nums text-canvas">
                <span className="sr-only">Number </span>
                {n}
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words font-medium">{r.label}</p>
                {r.note ? <p className="text-sm text-muted">{r.note}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BTN} aria-label={`Move ${r.label} up`} disabled={i === 0} onClick={() => step(id, -1)}>
                  <span aria-hidden="true">Up</span>
                </button>
                <button type="button" className={BTN} aria-label={`Move ${r.label} down`} disabled={i === ids.length - 1} onClick={() => step(id, 1)}>
                  <span aria-hidden="true">Down</span>
                </button>
                {r.href && openLabel ? (
                  <Link href={r.href} className={OPEN}>
                    {openLabel}
                    <span className="sr-only">{` of ${r.label}`}</span>
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…" disabled={!dirty}>
          Save
        </SubmitButton>
        {dirty ? <p className="text-sm text-muted">The new order is not saved yet.</p> : null}
      </div>
    </form>
  );
}

'use client';
/**
 * T-642: the fallback order as numbered, draggable cards. Number 1 is tried first, number 2 is the first fallback, and so on.
 *
 * Drag: a small pointer handler on each card's grip (mouse, pen and touch alike; the grip has `touch-action: none` so a finger drags instead of scrolling).
 * Pointer capture sits on the list, not the card, because a card that changes place in the list would lose its own capture. On release the whole new order goes in one
 * hidden form to `setModelOrderAction` (one transaction). Keyboard and phone: every card also has Move earlier / Move later (a real form each, so they work without a drag).
 * shortcut: no auto-scroll while dragging near the edge of the list, upgrade if the list ever outgrows the screen.
 */
import { useRef, useState, type PointerEvent } from 'react';
import { Badge } from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { deactivateModelAction, moveModelAction, setModelOrderAction, testModelAction } from './actions';
import { TestBadge } from './model-bits';

export interface OrderCard {
  provider: string;
  model: string;
  label: string;
  providerLabel: string;
  test: 'never' | 'passed' | 'failed';
  toolCalling: boolean | null;
}
const keyOf = (c: { provider: string; model: string }) => `${c.provider}/${c.model}`;

const GRIP = 'inline-flex min-h-11 min-w-11 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-full text-muted hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:cursor-grabbing';

export function FallbackOrder({ cards }: { cards: OrderCard[] }) {
  const byKey = new Map(cards.map((c) => [keyOf(c), c]));
  const [keys, setKeys] = useState(() => cards.map(keyOf));
  const [lifted, setLifted] = useState<string | null>(null);
  const live = useRef(keys);
  const drag = useRef<{ key: string; start: string } | null>(null);
  const els = useRef(new Map<string, HTMLLIElement>());
  const list = useRef<HTMLOListElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const down = (e: PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    list.current?.setPointerCapture(e.pointerId);
    drag.current = { key, start: live.current.join('\n') };
    setLifted(key);
  };
  const move = (e: PointerEvent<HTMLOListElement>) => {
    const d = drag.current;
    if (!d) return;
    const cur = live.current;
    let to = cur.length - 1;
    for (const [i, k] of cur.entries()) {
      const r = els.current.get(k)?.getBoundingClientRect();
      if (r && e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    const from = cur.indexOf(d.key);
    if (to === from) return;
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, d.key);
    live.current = next;
    setKeys(next);
  };
  const up = (e: PointerEvent<HTMLOListElement>) => {
    const d = drag.current;
    drag.current = null;
    setLifted(null);
    if (list.current?.hasPointerCapture(e.pointerId)) list.current.releasePointerCapture(e.pointerId);
    if (!d || live.current.join('\n') === d.start || !field.current) return;
    field.current.value = JSON.stringify(live.current);
    form.current?.requestSubmit();
  };

  return (
    <>
      <ol ref={list} className="space-y-2" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {keys.map((k, i) => {
          const c = byKey.get(k);
          if (!c) return null;
          return (
            <li
              key={k}
              ref={(el) => {
                if (el) els.current.set(k, el);
                else els.current.delete(k);
              }}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-surface p-3 ${lifted === k ? 'border-ink shadow-lg' : 'border-surface-border'}`}
            >
              <button type="button" className={GRIP} aria-label={`Drag ${c.label} to change its place in the order`} onPointerDown={(e) => down(e, k)}>
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
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p className="break-words font-medium">{c.label}</p>
                <p className="text-sm text-muted">{c.providerLabel}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info" label={i === 0 ? 'Tried first' : `Fallback ${i}`} />
                <TestBadge test={c.test} toolCalling={c.toolCalling} />
              </div>
              <div className="flex basis-full flex-wrap items-center gap-2">
                <MoveForm c={c} direction="up" label="Move earlier" disabled={i === 0} />
                <MoveForm c={c} direction="down" label="Move later" disabled={i === keys.length - 1} />
                <form action={testModelAction}>
                  <input type="hidden" name="provider" value={c.provider} />
                  <input type="hidden" name="model" value={c.model} />
                  <SubmitButton variant="secondary" icon={null} pendingLabel="Testing…">
                    Test
                  </SubmitButton>
                </form>
                <form action={deactivateModelAction}>
                  <input type="hidden" name="provider" value={c.provider} />
                  <input type="hidden" name="model" value={c.model} />
                  <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…">
                    Switch off
                  </SubmitButton>
                </form>
              </div>
            </li>
          );
        })}
      </ol>
      <form ref={form} action={setModelOrderAction}>
        <input ref={field} type="hidden" name="order" />
      </form>
    </>
  );
}

function MoveForm({ c, direction, label, disabled }: { c: OrderCard; direction: 'up' | 'down'; label: string; disabled: boolean }) {
  return (
    <form action={moveModelAction}>
      <input type="hidden" name="provider" value={c.provider} />
      <input type="hidden" name="model" value={c.model} />
      <input type="hidden" name="direction" value={direction} />
      <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…" disabled={disabled}>
        {label}
      </SubmitButton>
    </form>
  );
}

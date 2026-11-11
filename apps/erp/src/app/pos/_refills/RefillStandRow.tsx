'use client';

/**
 * T-529 R2 (bible row 448) - the refill stand picker: ONE sliding row, never a wrapped grid, whatever the number of stands (the same contract as the seat
 * panel's row in OrderDialogs). Every stand is a 48 px target that snaps to the row's start; the chosen one is scrolled into view and the arrow keys walk
 * the row, stopping at both ends. The choice itself belongs to the caller (`selectedSessionId`).
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { RefillTable } from './tables';

const STAND = 'min-h-12 min-w-12 shrink-0 snap-start rounded-2xl border px-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

export function RefillStandRow({ tables, selectedSessionId, onSelect }: { tables: RefillTable[]; selectedSessionId: string | null; onSelect: (sessionId: string) => void }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // The row slides sideways, so whichever stand is chosen (tapped or reached with an arrow key) is brought into view.
  const choose = (sessionId: string) => {
    onSelect(sessionId);
    buttons.current.get(sessionId)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  };
  const walk = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const from = tables.findIndex((t) => buttons.current.get(t.sessionId) === e.target);
    const base = from >= 0 ? from : tables.findIndex((t) => t.sessionId === selectedSessionId);
    const next = tables[base + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    choose(next.sessionId);
    buttons.current.get(next.sessionId)?.focus();
  };
  return (
    <section aria-label="Stand" className="space-y-3">
      <h3 className="text-sm font-semibold text-muted">Stand</h3>
      <div className="flex flex-nowrap gap-2 overflow-x-auto snap-x snap-mandatory pb-2 [scrollbar-width:thin]" onKeyDown={walk}>
        {tables.map((t) => (
          <button
            key={t.sessionId}
            ref={(el) => {
              if (el) buttons.current.set(t.sessionId, el);
              else buttons.current.delete(t.sessionId);
            }}
            type="button"
            data-erp-size="free"
            aria-pressed={t.sessionId === selectedSessionId}
            aria-label={t.label}
            className={`${STAND} ${t.sessionId === selectedSessionId ? 'border-ink bg-ink text-canvas' : 'border-surface-border bg-surface text-ink hover:bg-canvas'}`}
            onClick={() => choose(t.sessionId)}
          >
            {t.standNumber}
          </button>
        ))}
      </div>
    </section>
  );
}

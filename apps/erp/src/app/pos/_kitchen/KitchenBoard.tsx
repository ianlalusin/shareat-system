'use client';

/**
 * T-529 R1 - the Kitchen tab as it is drawn (kitchen-dark.png): one card per table, oldest first. Presentational: the cards arrive built (`cards.ts`) and
 * every tap leaves as a callback. Without `canServe` NO Served or All out button is drawn at all (read-only). Tokens only, so the dark theme (row 433)
 * and the light one both read. A late card is told by treatment as well as colour: a tinted header, "Late" in words, and a solid All out button.
 */
import type { KitchenCard } from './cards';

const SERVED = 'min-h-12 min-w-12 shrink-0 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ALL_OUT = 'min-h-12 w-full inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const ALL_OUT_LATE = 'min-h-12 w-full inline-flex items-center justify-center gap-2 rounded-full border border-transparent bg-brand px-4 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A take-out card has no stand, so two of them read the same. The last four characters of the table's id tell them apart, by eye and by screen reader. */
export const ticketTag = (sessionId: string): string => sessionId.slice(-4).toUpperCase();

export function KitchenBoard({ cards, canServe, onServe, onAllOut }: { cards: KitchenCard[]; canServe: boolean; onServe: (lineId: string) => void; onAllOut: (lineIds: string[]) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => (
        <section key={c.sessionId} data-session={c.sessionId} data-late={c.late ? 'true' : 'false'} aria-label={c.takeOut ? `Take-out, ticket ${ticketTag(c.sessionId)}` : c.title} className="flex flex-col overflow-hidden rounded-2xl border border-surface-border bg-surface">
          <header className={`flex items-baseline justify-between gap-3 px-4 py-3 ${c.late ? 'bg-danger-surface' : 'bg-closed-soft'}`}>
            <h2 className={`font-display text-2xl font-bold ${c.late ? 'text-danger' : 'text-ink'}`}>{c.title}
              {c.takeOut ? <span className="ml-2 text-sm font-semibold text-muted">#{ticketTag(c.sessionId)}</span> : null}
            </h2>
            <p className={`text-sm font-semibold tabular-nums ${c.late ? 'text-danger' : 'text-muted'}`}>
              {c.late ? 'Late · ' : ''}
              {c.ageLabel}
            </p>
          </header>
          <ul className="flex-1 space-y-1 px-4 py-3">
            {c.lines.map((l) => (
              <li key={l.lineId} data-line={l.lineId} className="flex items-start gap-3">
                <span className="w-8 shrink-0 pt-3 text-lg font-bold tabular-nums">{l.qty}</span>
                <div className="min-w-0 flex-1 py-3">
                  <p className="text-base">
                    {l.name}
                    {l.tag ? <span className="ml-2 rounded-full bg-info-soft px-2 py-0.5 text-xs font-semibold text-info">{l.tag}</span> : null}
                  </p>
                  {l.note ? <p className="mt-1 inline-block rounded-lg bg-warning-soft px-2 py-1 text-sm text-warning-ink">{l.note}</p> : null}
                </div>
                {canServe ? (
                  <button type="button" data-erp-size="free" className={SERVED} aria-label={`Served: ${l.qty} × ${l.name}, ${c.takeOut ? `take-out ${ticketTag(c.sessionId)}` : c.title.toLowerCase()}`} onClick={() => onServe(l.lineId)}>
                    Served
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {canServe ? (
            <div className="px-4 pb-4">
              <button type="button" data-erp-size="free" className={c.late ? ALL_OUT_LATE : ALL_OUT} onClick={() => onAllOut(c.lines.map((l) => l.lineId))}>
                <Check />
                All out
              </button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

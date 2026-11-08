'use client';

/** T-529 R1 - the station chips across the top of the Kitchen tab (kitchen-dark.png): All, then each station of the menu. aria-pressed marks the chosen one. */
const CHIP = 'min-h-12 min-w-12 inline-flex items-center justify-center rounded-full border px-5 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';

export function StationChips({ chips, selected, onSelect }: { chips: { id: string | null; label: string }[]; selected: string | null; onSelect: (id: string | null) => void }) {
  return (
    <div role="group" aria-label="Station" className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const on = c.id === selected;
        return (
          <button key={c.id ?? 'all'} type="button" data-erp-size="free" aria-pressed={on} className={`${CHIP} ${on ? 'border-transparent bg-ink text-canvas' : 'border-surface-border bg-surface text-ink hover:bg-canvas'}`} onClick={() => onSelect(c.id)}>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

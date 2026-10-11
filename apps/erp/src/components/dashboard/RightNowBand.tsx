import Link from 'next/link';

/**
 * T-387 S5. "Right now": a dark band with three live figures. On shift is a COUNT, never names. The band
 * inverts the page (ink on canvas) in light and sits on the surface in dark, with the warm accent on top.
 */
export function RightNowBand({
  onShift,
  onTheRoad,
  receivedNote,
  booksTie,
  assets,
}: {
  onShift: number;
  onTheRoad: number;
  receivedNote: string;
  booksTie: boolean;
  assets: string;
}) {
  return (
    <section
      aria-label="Right now"
      className="grid gap-10 rounded-3xl bg-ink p-8 text-canvas dark:bg-surface dark:text-ink sm:p-12 md:grid-cols-3"
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-warning dark:text-warning-ink">Right now</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-7xl font-bold leading-[0.85] tabular-nums">{onShift}</span>
          <span className="opacity-70">on shift</span>
        </div>
      </div>
      <Link href="/commissary/orders" className="flex min-h-11 min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-warning dark:text-warning-ink">Commissary</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-7xl font-bold leading-[0.85] tabular-nums">{onTheRoad}</span>
          <span className="opacity-70">on the road</span>
        </div>
        <span className="opacity-70">{receivedNote}</span>
      </Link>
      <Link href="/reports/balance-sheet" className="flex min-h-11 min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-warning dark:text-warning-ink">Books</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-4xl font-bold leading-none">{booksTie ? 'Ties' : 'DOES NOT TIE'}</span>
        </div>
        <span className="opacity-70">Assets ₱{assets}</span>
      </Link>
    </section>
  );
}

import Link from 'next/link';

/**
 * T-448: compact operational summary on the plain workspace. On shift remains a COUNT, never names.
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
      className="grid min-w-0 gap-4 rounded-lg border border-surface-border p-4 text-ink md:grid-cols-3"
    >
      <div className="flex min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-muted">Right now</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-3xl font-bold leading-tight tabular-nums">{onShift}</span>
          <span className="opacity-70">on shift</span>
        </div>
      </div>
      <Link href="/commissary/orders" className="flex min-h-11 min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-muted">Commissary</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-3xl font-bold leading-tight tabular-nums">{onTheRoad}</span>
          <span className="opacity-70">on the road</span>
        </div>
        <span className="opacity-70">{receivedNote}</span>
      </Link>
      <Link href="/reports/balance-sheet" className="flex min-h-11 min-w-0 flex-col gap-3.5">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-muted">Books</p>
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-2xl font-bold leading-tight">{booksTie ? 'Ties' : 'DOES NOT TIE'}</span>
        </div>
        <span className="opacity-70">Assets ₱{assets}</span>
      </Link>
    </section>
  );
}

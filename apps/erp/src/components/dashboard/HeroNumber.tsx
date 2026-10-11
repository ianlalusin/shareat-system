import { CountUp } from '@/components/feedback/CountUp';

/**
 * T-387 S5. The editorial hero: one big sales figure (counts up once, final text in SSR), the change
 * against the previous equal-length range, and one plain sentence under it.
 */
export function HeroNumber({
  kicker,
  value,
  text,
  delta,
  lede,
}: {
  kicker: string;
  value: number;
  text: string;
  delta: { pct: string | null; abs: string; up: boolean; same: boolean; against: string } | null;
  lede?: string;
}) {
  return (
    <div className="dash-rise flex min-w-0 flex-col gap-4">
      <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-muted">{kicker}</p>
      <div className="whitespace-nowrap font-display text-[clamp(56px,8.6vw,120px)] font-extrabold leading-[0.85] tracking-tight tabular-nums">
        <span className="mr-1 align-top text-[0.42em] text-warning-ink">₱</span>
        <CountUp value={value} text={text} />
      </div>
      {delta?.same ? (
        <div className="text-[15px] text-muted">Same as last period</div>
      ) : delta ? (
        <div className="flex flex-wrap items-center gap-3">
          {delta.pct !== null ? (
            <span
              className={
                delta.up
                  ? 'inline-flex h-8 items-center gap-1.5 rounded-[12px] bg-success px-3 text-sm font-bold text-canvas'
                  : 'inline-flex h-8 items-center gap-1.5 rounded-[12px] border border-danger px-3 text-sm font-bold text-danger'
              }
            >
              <span aria-hidden="true">{delta.up ? '▲' : '▼'}</span>
              {delta.pct}
            </span>
          ) : null}
          <span className="text-[15px] text-muted">
            ₱{delta.abs} {delta.up ? 'more' : 'less'} than {delta.against}
          </span>
        </div>
      ) : null}
      {lede ? <p className="m-0 max-w-[30ch] text-xl leading-snug">{lede}</p> : null}
    </div>
  );
}

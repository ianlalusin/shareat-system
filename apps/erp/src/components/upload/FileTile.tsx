/**
 * T-441 - what the upload shape shows when there is no picture to draw: a document tile (a PDF, with its name and size)
 * or a lock tile (a guarded file that is on record but never shown as a thumbnail). Server-safe: no state, no effects.
 * It never draws an `<img>`.
 */
export function FileTile({
  variant,
  name,
  size,
}: {
  variant: 'document' | 'locked';
  name?: string;
  size?: string;
}) {
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-ink">
      {variant === 'locked' ? (
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5M10 13h6M10 17h6" />
        </svg>
      )}
      {name ? <span className="w-full truncate text-[11px] leading-tight">{name}</span> : null}
      {size ? <span className="text-[11px] leading-tight text-muted">{size}</span> : null}
    </span>
  );
}

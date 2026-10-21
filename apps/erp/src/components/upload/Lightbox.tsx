'use client';

/**
 * T-441 - the full-size view. A native modal `<dialog>` (focus trap, Esc, inert page come free).
 *
 * ## Why the open counter exists (audit A6)
 * A stored file is opened from `/files/{id}`, which mints a fresh signed link and, for a leave certificate or a signature,
 * writes ONE audit row per request. A browser may reuse a decoded image for an identical `<img src>` in the same document
 * without asking again, so a second open would show the picture with no audit row. Every open therefore uses a fresh query
 * (`?open=n`, which the route ignores), and the `<img>` exists only while the dialog is open - nothing is kept in state.
 *
 * `src` is only ever that route, or `localSrc`: a `blob:` URL of the picture the person just picked (their own bytes;
 * nothing is fetched). Never a storage URL, path or signed link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Open/close state plus the counter, bumped in the same batch as `open` so the first render already has the fresh value. */
export function useLightbox() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const show = useCallback(() => {
    setCount((c) => c + 1);
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  return { open, count, show, hide };
}

export function Lightbox({
  open,
  count,
  onClose,
  label,
  fileId,
  kind,
  localSrc,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  /** Used for the dialog's name and the picture's alt text, e.g. "Receipt photo". */
  label: string;
  /** A stored file, opened through the audited route. */
  fileId?: string;
  kind: 'image' | 'pdf';
  /** A just-picked file's local object URL: shown instead of fetching. */
  localSrc?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const src = localSrc ?? (fileId ? `/files/${fileId}?open=${count}` : null);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="open:flex flex-col max-h-[95dvh] max-w-[95vw] overflow-hidden rounded-[10px] text-sm border border-field-border bg-surface p-3 text-ink backdrop:bg-black/60"
    >
      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 justify-end">
            <button
              type="button"
              autoFocus
              onClick={onClose}
              className="rounded-[10px] border border-field-border bg-field px-3 py-1.5 text-sm text-ink"
            >
              Close
            </button>
          </div>
          {src && kind === 'image' && (
            <div className="min-h-0 flex-1 overflow-auto">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={label} className="block mx-auto h-auto w-auto max-w-full max-h-[calc(95dvh-5.5rem)] object-contain" />
            </div>
          )}
          {src && kind === 'pdf' && (
            <a href={src} target="_blank" rel="noopener noreferrer" className="inline-block py-2 text-sm font-medium text-brand underline">
              Open PDF
            </a>
          )}
        </div>
      )}
    </dialog>
  );
}

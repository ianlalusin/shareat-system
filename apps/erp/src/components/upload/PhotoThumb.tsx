'use client';

/**
 * T-441 S6 - the read-only twin of PhotoUpload, for screens that only SHOW a stored file. The same shape (a circle for a
 * person's photo, a rounded square otherwise), the picture inside, and a click that opens the same full-size Lightbox.
 * No file input and no upload code: a screen that lets the person change the file uses PhotoUpload instead.
 *
 * Pass `existing` ONLY when the loader decided this viewer may open it (the screen's own read gate), so no file id reaches
 * the browser otherwise. A guarded purpose (a leave certificate, a signature) never gets a thumbnail: a lock tile, and
 * the full-size view fetches it only when opened (one open is one audited view, A6). A PDF draws a document tile.
 *
 * `inLink` is for a thumbnail drawn inside a link (a button inside a link is invalid and would swallow the link's click):
 * it draws the same picture as plain markup with no full-size view.
 */
import { useState } from 'react';
import { FileTile } from './FileTile';
import { Lightbox, useLightbox } from './Lightbox';
import { GUARDED_PURPOSES, shapeFor, type UploadPurpose } from './upload-rules';
import type { ExistingFile } from './upload-state';

export interface PhotoThumbProps {
  purpose: UploadPurpose;
  /** Used for the button's name and the picture's alt text, e.g. "Receipt photo". */
  label: string;
  existing: ExistingFile;
  /** `md` 96 px (as PhotoUpload), `sm` 44 px for a list row, `fill` takes its box from `className`. */
  size?: 'md' | 'sm' | 'fill';
  /** Extra classes on the shape (ring, margin, border for `fill`). */
  className?: string;
  inLink?: boolean;
}

const BOX = { md: 'h-24 w-24', sm: 'h-11 w-11', fill: '' } as const;

export function PhotoThumb({ purpose, label, existing, size = 'md', className = '', inLink = false }: PhotoThumbProps) {
  const lightbox = useLightbox();
  const [broken, setBroken] = useState(false);
  const guarded = GUARDED_PURPOSES.includes(purpose);
  const shapeCls = shapeFor(purpose) === 'circle' ? 'rounded-full' : 'rounded-[10px]';
  const borderCls = size === 'fill' ? '' : 'border border-field-border bg-field';

  let inside: React.ReactNode;
  if (guarded) inside = <FileTile variant="locked" />;
  else if (existing.kind === 'image' && !broken) {
    inside = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/files/${existing.fileId}`}
        alt={inLink ? '' : `${label} (on file)`}
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    );
  } else inside = <FileTile variant="document" />;

  const shape = `relative shrink-0 overflow-hidden ${BOX[size]} ${shapeCls} ${borderCls} ${className}`;
  if (inLink) return <span className={shape}>{inside}</span>;

  return (
    <>
      <span className={`inline-block align-middle ${shape}`}>
        <button
          type="button"
          onClick={lightbox.show}
          aria-label={`${label}: open full size`}
          className="flex h-full w-full items-center justify-center rounded-[inherit] text-sm text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {inside}
        </button>
      </span>
      <Lightbox
        open={lightbox.open}
        count={lightbox.count}
        onClose={lightbox.hide}
        label={label}
        kind={existing.kind}
        fileId={existing.fileId}
      />
    </>
  );
}

export default PhotoThumb;

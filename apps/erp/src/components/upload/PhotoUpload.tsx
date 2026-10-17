'use client';

/**
 * T-441 - the ONE photo-upload control. Empty: a rounded square (a circle for a person's photo) on gray with an upload
 * icon. Uploading: the shape fills like water with the REAL percentage. Done: the picture sits inside. Click it: the full
 * size opens. Every step has an icon AND words (never colour alone) and one polite live line announces changes.
 *
 * ## How a photo travels
 * On pick the control shrinks the photo (T-296 rules), sends it with `XMLHttpRequest` to the upload route (the only way
 * a browser reports upload progress) and, once the server answers, posts the returned id in a hidden `<name>FileId` field and
 * clears the file input (the bytes are not sent twice). The form's action claims that id on Save (`resolveUploadedFile` +
 * `claimUpload`). With JavaScript off the plain file input posts the file and the server path is unchanged.
 *
 * ## Guarded files (bible row 353)
 * A stored file of a guarded purpose (a leave certificate, a signature) never gets a thumbnail: the shape shows a lock and
 * "On file". The full-size view fetches it only when opened, so one open is one audited view. A file the person has just
 * picked previews from its local object URL (their own bytes; nothing is fetched).
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { formatBytes } from '../photo-compression';
import { FileTile } from './FileTile';
import { Lightbox, useLightbox } from './Lightbox';
import { acceptFor, allowsPdf, GUARDED_PURPOSES, shapeFor, type UploadPurpose } from './upload-rules';
import { initialState, percent, reduce, shouldAbort, type ExistingFile, type UploadAction } from './upload-state';
import { CompressionRefused, needsCompression, shrinkPhoto } from './upload-compress';
import { sendFile, UploadSendError } from './upload-xhr';
import { WaterFill } from './WaterFill';

const INTERRUPTED = 'Upload interrupted - check the connection and press Retry';

export interface PhotoUploadProps {
  /** The file input's name. The hidden id field is `${name}FileId`. */
  name: string;
  purpose: UploadPurpose;
  /** Used for the button's name and the picture's alt text, e.g. "Receipt photo". */
  label: string;
  required?: boolean;
  capture?: 'user' | 'environment';
  /** A fixed store for the upload (a page that already knows it). */
  storeId?: string;
  /** Or the name of a store field in the same form, read live (the control says "Choose a store first" until it has one). */
  storeField?: string;
  /** A file already on the record. Pass it ONLY when the loader decided this viewer may open it. */
  existing?: ExistingFile;
}

export function PhotoUpload({ name, purpose, label, required, capture, storeId, storeField, existing }: PhotoUploadProps) {
  const [state, rawDispatch] = useReducer(reduce, existing, initialState);
  const stateRef = useRef(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const localUrlRef = useRef<string | null>(null);
  const uploadedStoreRef = useRef<string>('');
  const [localUrl, setLocalUrlState] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ kind: 'image' | 'pdf'; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storeVal, setStoreVal] = useState<string>(storeId ?? '');
  const lightbox = useLightbox();

  const guarded = GUARDED_PURPOSES.includes(purpose);
  const shape = shapeFor(purpose);
  const accept = acceptFor(purpose);
  const pdfOk = allowsPdf(purpose);
  const needsStore = storeField !== undefined && storeVal === '';

  const send = useCallback((action: UploadAction) => {
    if (shouldAbort(stateRef.current, action)) abortRef.current?.abort();
    stateRef.current = reduce(stateRef.current, action);
    rawDispatch(action);
  }, []);

  const setLocalUrl = useCallback((file: File | null) => {
    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    localUrlRef.current = file ? URL.createObjectURL(file) : null;
    setLocalUrlState(localUrlRef.current);
  }, []);

  // Leaving the page: stop any send in flight and let go of the local picture.
  useEffect(
    () => () => {
      runRef.current += 1;
      abortRef.current?.abort();
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    },
    [],
  );

  // A store field in the same form: read it live.
  useEffect(() => {
    if (!storeField) return;
    const form = inputRef.current?.form;
    if (!form) return;
    const read = (): string => {
      const el = form.elements.namedItem(storeField);
      return el instanceof HTMLSelectElement || el instanceof HTMLInputElement ? el.value : '';
    };
    setStoreVal(read());
    const onChange = (e: Event) => {
      if (e.target instanceof HTMLElement && e.target.getAttribute('name') === storeField) setStoreVal(read());
    };
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, [storeField]);

  // The store changed after a photo was chosen for another one: clear it and say why.
  useEffect(() => {
    const s = stateRef.current.status;
    if (s === 'empty' || s === 'existing') return;
    if (uploadedStoreRef.current === storeVal) return;
    runRef.current += 1;
    send({ type: 'remove' });
    setLocalUrl(null);
    setPicked(null);
    setNotice('The store changed, so the photo was cleared. Pick it again.');
  }, [storeVal, send, setLocalUrl]);

  // The form cannot be submitted half-done (or with a failed upload nobody has dealt with).
  const busy = state.status === 'selected' || state.status === 'compressing' || state.status === 'uploading';
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (busy) input.setCustomValidity('Wait for the photo to finish uploading');
    else if (state.status === 'failed') input.setCustomValidity('The photo did not upload - press Retry or choose another');
    else input.setCustomValidity('');
  }, [busy, state.status]);

  const startUpload = useCallback(
    async (file: File, run: number) => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const sent = await sendFile(
          file,
          purpose,
          storeVal || null,
          (loaded, total) => {
            if (runRef.current === run) send({ type: 'progress', loaded, total });
          },
          controller.signal,
        );
        if (runRef.current !== run) return;
        send({ type: 'uploaded', fileId: sent.fileId, preview: localUrlRef.current, byteSize: sent.byteSize });
      } catch (err) {
        if (runRef.current !== run || controller.signal.aborted) return;
        const known = err instanceof UploadSendError ? err : null;
        send({ type: 'fail', reason: known?.message ?? INTERRUPTED, retryable: known?.retryable ?? true });
      }
    },
    [purpose, storeVal, send],
  );

  const begin = useCallback(
    async (original: File) => {
      const run = runRef.current + 1;
      runRef.current = run;
      setNotice(null);
      uploadedStoreRef.current = storeVal;
      send({ type: 'pick', file: original });
      setPicked({ kind: original.type.includes('pdf') ? 'pdf' : 'image', name: original.name });
      setLocalUrl(original);
      if (!accept.split(',').includes(original.type)) {
        send({ type: 'fail', reason: 'That file type is not accepted here.', retryable: false });
        return;
      }
      let toSend = original;
      if (needsCompression(original)) {
        send({ type: 'compress' });
        try {
          toSend = await shrinkPhoto(original);
        } catch (err) {
          if (runRef.current !== run) return;
          if (err instanceof CompressionRefused) {
            send({ type: 'fail', reason: err.message, retryable: false });
            return;
          }
          toSend = original; // this browser cannot compress: send the original and let the server decide
        }
        if (runRef.current !== run) return;
        if (toSend !== original) setLocalUrl(toSend);
      }
      send({ type: 'compressed', file: toSend });
      await startUpload(toSend, run);
    },
    [accept, send, setLocalUrl, startUpload, storeVal],
  );

  function choose() {
    if (needsStore) {
      setNotice('Choose a store first.');
      return;
    }
    inputRef.current?.click();
  }

  function onPick() {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = ''; // the bytes travel once, through the upload; the form posts only the id
    if (needsStore) {
      setNotice('Choose a store first.');
      return;
    }
    void begin(file);
  }

  function retry() {
    const s = stateRef.current;
    if (s.status !== 'failed' || !s.retryable || !s.file) return;
    const run = runRef.current + 1;
    runRef.current = run;
    const file = s.file;
    send({ type: 'retry' });
    void startUpload(file, run);
  }

  function remove() {
    runRef.current += 1;
    send({ type: 'remove' });
    setLocalUrl(null);
    setPicked(null);
    setNotice(null);
  }

  function onShape() {
    if (busy) return;
    if (state.status === 'done' || state.status === 'existing') lightbox.show();
    else choose();
  }

  // ------------------------------------------------------------------ what to show
  const p = percent(state);
  let words: string;
  let announce: string;
  switch (state.status) {
    case 'empty':
      words = needsStore ? 'Choose a store first' : pdfOk ? 'Add photo or PDF' : 'Add photo';
      announce = words;
      break;
    case 'selected':
      words = 'Preparing photo...';
      announce = words;
      break;
    case 'compressing':
      words = 'Shrinking photo...';
      announce = words;
      break;
    case 'uploading':
      words = p === null ? 'Uploading...' : `Uploading ${p}%`;
      announce = p === null ? 'Uploading' : `Uploading ${Math.floor(p / 25) * 25}%`; // 25% steps only: a live region per percent floods a screen reader
      break;
    case 'done':
      words = state.byteSize ? `Uploaded - ${formatBytes(state.byteSize)}` : 'Uploaded';
      announce = words;
      break;
    case 'failed':
      words = state.reason;
      announce = `Failed. ${state.reason}`;
      break;
    case 'existing':
      words = 'On file';
      announce = words;
      break;
  }

  const shapeCls = shape === 'circle' ? 'rounded-full' : 'rounded-[10px]';
  const showsPicture = state.status === 'done' || state.status === 'existing';
  const borderCls =
    state.status === 'failed'
      ? 'border-2 border-danger'
      : state.status === 'empty'
        ? 'border border-dashed border-field-border bg-neutral-100 dark:bg-neutral-800'
        : 'border border-field-border bg-field';
  const kind = state.status === 'existing' ? state.kind : (picked?.kind ?? 'image');

  // The picture inside the shape. A stored file of a guarded purpose is never fetched as a thumbnail.
  let inside: React.ReactNode;
  if (state.status === 'empty') {
    inside = <UploadIcon />;
  } else if (state.status === 'existing') {
    if (guarded) inside = <FileTile variant="locked" />;
    else if (state.kind === 'image') {
      inside = (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/files/${state.fileId}`} alt={`${label} (on file)`} loading="lazy" className="h-full w-full object-cover" />
      );
    } else inside = <FileTile variant="document" />;
  } else if (state.status === 'failed' && !localUrl) {
    inside = <WarningIcon />;
  } else if (localUrl && picked?.kind === 'image') {
    inside = (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={localUrl} alt={`${label} preview`} className={`h-full w-full object-cover ${busy ? 'opacity-50' : ''}`} />
    );
  } else {
    inside = <FileTile variant="document" name={picked?.name ?? ''} />;
  }

  const ariaLabel = showsPicture ? `${label}: open full size` : `${label}: ${words}`;

  return (
    <div className="space-y-1.5">
      {/* The wrapper carries the shape and border (and clips the water); the button inside is a plain static box. */}
      <div className={`relative h-24 w-24 overflow-hidden ${shapeCls} ${borderCls}`}>
        <button
          type="button"
          onClick={onShape}
          aria-label={ariaLabel}
          aria-busy={busy}
          className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-[inherit] text-sm text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {inside}
        </button>
        {state.status === 'compressing' || state.status === 'selected' ? (
          <div className="pointer-events-none absolute inset-0 bg-progress-soft/60 motion-safe:animate-pulse" aria-hidden="true" />
        ) : null}
        {state.status === 'uploading' ? (
          <div
            role="progressbar"
            aria-label={`${label} upload`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(p === null ? {} : { 'aria-valuenow': p })}
            className="pointer-events-none absolute inset-0 overflow-hidden"
          >
            <WaterFill percent={p} />
          </div>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={accept}
        capture={capture}
        required={required && state.status !== 'done' && state.status !== 'existing'}
        tabIndex={-1}
        onChange={onPick}
        className="sr-only py-2 text-sm"
      />
      {state.status === 'done' ? <input type="hidden" name={`${name}FileId`} value={state.fileId} /> : null}

      <p className={`max-w-[12rem] text-xs ${state.status === 'failed' ? 'text-danger' : 'text-muted'}`}>{words}</p>
      {notice ? <p className="max-w-[12rem] text-xs text-warning-ink">{notice}</p> : null}
      <p className="sr-only" aria-live="polite">
        {notice ? `${announce}. ${notice}` : announce}
      </p>

      <div className="flex flex-wrap gap-2 text-xs">
        {state.status === 'failed' && state.retryable ? (
          <ActionButton onClick={retry}>Retry</ActionButton>
        ) : null}
        {state.status === 'failed' ? <ActionButton onClick={choose}>Choose another</ActionButton> : null}
        {state.status === 'done' || state.status === 'existing' ? <ActionButton onClick={choose}>Replace</ActionButton> : null}
        {state.status === 'done' || state.status === 'failed' ? <ActionButton onClick={remove}>Remove</ActionButton> : null}
        {busy ? <ActionButton onClick={remove}>Cancel</ActionButton> : null}
      </div>

      <Lightbox
        open={lightbox.open}
        count={lightbox.count}
        onClose={lightbox.hide}
        label={label}
        kind={kind}
        {...(state.status === 'existing' ? { fileId: state.fileId } : {})}
        localSrc={state.status === 'done' ? localUrl : null}
      />
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded-[10px] border border-field-border bg-field px-2 py-1 text-xs text-ink">
      {children}
    </button>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-8 w-8 text-danger" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 4 3 20h18zM12 10v4M12 17v.5" />
    </svg>
  );
}

export default PhotoUpload;

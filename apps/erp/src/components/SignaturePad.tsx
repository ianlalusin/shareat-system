'use client';

/**
 * T-434 - sign on screen. A canvas the manager (or the staff member, handed the device) draws on; Save exports a PNG Blob and sends
 * it to the server action as a file part. Nothing is stored in the browser and no data URL is ever built.
 *
 * T-441 S5: when the page passes `signatureFileId` (only a viewer allowed to open it gets one, bible row 353) the saved state is a
 * "Signature on file" tile whose View button opens the shared Lightbox; the picture exists only while it is open. Never an <img> here.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { exportSignaturePng, signatureFormData } from './signature-pad-export';
import { Lightbox, useLightbox } from './upload/Lightbox';

export function SignaturePad({
  personId,
  employmentId,
  action,
  signatureFileId,
  readOnly = false,
}: {
  personId: string;
  employmentId: string;
  action: (formData: FormData) => Promise<void>;
  signatureFileId?: string | null;
  /** An ended employment: the tile and View stay, the pad does not. */
  readOnly?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { open, count, show, hide } = useLightbox();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
  }, []);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    canvasRef.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
    setInked(true);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function up() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setInked(false);
    setError(null);
  }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas || !inked) return;
    setError(null);
    startTransition(async () => {
      try {
        const blob = await exportSignaturePng(canvas);
        const fd = signatureFormData(blob, personId);
        fd.append('employmentId', employmentId);
        await action(fd);
      } catch (err) {
        // A server action that redirects throws a framework redirect; let that through untouched.
        if (err && typeof err === 'object' && 'digest' in err) throw err;
        setError(err instanceof Error ? err.message : 'The signature could not be saved.');
      }
    });
  }

  const tile = signatureFileId ? (
    <div className="flex items-center gap-2 text-sm">
      <span>Signature on file</span>
      <button type="button" onClick={show} className="min-h-8 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
        View
      </button>
    </div>
  ) : null;
  const lightbox = signatureFileId ? (
    <Lightbox open={open} count={count} onClose={hide} label="Signature" fileId={signatureFileId} kind="image" />
  ) : null;

  if (readOnly) {
    return (
      <div className="space-y-2">
        {tile}
        {lightbox}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {tile}
      {lightbox}
      <canvas
        ref={canvasRef}
        width={600}
        height={200}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label="Signature pad"
        className="w-full max-w-xl touch-none rounded-md border border-neutral-300 bg-white dark:border-neutral-700"
      />
      <div className="flex gap-2">
        <button type="button" onClick={clear} className="min-h-8 rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
          Clear
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!inked || pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? 'Saving…' : 'Save signature'}
        </button>
      </div>
      {error && (
        <p className="text-sm text-warning-ink">
          Failed: {error}{' '}
          <button type="button" onClick={save} className="inline-flex min-h-8 items-center underline">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

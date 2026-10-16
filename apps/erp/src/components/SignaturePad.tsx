'use client';

/**
 * T-434 - sign on screen. A canvas the manager (or the staff member, handed the device) draws on; Save exports a PNG Blob and sends
 * it to the server action as a file part. Nothing is stored in the browser and no data URL is ever built.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { exportSignaturePng, signatureFormData } from './signature-pad-export';

export function SignaturePad({
  personId,
  employmentId,
  action,
}: {
  personId: string;
  employmentId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  return (
    <div className="space-y-2">
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
        <button type="button" onClick={clear} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
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
      {error && <p className="text-sm text-warning-ink">{error}</p>}
    </div>
  );
}

'use client';

/**
 * The one-time pairing-token reveal — shared by `ProvisionForm` (a brand-new terminal) and
 * `RepairButton` (re-pairing an existing one). T-203 spec §1:
 *
 * > "The returned `customToken` is shown exactly once, on the confirmation view right after
 * > provisioning — as selectable text AND as a QR code... never re-fetchable from this screen
 * > after navigating away... the UI must not defeat that by, say, keeping it in a client-side
 * > store that survives a refresh."
 *
 * ⭐ **Why this is safe**: the token lives ONLY in the parent's `useState`, passed down as a prop.
 * There is no `localStorage`, no cookie, no query string, no server-side cache keyed by anything —
 * a browser refresh loses the React tree and the token with it, which is the required behaviour,
 * not an accident of not having built persistence.
 *
 * ⭐ **Why a hand-rolled QR renderer, not a heavy library**: `qrcode-generator` (added by this task)
 * is a zero-dependency, MIT-licensed encoder — it produces the module matrix and this component
 * renders it as plain SVG `<rect>`s, so there is no image library, no canvas, and no second run
 * through a bundler plugin for one screen.
 */
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { Button, Textarea } from '@/components/ui';

export function TokenReveal({
  heading,
  intro,
  customToken,
  onDone,
}: {
  heading: string;
  intro: string;
  customToken: string;
  onDone: () => void;
}) {
  // ⚠️ EC level 'M' (15% recovery), auto type number (0) — a Firebase custom token is a few hundred
  // to ~1000+ characters, so the encoder picks whatever version actually fits it.
  const { size, isDark } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(customToken);
    qr.make();
    const count = qr.getModuleCount();
    return { size: count, isDark: (r: number, c: number) => qr.isDark(r, c) };
  }, [customToken]);

  const cells: { r: number; c: number }[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDark(r, c)) cells.push({ r, c });
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-warning bg-warning-soft p-4">
      <div>
        <h3 className="font-medium text-warning-ink">{heading}</h3>
        <p className="mt-1 text-xs text-warning-ink">{intro}</p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="h-48 w-48 shrink-0 bg-white"
          role="img"
          aria-label="Pairing QR code — scan with the terminal device while it is online"
        >
          <rect width={size} height={size} fill="#fff" />
          {cells.map(({ r, c }) => (
            <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill="#000" />
          ))}
        </svg>

        <div className="flex-1 space-y-2">
          <label className="block text-xs font-medium text-warning-ink">
            Or paste this token directly on the terminal
          </label>
          <Textarea
            readOnly
            value={customToken}
            onFocus={(e) => e.currentTarget.select()}
            rows={6}
            className="w-full font-mono text-xs"
          />
        </div>
      </div>

      <p className="text-xs font-medium text-warning-ink">
        ⚠️ Shown once. This screen cannot show it to you again after you leave or refresh — if it is
        lost before pairing finishes, mint a fresh one instead of hunting for this one.
      </p>

      <Button type="button" variant="primary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

'use client';

/**
 * "Re-pair" — mints a fresh one-time token for an ALREADY-provisioned terminal, per row. T-203
 * spec §1: *"If a token is lost, the correct action is `mintTerminalToken` (re-pair), surfaced as
 * a button on an already-provisioned terminal's row — not a way to recover the old one."*
 *
 * Same reason this is a client component as `ProvisionForm`: the token must be held only in local
 * state, never redirected through a URL.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TokenReveal } from './TokenReveal';
import type { MintTokenActionResult } from './actions';

export function RepairButton({
  terminalId,
  label,
  action,
}: {
  terminalId: string;
  label: string;
  action: (input: { terminalId: string }) => Promise<MintTokenActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ customToken: string } | null>(null);

  if (reveal) {
    return (
      <TokenReveal
        heading={`New pairing token for "${label}"`}
        intro={
          'This mints a fresh one-time pairing token for this SAME terminal — its identity, ' +
          'history and any punches it has already recorded all stay attached to this row. Use this ' +
          'when the original token was lost before pairing, or the device was wiped or replaced.'
        }
        customToken={reveal.customToken}
        onDone={() => {
          setReveal(null);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await action({ terminalId });
            if (res.ok) setReveal({ customToken: res.customToken });
            else setError(res.error);
          })
        }
        className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? 'Minting…' : 'Re-pair (new token)'}
      </button>
      {error && <p className="max-w-xs text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}

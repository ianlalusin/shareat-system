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
import { Button } from '@/components/ui';

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
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await action({ terminalId });
            if (res.ok) setReveal({ customToken: res.customToken });
            else setError(res.error);
          })
        }
      >
        {pending ? 'Minting…' : 'Re-pair (new token)'}
      </Button>
      {error && <p className="max-w-xs text-xs text-danger">{error}</p>}
    </div>
  );
}

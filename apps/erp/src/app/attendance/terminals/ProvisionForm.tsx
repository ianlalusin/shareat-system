'use client';

/**
 * "Provision a new terminal" — T-203. A client component ONLY because the result carries a
 * one-time token that must never survive a `<form action>` + redirect (see `actions.ts`'s top
 * comment). It calls the server action directly and holds the result in local state.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TokenReveal } from './TokenReveal';
import type { ProvisionActionResult } from './actions';

const INPUT =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';

export function ProvisionForm({
  storeId,
  action,
}: {
  storeId: string;
  action: (input: { storeId: string; label: string }) => Promise<ProvisionActionResult>;
}) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [reveal, setReveal] = useState<{ label: string; customToken: string } | null>(null);

  if (reveal) {
    return (
      <TokenReveal
        heading={`"${reveal.label}" is provisioned`}
        intro={
          'Pair the terminal with this token now, while it is online — a device cannot begin ' +
          'authenticating offline. Until it completes this pairing once, it is NOT ready and cannot ' +
          'record a punch.'
        }
        customToken={reveal.customToken}
        onDone={() => {
          setReveal(null);
          router.refresh();
        }}
      />
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const res = await action({ storeId, label: trimmed });
      if (res.ok) {
        setReveal({ label: res.label, customToken: res.customToken });
        setLabel('');
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 basis-48 text-sm">
        <span className="block text-neutral-600 dark:text-neutral-400">Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          placeholder="e.g. Lipa front counter"
          className={`${INPUT} w-full`}
        />
      </label>
      <button type="submit" disabled={pending} className={BTN}>
        {pending ? 'Provisioning…' : 'Provision terminal'}
      </button>
      {error && <p className="w-full text-sm text-red-700 dark:text-red-400">{error}</p>}
    </form>
  );
}

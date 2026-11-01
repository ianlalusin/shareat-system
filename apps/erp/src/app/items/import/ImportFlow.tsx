'use client';

/**
 * T-502 S4 - the upload box of /items/import. It sends the chosen file to the server action `check` (passed in by the page) and
 * shows whatever the server draws back: an error, or the preview table with its Confirm. Holds no data of its own.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { CsvFileInput } from '@/components/upload/CsvFileInput';

export function ImportFlow({ check }: { readonly check: (formData: FormData) => Promise<ReactNode> }) {
  const [result, setResult] = useState<ReactNode>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setPending(true);
    try {
      setResult(await check(formData));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <CsvFileInput name="file" label="CSV file" />
        <Button type="submit" disabled={pending}>
          Check the file
        </Button>
        {pending ? <span role="status" className="text-sm">Checking the file…</span> : null}
      </form>
      {result}
    </div>
  );
}

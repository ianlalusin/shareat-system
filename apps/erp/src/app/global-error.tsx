'use client';

import { useEffect } from 'react';
import './globals.css';

/**
 * T-217. Catches an error thrown by the root layout itself — `error.tsx` cannot, since it is
 * wrapped BY that layout, not around it. Must render its own `<html>`/`<body>` (Next file
 * convention) and import global styles explicitly — this file bypasses the layout that normally
 * pulls them in.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-lg space-y-3 p-10 text-center">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            The application failed to load. Try again, or come back in a moment.
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-neutral-400 dark:text-neutral-600">
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}

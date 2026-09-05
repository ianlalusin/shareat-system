'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * T-217. `retry` (not `reset`) is the recovery callback on Next 16.3+ — confirmed against
 * `node_modules/next/dist/docs/.../error.md`'s own version table before writing this.
 *
 * ⛔ Does not attempt to distinguish an `AuthorizationError` (e.g. `reportScope()` refusing a
 * capability) from any other thrown error. Next replaces a Server Component error's message with a
 * generic one plus a `digest` in production specifically to stop exactly that kind of detail
 * crossing this boundary, so branching on `error.message` or `error instanceof X` here would be
 * unreliable by design, not merely untidy.
 */
export default function ErrorBoundary({
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
    <main className="mx-auto max-w-lg space-y-3 p-10 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        The page could not load. This may be a temporary problem, or you may not have access to
        what it was trying to show.
      </p>
      {error.digest && (
        <p className="font-mono text-xs text-neutral-400 dark:text-neutral-600">
          Reference: {error.digest}
        </p>
      )}
      <div className="flex justify-center gap-4 pt-2">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}

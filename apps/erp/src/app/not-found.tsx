import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg space-y-3 p-10 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        There is nothing at this address. If you followed a link to get here, it may be stale.
      </p>
      <p>
        <Link href="/" className="text-sm underline underline-offset-4 hover:no-underline">
          Back to the dashboard
        </Link>
      </p>
    </main>
  );
}

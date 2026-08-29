import Link from 'next/link';

/**
 * ⚠️ Still the Phase 0 scaffold. T-162 added the one link it needed rather than inventing a
 * navigation for the whole app — that is a decision with a designer in it, and this task's scope is
 * a quarantine screen. The link is here so the screen is reachable without typing a URL.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-2xl font-semibold">Shareat System</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Correct books, simply modelled. Postgres owns the truth; Firebase owns the edge.
      </p>
      <p className="mt-6 text-sm">
        Phase 0 scaffold. See <code>PROJECT_BIBLE.md</code> for how this project is built.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/attendance/lane" className="underline">
          The clock lane
        </Link>{' '}
        — whether the terminals are talking to us, and what did not make it through.
      </p>
    </main>
  );
}

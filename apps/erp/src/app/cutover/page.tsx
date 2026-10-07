import Link from 'next/link';
import { isZero, money } from '@shareat/core/money';
import { requireSession } from '../../lib/session';
import { attestStepAction } from './actions';
import { PHASE_TITLE, kindLabel, listStores, loadGaps, loadProgress, peso } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'The conversion — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function CutoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/cutover');

  const stores = await listStores(actor.orgId);
  const [progress, gaps] = await Promise.all([
    loadProgress(
      actor.orgId,
      stores.map((s) => s.id),
    ),
    loadGaps(actor.orgId),
  ]);

  const storeName = (id: string | null) =>
    id ? (stores.find((s) => s.id === id)?.name ?? 'Unknown store') : null;

  const residual = Number(progress.openingResidual);
  // T-371 C4: balanced is decided in centavos on the minted figure; `residual` is display-only.
  const balanced = isZero(money(progress.openingResidual));

  return (
    <Page density="form">
      <div>
        <h1 className="text-2xl font-semibold">The 31 December conversion</h1>
        <PageDescription>
          Closing the old books and opening these ones. It runs twice — a rehearsal in November
          against a restored copy, then the real thing — and it is meant to be picked up and put
          down over several days.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {/*
        ⭐ THE RUNNING RESIDUAL IS THE WHOLE DESIGN.

        Most accounting software plugs a difference like this into a suspense account so the books
        can open anyway. That is real, and it is scale-driven — those vendors serve millions of
        self-serve tenants who cannot get a human's attention. One company, one cutover, Ian
        available: we halt instead.

        ⚠️ But the plug account buys one genuinely useful thing, and this is it: the difference is
        a NUMBER YOU CAN WATCH while you type, not a verdict at the end. An imbalance found on the
        tenth supplier is a typo; the same imbalance found after the last one is an investigation.
      */}
      <section
        className={`rounded-lg border p-4 sm:p-5 ${
          balanced
            ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span
            className={`text-sm font-medium ${
              balanced
                ? 'text-emerald-900 dark:text-emerald-300'
                : 'text-amber-900 dark:text-amber-300'
            }`}
          >
            {balanced ? 'The opening entry balances' : 'Difference still to explain'}
          </span>
          <span
            className={`font-mono text-2xl font-semibold tabular-nums ${
              balanced
                ? 'text-emerald-900 dark:text-emerald-300'
                : 'text-amber-900 dark:text-amber-300'
            }`}
          >
            {peso(Math.abs(residual))}
          </span>
        </div>
        <p
          className={`mt-1 text-xs ${
            balanced ? 'text-emerald-800 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-400'
          }`}
        >
          {balanced
            ? 'Opening balance equity nets to zero. Nothing is being carried by an account that should not hold anything.'
            : 'This is watched while you enter, not revealed at the end. There is no suspense account to push it into — a difference has to be found, not parked.'}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">
          <span className="font-mono font-medium tabular-nums">{progress.doneCount}</span> of{' '}
          <span className="font-mono tabular-nums">{progress.totalCount}</span> steps done
        </span>
        {Object.entries(progress.byPhase).map(([phase, p]) => (
          <span key={phase} className="text-xs text-neutral-500 dark:text-neutral-500">
            Phase {phase}: {p.done}/{p.total}
          </span>
        ))}
      </div>

      {/* ── Gaps: what is still needed, computed rather than listed ──────────────────── */}
      {(gaps.countsWithoutCost.length > 0 || gaps.doubleCounted.length > 0) && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">Still needed</h2>
          {/* ⭐ A checklist says "enter opening balances". A guide says which ones, by name. */}
          {gaps.countsWithoutCost.length > 0 && (
            <div className="text-sm">
              <span className="text-neutral-600 dark:text-neutral-400">
                {gaps.countsWithoutCost.length} counted item
                {gaps.countsWithoutCost.length === 1 ? '' : 's'} with no cost yet —{' '}
              </span>
              <span className="text-neutral-800 dark:text-neutral-200">
                {gaps.countsWithoutCost.slice(0, 4).map((c) => c.name).join(', ')}
                {gaps.countsWithoutCost.length > 4 ? '…' : ''}
              </span>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
                A quantity nobody can value cannot become an opening figure.
              </p>
            </div>
          )}
          {gaps.doubleCounted.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <strong className="font-medium">
                {gaps.doubleCounted.length} part
                {gaps.doubleCounted.length === 1 ? 'y has' : 'ies have'} the same money twice.
              </strong>
              <p className="mt-1 text-xs">
                An opening balance was entered for them, and a document dated before the conversion
                also exists. One of the two has to go, or the balance is double what is owed.
              </p>
            </div>
          )}
        </section>
      )}

      {/* ── The steps ────────────────────────────────────────────────────────────────── */}
      {(['A', 'B', 'C'] as const).map((phase) => (
        <section key={phase} className="space-y-3">
          <h2 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {PHASE_TITLE[phase]}
          </h2>
          <div className="space-y-3">
            {progress.steps
              .filter((s) => s.def.phase === phase)
              .map((s) => (
                <article
                  key={`${s.def.code}:${s.storeId ?? ''}`}
                  className={`rounded-lg border p-4 ${
                    s.done
                      ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20'
                      : s.blockedBy
                        ? 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/40'
                        : 'border-neutral-200 dark:border-neutral-800'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium">
                        <span className="font-mono text-xs text-neutral-500 dark:text-neutral-500">
                          {s.def.code}
                        </span>{' '}
                        {s.def.title}
                        {s.storeId && (
                          <span className="ml-2 text-sm font-normal text-neutral-600 dark:text-neutral-400">
                            — {storeName(s.storeId)}
                          </span>
                        )}
                      </h3>
                    </div>
                    <span
                      className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${
                        s.done
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400'
                      }`}
                    >
                      {s.done ? 'Done' : 'Outstanding'}
                    </span>
                  </div>

                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-500">
                    {kindLabel(s.def.kind, s.def.cannotVerifyHere)}
                    {/*
                      ⚠️ An attestation must NEVER look like a verified tick. Saying so is the
                      honest thing — no system studied does better on a physical count either.
                      ⛔ But only where it ADDS something: a step already labelled "stated by a
                      person" does not need "not machine-verifiable" bolted on after it.
                    */}
                    {s.def.kind !== 'attested' && !s.machineVerifiable && ' · nobody can check this for you'}
                  </p>

                  {/* Why the step exists at all — the reasoning, not just the label. */}
                  <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{s.def.why}</p>

                  {s.def.cannotVerifyHere && (
                    <p className="mt-2 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                      This was meant to be checked automatically, and cannot be:{' '}
                      {s.def.cannotVerifyHere}
                    </p>
                  )}

                  {/* ⭐ Blocked steps say what to go and do. Hidden steps do not. */}
                  {s.blockedBy && (
                    <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      {s.blockedBy}
                    </p>
                  )}

                  {s.detail && !s.blockedBy && (
                    <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{s.detail}</p>
                  )}

                  {s.completedAt && (
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-500">
                      Recorded {new Date(s.completedAt).toLocaleString('en-PH')}
                    </p>
                  )}

                  {(s.def.code === 'C3' || s.def.code === 'C5') && !s.blockedBy && (
                    <Link
                      href="/cutover/opening"
                      className="mt-3 inline-block rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      {s.def.code === 'C3' ? 'Enter opening balances' : 'Review and post'}
                    </Link>
                  )}

                  {s.def.code === 'B3' && s.storeId && !s.done && (
                    <Link
                      href={`/cutover/count?store=${s.storeId}`}
                      className="mt-3 inline-block rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
                    >
                      Enter the count
                    </Link>
                  )}

                  {/* ⛔ No form on a verified step — a query decides it, and the domain refuses a
                      hand-tick anyway. The absence of a button IS the message. */}
                  {!s.done && !s.blockedBy && s.def.kind !== 'verified' && (
                    <form action={attestStepAction} className="mt-3 space-y-2">
                      <input type="hidden" name="stepCode" value={s.def.code} />
                      <input type="hidden" name="storeId" value={s.storeId ?? ''} />
                      <input
                        type="text"
                        name="note"
                        placeholder="What you did, in your words (optional)"
                        className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      <button
                        type="submit"
                        className="w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white sm:w-auto dark:bg-neutral-100 dark:text-neutral-900"
                      >
                        I confirm this is done
                      </button>
                    </form>
                  )}

                  {/* An A1/A2-style step is declared verified but cannot be checked here, so it
                      still takes an attestation — and says why above. */}
                  {!s.done && !s.blockedBy && s.def.kind === 'verified' && s.def.cannotVerifyHere && (
                    <form action={attestStepAction} className="mt-3 space-y-2">
                      <input type="hidden" name="stepCode" value={s.def.code} />
                      <input type="hidden" name="storeId" value={s.storeId ?? ''} />
                      <input
                        type="text"
                        name="note"
                        placeholder="What you did, in your words (optional)"
                        className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      <button
                        type="submit"
                        className="w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white sm:w-auto dark:bg-neutral-100 dark:text-neutral-900"
                      >
                        I confirm this is done
                      </button>
                    </form>
                  )}
                </article>
              ))}
          </div>
        </section>
      ))}
    </Page>
  );
}

import Link from 'next/link';
import { isZero, money } from '@shareat/core/money';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requireSession } from '../../lib/session';
import { attestStepAction } from './actions';
import { PHASE_TITLE, kindLabel, listStores, loadGaps, loadProgress, peso } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Button, DisclosureCard, FlashBanner, Input } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Opening balances — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

type Step = Awaited<ReturnType<typeof loadProgress>>['steps'][number];

/** One step is one thing to do: the same code can run once per store, so the store id is part of the key. */
const stepKey = (s: Step): string => `${s.def.code}:${s.storeId ?? ''}`;
/** The in-page anchor of a step (the "Next:" banner links to it). */
const stepAnchor = (s: Step): string => `step-${s.def.code}${s.storeId ? `-${s.storeId}` : ''}`;

export default async function CutoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/opening-balances');

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

  // T-599 S3: the first step that is not done and not waiting on another one is the one to do now. It opens; the rest fold.
  const nextStep = progress.steps.find((s) => !s.done && !s.blockedBy) ?? null;
  const stepTitle = (s: Step): string => (s.storeId ? `${s.def.title} — ${storeName(s.storeId)}` : s.def.title);

  const residual = Number(progress.openingResidual);
  // T-371 C4: balanced is decided in centavos on the minted figure; `residual` is display-only.
  const balanced = isZero(money(progress.openingResidual));

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Opening balances: 1 January 2027</h1>
        <PageDescription>
          Entering what the business holds, owns and owes, so these books can open. It runs twice, once as a rehearsal in
          November and once for real, and you can pick it up and put it down over several days.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {/*
        ⭐ THE RUNNING RESIDUAL IS THE WHOLE DESIGN.

        Most accounting software plugs a difference like this into a suspense account so the books
        can open anyway. That is real, and it is scale-driven — those vendors serve millions of
        self-serve tenants who cannot get a human's attention. One company, one switch-over, Ian
        available: we halt instead.

        ⚠️ But the plug account buys one genuinely useful thing, and this is it: the difference is
        a NUMBER YOU CAN WATCH while you type, not a verdict at the end. An imbalance found on the
        tenth supplier is a typo; the same imbalance found after the last one is an investigation.
      */}
      <section
        className={`rounded-lg border p-4 sm:p-5 ${
          balanced
            ? 'border-success bg-success-soft'
            : 'border-warning-ink bg-warning-soft'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span
            className={`text-sm font-medium ${
              balanced ? 'text-success' : 'text-warning-ink'
            }`}
          >
            {balanced ? 'The opening entry balances' : 'Difference still to explain'}
          </span>
          <span
            className={`font-mono text-2xl font-semibold tabular-nums ${
              balanced ? 'text-success' : 'text-warning-ink'
            }`}
          >
            {peso(Math.abs(residual))}
          </span>
        </div>
        <p
          className={`mt-1 text-xs ${
            balanced ? 'text-success' : 'text-warning-ink'
          }`}
        >
          {balanced
            ? 'The opening figures add up. Nothing is left over.'
            : 'This updates as you enter figures. A difference cannot be parked anywhere; it has to be found.'}
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

      {nextStep && (
        <Banner tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <strong>Next:</strong> {stepTitle(nextStep)}
            </span>
            <a
              href={`#${stepAnchor(nextStep)}`}
              className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
            >
              Go to this step
            </a>
          </div>
        </Banner>
      )}

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
            <Banner tone="error">
              <strong className="font-medium">
                {gaps.doubleCounted.length} part
                {gaps.doubleCounted.length === 1 ? 'y has' : 'ies have'} the same money twice.
              </strong>
              <p className="mt-1 text-xs">
                An opening balance was entered for them, and a document dated before the opening date
                also exists. One of the two has to go, or the balance is double what is owed.
              </p>
            </Banner>
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
                <DisclosureCard
                  key={stepKey(s)}
                  id={stepAnchor(s)}
                  title={stepTitle(s)}
                  action={null}
                  open={nextStep !== null && stepKey(s) === stepKey(nextStep)}
                  className={
                    s.done
                      ? '!border-success !bg-success-soft'
                      : nextStep !== null && stepKey(s) === stepKey(nextStep)
                        ? '!border-ink'
                        : s.blockedBy
                          ? '!bg-neutral-50 dark:!bg-neutral-900/40'
                          : ''
                  }
                  meta={
                    <>
                      <Badge
                        tone={s.done ? 'success' : nextStep !== null && stepKey(s) === stepKey(nextStep) ? 'progress' : 'closed'}
                        label={s.done ? 'Done' : nextStep !== null && stepKey(s) === stepKey(nextStep) ? 'Do this next' : s.blockedBy ? 'Waiting' : 'To do'}
                        className="shrink-0"
                      />
                      {s.done && s.completedAt ? <span className="ml-2">Recorded {formatBusinessDateTime(new Date(s.completedAt))}</span> : null}
                    </>
                  }
                >
                  <p className="text-xs text-neutral-500 dark:text-neutral-500">
                    {kindLabel(s.def.kind, s.def.cannotVerifyHere)}
                    {/*
                      ⚠️ An attestation must NEVER look like a verified tick. Saying so is the
                      honest thing — no system studied does better on a physical count either.
                      ⛔ But only where it ADDS something: a step already labelled "stated by a
                      person" does not need "not machine-verifiable" bolted on after it.
                    */}
                    {s.def.kind !== 'attested' && !s.machineVerifiable && !s.def.cannotVerifyHere && ' · this cannot be checked automatically'}
                  </p>

                  {/* Why the step exists at all — the reasoning, not just the label. */}
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">{s.def.why}</p>

                  {s.def.cannotVerifyHere && (
                    <p className="mt-2 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
                      This was meant to be checked automatically, and cannot be:{' '}
                      {s.def.cannotVerifyHere}
                    </p>
                  )}

                  {/* ⭐ Blocked steps say what to go and do. Hidden steps do not. */}
                  {s.blockedBy && (
                    <Banner tone="warning">
                      {s.blockedBy}
                    </Banner>
                  )}

                  {s.detail && !s.blockedBy && (
                    <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{s.detail}</p>
                  )}

                  {s.completedAt && (
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-500">
                      Recorded {formatBusinessDateTime(new Date(s.completedAt))}
                    </p>
                  )}

                  {(s.def.code === 'C3' || s.def.code === 'C5') && !s.blockedBy && (
                    <Link
                      href="/opening-balances/balance-sheet"
                      className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      {s.def.code === 'C3' ? 'Enter opening balances' : 'Review and post'}
                    </Link>
                  )}

                  {s.def.code === 'B3' && s.storeId && !s.done && (
                    <Link
                      href={`/opening-balances/stock-count?store=${s.storeId}`}
                      className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      Enter the count
                    </Link>
                  )}

                  {/* ⛔ No form on a verified step — a query decides it, and the domain refuses a
                      hand-tick anyway. The absence of a button IS the message. */}
                  {!s.done && !s.blockedBy && s.def.kind !== 'verified' && (
                    <form action={attestStepAction} className="space-y-2">
                      <input type="hidden" name="stepCode" value={s.def.code} />
                      <input type="hidden" name="storeId" value={s.storeId ?? ''} />
                      <Input
                        type="text"
                        name="note"
                        placeholder="What you did, in your words (optional)"
                        className="w-full"
                      />
                      <Button type="submit" variant="secondary" className="w-full sm:w-auto">
                        I confirm this is done
                      </Button>
                    </form>
                  )}

                  {/* A step declared verified but cannot be checked here, so it
                      still takes an attestation — and says why above. */}
                  {!s.done && !s.blockedBy && s.def.kind === 'verified' && s.def.cannotVerifyHere && (
                    <form action={attestStepAction} className="space-y-2">
                      <input type="hidden" name="stepCode" value={s.def.code} />
                      <input type="hidden" name="storeId" value={s.storeId ?? ''} />
                      <Input
                        type="text"
                        name="note"
                        placeholder="What you did, in your words (optional)"
                        className="w-full"
                      />
                      <Button type="submit" variant="secondary" className="w-full sm:w-auto">
                        I confirm this is done
                      </Button>
                    </form>
                  )}
                </DisclosureCard>
              ))}
          </div>
        </section>
      ))}
    </Page>
  );
}

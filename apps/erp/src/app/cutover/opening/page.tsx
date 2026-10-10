import Link from 'next/link';
import { compare, isZero, money, ZERO } from '@shareat/core/money';
import { requireSession } from '../../../lib/session';
import {
  addOpeningFigureAction,
  postOpeningBalancesAction,
  removeOpeningFigureAction,
} from '../actions';
import {
  CONVERSION_DATE,
  listStores,
  loadGaps,
  loadOpeningDrafts,
  loadPostableAccounts,
  peso,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, FlashBanner, FormGrid, Field, Input, Select } from '@/components/ui';

export const metadata = { title: 'Opening balances — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  posted?: string;
}

export default async function OpeningPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/cutover/opening');

  const [stores, drafts, accounts, gaps] = await Promise.all([
    listStores(actor.orgId),
    loadOpeningDrafts(actor.orgId),
    loadPostableAccounts(actor.orgId),
    loadGaps(actor.orgId),
  ]);

  const residual = Number(gaps.residual);
  // T-371 C4: balanced is decided in centavos on the minted figure; `residual` is display-only.
  const balanced = isZero(money(gaps.residual));
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? '—';

  return (
    <Page density="table">
      <div>
        <Link
          href="/cutover"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
        >
          ← Back to the conversion
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening balances</h1>
        <PageDescription>
          What the business owns and owes on the morning the new books open. Enter them over as
          many days as it takes — nothing is final until you post at the end.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {sp.posted === '1' && (
        <Banner tone="success">
          <strong className="font-medium">The books are open.</strong> The opening entry is posted
          and can no longer be edited — a correction from here is a reversal.
        </Banner>
      )}

      {/* ⭐ The same running difference as the wizard, because it is the same question. Watching it
          while you type is what stops the last supplier being the moment you find out. */}
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
            {balanced ? 'Everything balances' : 'Difference still to explain'}
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
            ? drafts.length > 0
              ? 'Ready to post. Everything entered so far accounts for itself.'
              : 'Nothing entered yet.'
            : 'Something on one side has no matching figure on the other. It has to be found — there is nowhere to park it.'}
        </p>
      </section>

      {/* ── What is still needed ─────────────────────────────────────────────────────── */}
      {gaps.doubleCounted.length > 0 && (
        <Banner tone="error">
          <strong className="font-medium">
            {gaps.doubleCounted.length} part
            {gaps.doubleCounted.length === 1 ? 'y has' : 'ies have'} the same money twice.
          </strong>
          <p className="mt-1 text-xs">
            An opening balance was entered for them, and a document dated before the conversion also
            exists. One of the two has to go.
          </p>
        </Banner>
      )}

      {/* ── Add a figure ─────────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Add a figure</h2>
        <form action={addOpeningFigureAction} className="mt-3 space-y-3">
          <input type="hidden" name="entryDate" value={CONVERSION_DATE} />
          <FormGrid>
            <Field label="Account">
              <Select name="accountCode" required className="mt-1 w-full">
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Store">
              <Select name="storeId" required className="mt-1 w-full">
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owns or owes">
              <Select name="direction" required className="mt-1 w-full">
                {/* Plain words, because "debit" and "credit" are the thing people get backwards. */}
                <option value="debit">We have this (asset)</option>
                <option value="credit">We owe this (liability)</option>
              </Select>
            </Field>
            <Field label="Amount">
              <input
                name="amount"
                required
                inputMode="decimal"
                placeholder="0.00"
                className="mt-1 w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
              />
            </Field>
          </FormGrid>
          <Input type="text" name="memo" placeholder="What this is (optional)" className="w-full" />
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            Save
          </Button>
        </form>
      </section>

      {/* ── What has been entered ────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          Entered so far{' '}
          <span className="font-normal text-neutral-500 dark:text-neutral-500">
            ({drafts.length})
          </span>
        </h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Nothing yet. Everything you add stays editable until you post.
          </p>
        ) : (
          drafts.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="min-w-0">
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-500">
                  {d.accountCode}
                </span>{' '}
                <span className="text-sm">{d.memo}</span>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-500">
                  {storeName(d.storeId)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm tabular-nums">
                  {compare(money(d.debit), ZERO) > 0 ? peso(Number(d.debit)) : `(${peso(Number(d.credit))})`}
                </span>
                {/* A draft was never final, so removing one is a delete rather than a reversal. */}
                <form action={removeOpeningFigureAction}>
                  <input type="hidden" name="entryId" value={d.id} />
                  <Button type="submit" variant="danger">
                    Remove
                  </Button>
                </form>
              </div>
            </div>
          ))
        )}
      </section>

      {/* ── Post ─────────────────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Open the books</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Posting makes every figure above final. After this a correction is a reversal, not an
          edit.
        </p>
        {/*
          ⛔ The button is ABSENT, not disabled, when it cannot run — and the reason is written
          where the button would be. A greyed-out control invites clicking it to find out why.
        */}
        {balanced && drafts.length > 0 ? (
          <form action={postOpeningBalancesAction} className="mt-3">
            <Button type="submit" variant="primary" className="w-full sm:w-auto">
              Post the opening balances
            </Button>
          </form>
        ) : (
          <Banner tone="warning" className="mt-3">
            {drafts.length === 0
              ? 'Nothing to post yet.'
              : `₱${Math.abs(residual).toFixed(2)} is still unexplained, so this cannot be posted. There is no holding account to put it in — the difference has to be found.`}
          </Banner>
        )}
      </section>
    </Page>
  );
}

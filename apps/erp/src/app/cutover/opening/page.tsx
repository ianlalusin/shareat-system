import Link from 'next/link';
import { compare, isZero, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import {
  addOpeningFigureAction,
  attestStepAction,
  postOpeningBalancesAction,
  removeOpeningFigureAction,
  valueOpeningAssetAction,
  valueOpeningStockAction,
} from '../actions';
import {
  CONVERSION_DATE,
  countedValueFor,
  listStores,
  loadGaps,
  loadOpeningDrafts,
  loadPartyOptions,
  loadPendingShells,
  loadPostableAccounts,
  loadProgress,
  loadTieOut,
  peso,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { CUTOVER_ASSET_RULES, CUTOVER_FIGURE_RULES, nativeAttrs } from '@shareat/domain/field-rules';

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
  const { actor, refusal } = await requirePageAccess('/cutover/opening');
  if (refusal) return refusal;

  const [stores, drafts, accounts, gaps, parties, shells, tie] = await Promise.all([
    listStores(actor.orgId),
    loadOpeningDrafts(actor.orgId),
    loadPostableAccounts(actor.orgId),
    loadGaps(actor.orgId),
    loadPartyOptions(actor.orgId),
    loadPendingShells(actor.orgId),
    loadTieOut(actor.orgId),
  ]);
  const [progress, counted] = await Promise.all([
    loadProgress(actor.orgId, stores.map((s) => s.id)),
    Promise.all(stores.map(async (s) => ({ store: s, value: await countedValueFor(actor.orgId, s.id) }))),
  ]);
  const tieSteps = progress.steps.filter((x) => ['C3P', 'C4', 'C5'].includes(x.def.code));
  const INPUT = 'mt-1 w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900';
  const BUTTON = 'rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900';

  const residual = Number(gaps.residual);
  // T-371 C4: balanced is decided in centavos on the minted figure; `residual` is display-only.
  const balanced = isZero(money(gaps.residual));
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? '—';

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-4">
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
        <FormModal trigger="+ Add opening figure" title="Add an opening figure" size="md">
        <CheckedForm rules={CUTOVER_FIGURE_RULES} action={addOpeningFigureAction} className="space-y-3">
          <input type="hidden" name="entryDate" value={CONVERSION_DATE} />
          <FormGrid>
            <Field label="Account" rule={CUTOVER_FIGURE_RULES.accountCode}>
              <Select {...nativeAttrs(CUTOVER_FIGURE_RULES.accountCode)} className="mt-1 w-full">
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Store" rule={CUTOVER_FIGURE_RULES.storeId}>
              <Select {...nativeAttrs(CUTOVER_FIGURE_RULES.storeId)} className="mt-1 w-full">
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owns or owes" rule={CUTOVER_FIGURE_RULES.direction}>
              <Select {...nativeAttrs(CUTOVER_FIGURE_RULES.direction)} className="mt-1 w-full">
                {/* Plain words, because "debit" and "credit" are the thing people get backwards. */}
                <option value="debit">We have this (asset)</option>
                <option value="credit">We owe this (liability)</option>
              </Select>
            </Field>
            <Field label="Amount" rule={CUTOVER_FIGURE_RULES.amount}>
              <input
                {...nativeAttrs(CUTOVER_FIGURE_RULES.amount)}
                placeholder="0.00"
                className="mt-1 w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
              />
            </Field>
            <Field label="Party kind (suppliers and customers only)">
              <select name="partyType" className={INPUT} defaultValue="">
                <option value="">No party</option>
                <option value="supplier">Supplier</option>
                <option value="customer">Customer</option>
              </select>
            </Field>
            <Field label="Party">
              <select name="partyId" className={INPUT} defaultValue="">
                <option value="">No party</option>
                {parties.map((p) => (
                  <option key={`${p.type}:${p.id}`} value={p.id}>
                    {p.name} ({p.type})
                  </option>
                ))}
              </select>
            </Field>
          </FormGrid>
          <Input type="text" name="memo" placeholder="What this is (optional)" className="w-full" />
          <Button type="submit" variant="secondary" className="w-full sm:w-auto">
            Save
          </Button>
        </CheckedForm>
        </FormModal>
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

      {/* ── Value the count (R5) ─────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Value the count</h2>
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Inventory opens from the count, one entry per store. Press the button again after any change to the count; it rewrites that
          store&apos;s entry.
        </p>
        <div className="mt-3 space-y-2">
          {counted.map(({ store, value }) => (
            <form
              key={store.id}
              action={valueOpeningStockAction}
              className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <input type="hidden" name="storeId" value={store.id} />
              <span className="text-sm">
                {store.name} <span className="text-xs text-neutral-500">counted at cost {peso(Number(value))}</span>
              </span>
              <button type="submit" className={BUTTON}>
                Value the count
              </button>
            </form>
          ))}
        </div>
      </section>

      {/* ── Assets to value (R10) ────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Assets to value</h2>
        {shells.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">No asset is waiting for a value.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {shells.map((a) => (
              <CheckedForm key={a.id} rules={CUTOVER_ASSET_RULES} action={valueOpeningAssetAction} className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
                <input type="hidden" name="assetId" value={a.id} />
                <p className="text-sm font-medium">
                  {a.name} <span className="text-xs font-normal text-neutral-500">{storeName(a.storeId)}</span>
                </p>
                <FormGrid>
                  <Field label="Book value on the conversion date" rule={CUTOVER_ASSET_RULES.bookValue}>
                    <input {...nativeAttrs(CUTOVER_ASSET_RULES.bookValue)} placeholder="0.00" className={INPUT} />
                  </Field>
                  <Field label="Remaining life (whole months)" rule={CUTOVER_ASSET_RULES.remainingLifeMonths}>
                    <input {...nativeAttrs(CUTOVER_ASSET_RULES.remainingLifeMonths)} placeholder="e.g. 18" className={INPUT} />
                  </Field>
                  <Field label="Salvage value (optional)" rule={CUTOVER_ASSET_RULES.salvageValue}>
                    <input {...nativeAttrs(CUTOVER_ASSET_RULES.salvageValue)} placeholder="0.00" className={INPUT} />
                  </Field>
                </FormGrid>
                <button type="submit" className={BUTTON}>
                  Save
                </button>
              </CheckedForm>
            ))}
          </div>
        )}
      </section>

      {/* ── Tie-out (R9, R15) ────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Tie-out</h2>
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          Each register in the new system is compared with the opening figures. Party balances (customers, suppliers, loans, advances) are
          checked for valid parties only; their totals are compared with v1 at the rehearsal (T-394).
        </p>
        {tie.lines.length === 0 ? (
          <p className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            Every checked register ties to the opening figures.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {tie.lines.map((l, k) => (
              <li
                key={`${l.register}:${l.storeId ?? ''}:${l.account ?? ''}:${k}`}
                className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                {l.sentence}
              </li>
            ))}
          </ul>
        )}

        {tie.notChecked.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium">Not checked here</h3>
            <ul className="mt-1 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
              {tie.notChecked.map((n, k) => (
                <li key={`${n.account}:${k}`}>
                  <span className="font-mono">{n.account}</span> — {n.amount} — {n.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {tieSteps.map((st) => {
            const why = st.blockedBy ?? st.detail;
            return (
              <div key={`${st.def.code}:${st.storeId ?? ''}`} className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-mono text-xs">{st.def.code}</span> {st.def.title}
                  </span>
                  <span className="text-xs">{st.done ? 'Done' : st.blockedBy ? 'Blocked' : 'Not done'}</span>
                </div>
                {!st.done && why && <p className="mt-1 text-xs text-amber-800 dark:text-amber-400">{why}</p>}
                {st.def.code === 'C3P' && !st.done && (
                  <form action={attestStepAction} className="mt-2 space-y-2">
                    <input type="hidden" name="stepCode" value="C3P" />
                    <input type="hidden" name="returnTo" value="/cutover/opening" />
                    <input type="hidden" name="storeId" value="" />
                    <input type="text" name="note" placeholder="Which v1 lists you compared (optional)" className={INPUT} />
                    <button type="submit" className={BUTTON}>
                      I confirm this is done
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── What has been entered────────────────────────────────────────────────────── */}
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
                  <ConfirmDestructive
                    tier="admin-pin"
                    label="Remove opening figure"
                    consequence="Removes this opening figure. An administrator must approve with their own PIN."
                  />
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
            <ConfirmDestructive
              tier="admin-pin"
              label="Post the opening balances"
              consequence="Posts the opening balances to the books. An administrator must approve with their own PIN."
            />
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

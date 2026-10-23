import Link from 'next/link';
import { PREPAID_CATEGORIES } from '@shareat/db';
import { add, ZERO } from '@shareat/core/money';
import { SchedulerStatus } from '../../components/scheduler-status';
import { requirePageAccess } from '../../lib/page-access';
import { createPrepaidItemAction } from './actions';
import {
  CATEGORY_LABEL,
  STATUS_LABEL,
  listRegister,
  listStores,
  peso,
  reviewCount,
} from './lib';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { CheckedForm } from '@/components/forms';
import { PREPAID_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Field, FlashBanner, FormGrid, FormModal, FormSection, Input, LinkRow, RowLink, Select, statusTone } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Prepaid expenses — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  review?: string;
}

export default async function PrepaidPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/prepaid');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, all, needingReview] = await Promise.all([
    listStores(actor.orgId),
    listRegister(actor.orgId),
    reviewCount(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // The banner doubles as a filter — §11.2's "a place, not a notification".
  const onlyReview = sp.review === '1';
  const items = onlyReview ? all.filter((i) => i.needsReview && i.status === 'active') : all;

  const totalRemaining = all
    .filter((i) => i.status === 'active')
    .reduce((sum, i) => add(sum, i.remaining), ZERO);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Prepaid expenses</h1>
          <PageDescription>
            Things already paid for but not yet used up — a year of insurance, a mayor&apos;s permit,
            rent paid in advance. Each sits on the balance sheet and is released into the month it
            actually covers.
          </PageDescription>
        </div>
        {/* T-448: the add form is a modal opened from the header. */}
        <FormModal
          trigger="+ Record prepaid item"
          title="Record a prepaid item"
          description="Below ₱5,000 this is an ordinary expense, not a prepaid — the same threshold fixed assets use."
          size="md"
        >
          <CheckedForm rules={PREPAID_ADD_RULES} action={createPrepaidItemAction} className="space-y-4">
            <FormSection title="Prepaid item">
              <FormGrid layout="fields">
                <Field label="Name" width="name" hint="What it is, as somebody would say it out loud" rule={PREPAID_ADD_RULES.name}>
                  <Input {...nativeAttrs(PREPAID_ADD_RULES.name)} placeholder="Fire insurance 2026" className="w-full" />
                </Field>
                <Field label="Store" width="name" rule={PREPAID_ADD_RULES.storeId}>
                  <Select {...nativeAttrs(PREPAID_ADD_RULES.storeId)} defaultValue="" className="w-full">
                    <option value="">Choose a store…</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Kind" width="code">
                  <Select name="category" defaultValue="insurance" className="w-full">
                    {PREPAID_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c] ?? c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Coverage and cost">
              <FormGrid layout="fields">
                <Field label="Total cost" width="code" rule={PREPAID_ADD_RULES.totalCost}>
                  <input
                    {...nativeAttrs(PREPAID_ADD_RULES.totalCost)}
                    placeholder="0.00"
                    className={INPUT}
                  />
                </Field>
                <Field label="Coverage starts" width="date" hint="The first month the cover actually applies to" rule={PREPAID_ADD_RULES.coverageStartDate}>
                  <Input {...nativeAttrs(PREPAID_ADD_RULES.coverageStartDate)} type="date" className="w-full" />
                </Field>
                <Field
                  label="Coverage months"
                  width="short"
                  rule={PREPAID_ADD_RULES.coverageMonths}
                  hint="The CONTRACT's term — read it off the document, don't estimate. Released monthly, evenly, from the coverage start, with any odd centavos landing on the final month so the total is exact."
                >
                  <input
                    {...nativeAttrs(PREPAID_ADD_RULES.coverageMonths)}
                    defaultValue={12}
                    className={INPUT}
                  />
                </Field>
              </FormGrid>
            </FormSection>
            <FormGrid layout="fields">
              <Field label="Notes" width="long">
                <Input name="notes" className="w-full" />
              </Field>
            </FormGrid>
            {/* ⭐ No interval selector, deliberately (§10). A 12-month policy covers 12 months;
                charging it quarterly would recognise cost for months not yet covered, which is the
                error prepaid accounting exists to prevent. */}
            <SubmitButton pendingLabel="Recording…">Record prepaid item</SubmitButton>
          </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {/* ⭐ Is anybody keeping these books? Reads scheduler_runs, not the ledger — a run that
          posts nothing looks exactly like a run that never happened (T-140, DEF-044). */}
      <SchedulerStatus orgId={actor.orgId} job="amortisation" label="Amortisation" />

      {/*
        ⭐ THE REVIEW COUNTER IS THE WHOLE DESIGN (§11.2).

        Ian: "design that the review is obvious, not just a toast notif." A toast is gone in four
        seconds and is seen by whoever happened to be looking. An auto-created item with a GUESSED
        term posts a wrong amount every month, quietly, for years — and the only thing between that
        and the books is somebody noticing.

        ⚠️ It is NOT dismissible and nothing expires the queue. It reads zero when there is nothing
        to do, because a counter that is only ever present is a counter people stop seeing.
      */}
      {needingReview > 0 ? (
        <Banner tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong className="font-medium">
                {needingReview} item{needingReview === 1 ? '' : 's'} need
                {needingReview === 1 ? 's' : ''} a term confirmed.
              </strong>{' '}
              The amount and date came off the invoice; the coverage length was a guess. A wrong
              term is wrong in every month it posts.
            </div>
            <Link
              href={onlyReview ? '/prepaid' : '/prepaid?review=1'}
              className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
            >
              {onlyReview ? 'Show all items' : 'Show only these'}
            </Link>
          </div>
        </Banner>
      ) : (
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Nothing is waiting for review.
        </p>
      )}

      {all.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still unused, across every active item</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(totalRemaining)}</span>
          {/* ⛔ Summed from the register's derived figures, not read from a column. v1 had two
              independent code paths computing this number that never read from each other. */}
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Covers</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Released</th>
                <th className="px-3 py-2 text-right font-medium">Still unused</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <LinkRow
                  key={i.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    i.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <RowLink href={`/prepaid/${i.id}`}>
                      {i.name}
                    </RowLink>
                    {i.needsReview && i.status === 'active' && (
                      <Badge tone="warning" label="Term unconfirmed" className="ml-2" />
                    )}
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {CATEGORY_LABEL[i.category] ?? i.category}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(i.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {i.coverageStartDate} · {i.coverageMonths} mo
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.totalCost)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.amortised)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.remaining)}</td>
                  <td className="px-3 py-2 text-xs">
                    <Badge tone={statusTone(i.status)} label={STATUS_LABEL[i.status] ?? i.status} />
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {onlyReview ? 'Nothing needs review.' : 'No prepaid items yet.'}
        </p>
      )}
    </Page>
  );
}

// Kept raw: t343-s5-5w-number-boxes.test.ts reads these two boxes' `<input` source text.
const INPUT = 'w-full min-h-11 rounded-[10px] border border-field-border bg-field px-3 py-2 text-sm text-ink';

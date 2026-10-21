import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import {
  amortiseAction,
  confirmTermAction,
  reverseMonthAction,
  writeOffAction,
} from '../actions';
import { CATEGORY_LABEL, STATUS_LABEL, getDetail, peso, thisPeriod } from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, Button, ConfirmDestructive, FlashBanner, Input, Select } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import {
  PREPAID_MONTH_REVERSE_RULES,
  PREPAID_RELEASE_RULES,
  PREPAID_TERM_RULES,
  PREPAID_WRITE_OFF_RULES,
  nativeAttrs,
  type FieldRule,
} from '@shareat/domain/field-rules';
import { MONEY_ACCOUNT_CODES, accountLabel } from '@/lib/account-label';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Prepaid item — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  /** T-343 S5.5u item 3 — set by `writeOffAction` on a refusal, so the write-off form keeps what
   *  was typed instead of going blank (fixed-assets/[id]/page.tsx's `sp.reason` precedent). */
  reason?: string;
  refundAmount?: string;
  refundAccountCode?: string;
  /** S5.5u Amendment A1 item 1 — else a back-dated write-off resubmitted after a refusal silently
   *  reverts to today's date. */
  writtenOffOn?: string;
}

export default async function PrepaidItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const savedRefundCode = sp.refundAccountCode ?? '';
  const { actor, refusal } = await requirePageAccess(`/prepaid/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const item = await getDetail(actor.orgId, id);
  if (!item) notFound();

  const active = item.status === 'active';

  return (
    <Page view="detail" density="table">
      <div>
        <Link href="/prepaid" className="text-sm underline underline-offset-2">
          ← Prepaid expenses
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{item.name}</h1>
        <PageDescription>
          {CATEGORY_LABEL[item.category] ?? item.category} · {STATUS_LABEL[item.status]} · covers{' '}
          {item.coverageMonths} months from {item.coverageStartDate}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <DetailLayout
        summary={
          /* ── The three figures ──────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these tiles
                stay three-across inside a 320px rail. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-3 min-[1440px]:grid-cols-1">
              <Figure label="Cost" value={peso(item.totalCost)} />
              <Figure label="Released so far" value={peso(item.amortised)} />
              <Figure label="Still unused" value={peso(item.remaining)} emphasis />
            </div>
            {/* ⛔ None of these is a column. "Released" is summed from the ledger and "still unused"
                is cost minus that — so they cannot drift from the books, which is exactly what v1's
                stored amortizedToDate / remainingBookValue pair did. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Released and still-unused are summed from the ledger on load, never stored — so they
              cannot disagree with the books they describe.
            </p>
          </section>
        }
      >
      {/* ── The review, when the term was guessed ────────────────────────────────────── */}
      {item.needsReview && active && (
        <Banner tone="warning">
        <section className="space-y-3">
          <div className="text-sm">
            <strong className="font-medium">This term was a guess.</strong> The amount and date came
            off the invoice — only a person can say how long the cover actually runs. Confirm it or
            correct it.
            {item.sourceExpenseId && (
              <>
                {' '}
                <Link
                  href={`/expenses/${item.sourceExpenseId}`}
                  className="underline underline-offset-2"
                >
                  Open the expense it came from
                </Link>{' '}
                to see what was actually bought.
              </>
            )}
          </div>
          <CheckedForm rules={PREPAID_TERM_RULES} action={confirmTermAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="prepaidItemId" value={item.id} />
            <Field label="Starts" rule={PREPAID_TERM_RULES.coverageStartDate} tone="warning">
              <Input
                type="date"
                {...nativeAttrs(PREPAID_TERM_RULES.coverageStartDate)}
                defaultValue={item.coverageStartDate}
                className="w-full"
              />
            </Field>
            <Field label="Months" rule={PREPAID_TERM_RULES.coverageMonths} className="min-w-[6rem] flex-1" tone="warning">
              <input
                {...nativeAttrs(PREPAID_TERM_RULES.coverageMonths)}
                name="coverageMonths"
                inputMode="numeric"
                defaultValue={item.coverageMonths}
                className={INPUT}
              />
            </Field>
            <Button type="submit" variant="primary">Confirm term</Button>
          </CheckedForm>
        </section>
        </Banner>
      )}

      {/* ── The schedule ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Schedule</h2>
          {active && (
            <CheckedForm rules={PREPAID_RELEASE_RULES} action={amortiseAction} className="flex flex-wrap items-end gap-2 gap-y-2">
              <input type="hidden" name="prepaidItemId" value={item.id} />
              <Field label="Release through" rule={PREPAID_RELEASE_RULES.asOfPeriod}>
                <Input
                  type="month"
                  {...nativeAttrs(PREPAID_RELEASE_RULES.asOfPeriod)}
                  defaultValue={thisPeriod()}
                  className="w-full"
                />
              </Field>
              <Button type="submit" variant="secondary">
                Release
              </Button>
            </CheckedForm>
          )}
        </div>

        {/* ⭐ Running it again is SAFE and is how you catch up — months already out no-op. v1's
            scheduler silently stopped for two months and its register still looked fine, because
            the register was a maintained column (DEF-044). */}
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Releasing is safe to repeat: months already posted are skipped, so catching up after a
          missed run is just running it again.
        </p>

        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">Posts on</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {item.schedule.map((p) => (
                <tr
                  key={p.period}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2 font-mono">{p.period}</td>
                  <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{p.entryDate}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(p.amount)}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.posted ? (
                      <span className="text-success">Released</span>
                    ) : (
                      <span className="text-neutral-400 dark:text-neutral-600">Not yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/*
                      ⭐ REVERSING ONE MONTH — v1 cannot do this at all.

                      Its only undo cascade-voids every leg including the original purchase, so
                      fixing one bad month means re-creating the item and re-running every prior
                      period. It is nearly free here because the balance is derived: reversing the
                      entry IS the fix, with no column to repair.
                    */}
                    {p.posted && (
                      <CheckedForm rules={PREPAID_MONTH_REVERSE_RULES} action={reverseMonthAction} className="flex justify-end gap-1">
                        <input type="hidden" name="prepaidItemId" value={item.id} />
                        <input type="hidden" name="period" value={p.period} />
                        <Field label={<span className="sr-only">Reason for reversing this month</span>} rule={PREPAID_MONTH_REVERSE_RULES.reason}>
                          <Input {...nativeAttrs(PREPAID_MONTH_REVERSE_RULES.reason)} placeholder="Reason…" className="w-28 text-xs" />
                        </Field>
                        <ConfirmDestructive
                          tier="admin-pin"
                          label="Reverse month"
                          consequence="Reverses this month's release. An administrator must approve with their own PIN."
                        />
                      </CheckedForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Early termination ────────────────────────────────────────────────────────── */}
      {active && compare(item.remaining, ZERO) > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">End it early</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Whatever is left is recognised now. If some money came back, say how much — a refund
              is cash returning, not income.
            </p>
          </div>
          <CheckedForm rules={PREPAID_WRITE_OFF_RULES} action={writeOffAction} className="space-y-4">
            <input type="hidden" name="prepaidItemId" value={item.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date" rule={PREPAID_WRITE_OFF_RULES.writtenOffOn}>
                <Input
                  type="date"
                  {...nativeAttrs(PREPAID_WRITE_OFF_RULES.writtenOffOn)}
                  defaultValue={sp.writtenOffOn ?? toBusinessDate()}
                  className="w-full"
                />
              </Field>
              <Field label="Reason" rule={PREPAID_WRITE_OFF_RULES.reason}>
                <Input {...nativeAttrs(PREPAID_WRITE_OFF_RULES.reason)} defaultValue={sp.reason ?? ''} className="w-full" />
              </Field>
              <Field
                label="Refunded"
                hint={`Leave blank if nothing came back. At most ${peso(item.remaining)}`}
                rule={PREPAID_WRITE_OFF_RULES.refundAmount}
              >
                <Input
                  {...nativeAttrs(PREPAID_WRITE_OFF_RULES.refundAmount)}
                  defaultValue={sp.refundAmount ?? ''}
                  className="w-full"
                />
              </Field>
              <Field label="Refund landed in" hint="Pick the cash or e-wallet account the refund went into.">
                <Select name="refundAccountCode" defaultValue={sp.refundAccountCode ?? ''} className="w-full">
                  <option value="">Choose an account</option>
                  {savedRefundCode !== '' && !(MONEY_ACCOUNT_CODES as readonly string[]).includes(savedRefundCode) && (
                    <option value={savedRefundCode}>{accountLabel(savedRefundCode)}</option>
                  )}
                  {MONEY_ACCOUNT_CODES.map((code) => (
                    <option key={code} value={code}>
                      {accountLabel(code)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {/* ⚠️ The trap worth naming on the page: booking the whole remainder as expense AND
                the refund as income double-counts the cancellation — and the entry still balances,
                so nothing would catch it. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Only the part that did <strong>not</strong> come back reaches the P&amp;L. The refund
              moves from one balance-sheet account to another.
            </p>
            <ConfirmDestructive
              tier="admin-pin"
              label="Write it off"
              consequence="Writes off what is left of this prepaid item. An administrator must approve with their own PIN."
            />
          </CheckedForm>
        </section>
      )}

      {item.status === 'written_off' && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <strong className="font-medium">Written off {item.writtenOffOn}.</strong>{' '}
          {item.writeOffReason}
        </div>
      )}
      </DetailLayout>
    </Page>
  );
}

// Kept raw: t343-s5-5w-number-boxes.test.ts reads this box's `<input` source text.
const INPUT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div
        className={`font-mono tabular-nums ${emphasis ? 'text-lg font-medium' : 'text-lg'}`}
      >
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  rule,
  className,
  tone,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  rule?: FieldRule;
  className?: string;
  tone?: 'warning';
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className={`text-xs font-medium ${tone === 'warning' ? 'text-warning-ink' : 'text-neutral-600 dark:text-neutral-400'}`}>{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field puts its live helper line OUTSIDE the label, so the line never joins the accessible name.
  if (!rule) return <label className={`flex flex-col gap-1${className ? ` ${className}` : ''}`}>{body}</label>;
  return (
    <div className={className}>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

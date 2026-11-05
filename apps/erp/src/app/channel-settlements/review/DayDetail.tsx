/**
 * T-511 S5b - one staged day, opened from the review table (?day=<id>). A server component: it prints what `getReviewDayDetail` returned, in plain words, and
 * offers the decisions the person may make. It queries nothing and books nothing. There is no booking button here: booking a day arrives in slice 7.
 * Order on the screen is the order a manager asks the questions: does the file match what staff recorded, what will the books say, what stops this day, what
 * did the platform take, what about the loan, then the decision.
 */
import { add, money, ZERO } from '@shareat/core/money';
import type { ReviewDayDetail } from '@shareat/domain';
import { SETTLEMENT_DAY_REJECT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { ACTION_LINK } from '@/components/action-link';
import { CheckedForm } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Badge, Banner, Field, FormModal, Input, Select, Textarea } from '@/components/ui';
import { peso } from '@/lib/format';
import type { LoanOption } from '../lib';
import { overrideLoanAllocationAction, rejectDayAction, reopenDayAction } from './actions';
import { RejectReasonHint } from './RejectReasonHint';
import { bookedAsWord, differenceWords, isNonZero, loanLineDetails, loanWord, noteText, ordersHint, otherKindWord, platformWord, shortDate, stateWord, type ReviewFilterValues } from './words';

export interface DayDetailAccess {
  canReject: boolean;
  canReopen: boolean;
  canOverrideLoans: boolean;
}

/** The page's filters, posted back by every review form so a refused action returns to the same list (hidden boxes: a closed set of words, never typed text). */
export function FilterFields({ filters }: { readonly filters: ReviewFilterValues }) {
  const { store, platform, period, needs } = filters;
  return (
    <>
      {store ? <input type="hidden" name="store" value={store} /> : null}
      {platform ? <input type="hidden" name="platform" value={platform} /> : null}
      {period ? <input type="hidden" name="period" value={period} /> : null}
      {needs ? <input type="hidden" name="needs" value="1" /> : null}
    </>
  );
}

function Figure({ label, value, note }: { readonly label: string; readonly value: string; readonly note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-sm">{note}</dd> : null}
    </div>
  );
}

/**
 * Label and amount pairs (what Grab took, the orders of a day): a plain list, not a table. In a phone card a two-column table put a meaningless initial in a
 * circle beside every row and cut the label short; here the label wraps and the amount stays on the right.
 */
function AmountList({ rows, columns = false }: { readonly rows: readonly { readonly label: string; readonly amount: string }[]; readonly columns?: boolean }) {
  return (
    <dl className={`overflow-hidden rounded-[20px] border border-surface-border ${columns ? 'sm:grid sm:grid-cols-2 sm:gap-x-6 lg:grid-cols-3' : ''}`}>
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="flex items-baseline justify-between gap-4 border-b border-surface-border px-3 py-2 last:border-b-0">
          <dt className="min-w-0">{r.label}</dt>
          {/* a figure stays whole ("-" never alone on a line); only a sentence in the amount place may wrap */}
          <dd className={`text-right tabular-nums ${r.amount.length <= 16 ? 'shrink-0 whitespace-nowrap' : 'min-w-0'}`}>{r.amount}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One line of the file per item: the name and amount on top, what else is worth knowing below, with the words wrapping instead of being cut. */
function LineItems({ items }: { readonly items: readonly { readonly title: string; readonly amount: string; readonly details: readonly string[] }[] }) {
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={`${it.title}-${it.amount}-${i}`} className="rounded-[20px] border border-surface-border px-3 py-2">
          <div className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 font-medium">{it.title}</span>
            <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{it.amount}</span>
          </div>
          {it.details.map((d) => (
            <p key={d} className="text-sm">
              {d}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function DayDetail({
  detail,
  access,
  loans,
  backHref,
  filters,
}: {
  readonly detail: ReviewDayDetail;
  readonly access: DayDetailAccess;
  readonly loans: readonly LoanOption[];
  readonly backHref: string;
  readonly filters: ReviewFilterValues;
}) {
  const state = stateWord(detail.reviewState);
  const differs = isNonZero(detail.difference);
  const deductions = detail.loan.lines.filter((l) => l.kind === 'deduction');
  const deductionTotal = add(ZERO, ...deductions.map((l) => money(l.amount)));
  const grab = detail.platform === 'grab';

  return (
    <section className="space-y-5 rounded-[20px] border border-surface-border p-4 md:p-5" aria-label="Day detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold">
            {detail.storeName}, {platformWord(detail.platform)}, {shortDate(detail.salesDate)}
          </h2>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge tone={state.tone} label={state.label} />
            {detail.changedSinceBooked ? <Badge tone="warning" label="Changed since it was booked" /> : null}
          </span>
        </div>
        <a href={backHref} className={ACTION_LINK}>
          Back to the list
        </a>
      </div>
      {detail.reviewState === 'rejected' && detail.decisionReason ? <p className="text-sm">Rejected because: {detail.decisionReason}</p> : null}

      <div className="space-y-2">
        <h3 className="font-medium">Does the file match what staff recorded?</h3>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure label="Figure in the file" value={peso(detail.fileFigure)} />
          <Figure label="Staff recorded" value={detail.staffFigure === null ? 'Not recorded yet' : peso(detail.staffFigure)} />
          <Figure label="Difference" value={detail.difference === null ? 'Not known yet' : peso(detail.difference)} note={detail.difference === null ? undefined : differenceWords(detail.difference)} />
        </dl>
        {differs ? (
          detail.orders.length > 0 ? (
            <div className="space-y-1">
              <p className="text-sm">{ordersHint(detail.platform, detail.difference)}</p>
              <AmountList columns rows={detail.orders.map((o) => ({ label: o.time ?? 'Date only', amount: peso(o.amount) }))} />
            </div>
          ) : (
            <p className="text-sm">The orders could not be read again from the stored file.</p>
          )
        ) : null}
      </div>

      {/* both are about booking the day, so only a day still waiting for a decision shows them */}
      {detail.reviewState === 'pending' && detail.salesCorrection ? <Banner tone="info">{detail.salesCorrection.sentence}</Banner> : null}
      {detail.reviewState === 'pending' && detail.postNote ? <p className="text-sm">{detail.postNote}</p> : null}

      {detail.reviewState === 'pending' ? (
        <div className="space-y-1">
          <h3 className="font-medium">What stops this day from being booked</h3>
          {detail.blockers.length === 0 ? (
            <p className="text-sm">Nothing. This day is ready.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {detail.blockers.map((b) => (
                <li key={b.sentence}>{b.sentence}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="space-y-1">
        <h3 className="font-medium">What {platformWord(detail.platform)} took</h3>
        <AmountList
          rows={[
            { label: 'Commission', amount: peso(detail.charges.commission) },
            { label: 'Advertising', amount: peso(detail.charges.marketing) },
            { label: 'Platform fee and taxes', amount: peso(detail.charges.platformFee) },
            ...(detail.vatOnFees !== null
              ? [{ label: "VAT on this invoice's fees, all days together (already inside the platform fee and taxes of its days)", amount: peso(detail.vatOnFees) }]
              : detail.vatOnFeesUnreadable
                ? [{ label: 'VAT on fees', amount: 'Not shown: the stored invoice could not be read again.' }]
                : []),
            { label: 'Discount given by the store (information only)', amount: peso(detail.charges.vendorDiscount) },
            { label: 'Order value before discounts (information only)', amount: peso(detail.charges.grossInfo) },
          ]}
        />
        {detail.feeMonthNote ? <p className="text-sm">{detail.feeMonthNote}</p> : null}
      </div>

      {grab && detail.loan.check ? (
        <div className="space-y-2">
          <h3 className="font-medium">Grab loan check</h3>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={loanWord(detail.loan.check.status).tone} label={loanWord(detail.loan.check.status).label} />
            <span>{detail.loan.check.sentence}</span>
          </p>
          {detail.loan.lines.length > 0 ? (
            <LineItems
              items={detail.loan.lines.map((l) => ({
                title: l.kind === 'deduction' ? 'Loan payment taken from the payout' : 'Loan paid out to the store',
                amount: peso(l.amount),
                details: loanLineDetails(l),
              }))}
            />
          ) : (
            <p className="text-sm">This day has no loan lines.</p>
          )}
          {access.canOverrideLoans && detail.reviewState === 'pending' && deductions.length > 0 ? (
            <FormModal trigger={<span>Change</span>} triggerLabel="Change the loan allocation" triggerVariant="secondary" title="Change the loan allocation"
              description={`Choose which loan each part of the loan payment belongs to. The amounts must add up to ${peso(deductionTotal)}. Leave a pair empty to skip it.`}
            >
              <form action={overrideLoanAllocationAction} className="space-y-3">
                <input type="hidden" name="lineId" value={detail.lineId} />
                <FilterFields filters={filters} />
                {[...deductions.map(() => ''), ''].map((_, i) => (
                  <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label="Loan">
                      <Select name="loanId" defaultValue="" className="w-full">
                        <option value="">Choose a loan</option>
                        {loans.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount">
                      <Input name="amount" className="w-full" />
                    </Field>
                  </div>
                ))}
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </form>
            </FormModal>
          ) : null}
        </div>
      ) : null}

      {detail.otherLines.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-medium">Other lines in the file</h3>
          <LineItems
            items={detail.otherLines.map((o) => ({
              title: otherKindWord(o.kind),
              amount: peso(o.amount),
              details: [`Booked as: ${bookedAsWord(o.bookedAs)}`, o.lineDate ? `Date: ${shortDate(o.lineDate)}` : 'No date', ...(noteText(o.description) ? [`Note: ${noteText(o.description)}`] : [])],
            }))}
          />
        </div>
      ) : null}

      {access.canReject && detail.reviewState === 'pending' ? (
        <CheckedForm rules={SETTLEMENT_DAY_REJECT_RULES} action={rejectDayAction} className="space-y-2 [&>p[role=status]]:hidden">
          <h3 className="font-medium">Reject this day</h3>
          <input type="hidden" name="lineId" value={detail.lineId} />
          <FilterFields filters={filters} />
          <Field label="Why is it being rejected?" rule={SETTLEMENT_DAY_REJECT_RULES.reason}>
            <Textarea {...nativeAttrs(SETTLEMENT_DAY_REJECT_RULES.reason)} className="w-full" />
          </Field>
          <SubmitButton variant="secondary" pendingLabel="Rejecting…">
            Reject
          </SubmitButton>
          <RejectReasonHint />
          <p className="text-sm">Rejecting books nothing. An administrator can reopen the day.</p>
        </CheckedForm>
      ) : null}

      {access.canReopen && detail.reviewState === 'rejected' ? (
        <form action={reopenDayAction} className="space-y-1">
          <input type="hidden" name="lineId" value={detail.lineId} />
          <FilterFields filters={filters} />
          <SubmitButton variant="secondary" pendingLabel="Reopening…">
            Reopen day
          </SubmitButton>
          <p className="text-sm">The day goes back to waiting for a decision.</p>
        </form>
      ) : null}

      <p className="text-sm">Booking a day, and what it does to the books, comes in a later step. Nothing on this screen books money.</p>
    </section>
  );
}

'use client';

/**
 * "Record a settlement" — DEF-137, spec `docs/tasks/150-channel-settlement.md`.
 *
 * ## ⭐ Why this is a client component at all
 *
 * Because **the variance has to be on screen before the Post button is usable**, not after. A
 * settlement's tolerance refusal is the control this whole document exists for — *"that is a
 * disagreement, not rounding, reconcile it"* — and a control that fires only once the entry is
 * posted has arrived too late to be one.
 *
 * ⚠️ **It computes nothing itself.** "Check the numbers" calls `previewChannelSettlement` on the
 * server, which is the same `computeSettlement` the posting runs. Recomputing the arithmetic here
 * would be a second source of truth for the one figure this feature polices, and the two would
 * drift the first time a deduction kind is added. So the only thing this file knows about the
 * arithmetic is *whether the figures have changed since the last check* — which is what disables
 * the Post button again the moment somebody edits one.
 *
 * ⛔ **A deduction may be NEGATIVE and no input here has a `min`.** A promo-heavy day genuinely
 * returns money; v1 filtered to `amount > 0` and silently overstated fees by exactly the credit.
 */
import { accountLabel } from '@/lib/account-label';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Banner, Button, Field, FormGrid, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { CHANNEL_SETTLEMENT_RECORD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { recordSettlementAction, type PreviewRequest, type PreviewResponse } from './actions';

export interface ChannelChoice {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  outstanding: string;
  destinationAccountName: string | null;
  destinationMoneyAccountId: string | null;
}
export interface DayChoice {
  salesDayId: string;
  channelId: string;
  businessDate: string;
  reportedAmount: string;
  ageDays: number;
}
export interface LoanChoice {
  id: string;
  label: string;
  storeId: string;
  outstanding: string;
}
export interface PreviewShape {
  channelName: string;
  outstanding: string;
  outstandingCleared: string;
  feesTotal: string;
  loanDeduction: string;
  netDeposited: string;
  variance: string;
  settlementGain: string;
  tolerance: string;
  destinationAccountName: string | null;
  blockers: string[];
  needsGainAcknowledgement: boolean;
  /** T-351 / DEF-482 — false means every figure above is a placeholder zero, not a real answer. */
  figuresComputed: boolean;
}

const DEDUCTIONS = [
  { name: 'commission', label: 'Commission', account: '6400', hint: 'The core transaction fee' },
  { name: 'platformFee', label: 'Platform fee', account: '6400', hint: 'The residual. Negative on a promo day' },
  { name: 'vatOnFees', label: 'VAT on fees', account: '6400', hint: 'Booked with the fee, gross' },
  { name: 'marketing', label: 'Channel marketing', account: '6650', hint: 'Ad spend, not a transaction fee' },
  { name: 'withholdingTax', label: 'Withholding tax', account: '6800', hint: 'An expense here, never an asset' },
  { name: 'penalty', label: 'Penalty', account: '6410', hint: 'Kept apart so a trend is visible' },
] as const;

type DeductionName = (typeof DEDUCTIONS)[number]['name'];

const INPUT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';
const LABEL = 'flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400';

function money(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
  }).format(n === 0 ? 0 : n);
}

export function SettlementForm({
  previewAction,
  channels,
  days,
  loans,
  today,
  preselectChannelId,
  preselectSalesDayId,
}: {
  previewAction: (req: PreviewRequest) => Promise<PreviewResponse>;
  channels: readonly ChannelChoice[];
  days: readonly DayChoice[];
  loans: readonly LoanChoice[];
  today: string;
  preselectChannelId?: string;
  preselectSalesDayId?: string;
}) {
  const firstChannel = preselectChannelId ?? channels[0]?.id ?? '';
  const firstDay =
    days.find((d) => d.salesDayId === preselectSalesDayId) ??
    days.find((d) => d.channelId === firstChannel);
  const [channelId, setChannelId] = useState(firstChannel);
  const [salesDayId, setSalesDayId] = useState(firstDay?.salesDayId ?? '');
  // ⚠️ Seeded from the day the picker already has selected. Leaving it blank while a day is
  // preselected is the shape where somebody types the deductions, checks, and finds the gross is
  // zero — the one field the whole arithmetic hangs off, silently empty.
  const [gross, setGross] = useState(firstDay?.reportedAmount ?? '');
  const [net, setNet] = useState('');
  const [deductions, setDeductions] = useState<Record<DeductionName, string>>({
    commission: '',
    platformFee: '',
    vatOnFees: '',
    marketing: '',
    withholdingTax: '',
    penalty: '',
  });
  const [loanId, setLoanId] = useState('');
  const [loanAmount, setLoanAmount] = useState('');
  const [reference, setReference] = useState('');
  const [settledOn, setSettledOn] = useState(today);
  const [recognizeGain, setRecognizeGain] = useState(false);
  // T-440: picking a channel or day sets the gross from React state, which fires no input event; tell the checked form.
  const grossRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    grossRef.current?.dispatchEvent(new Event('input', { bubbles: true }));
  }, [gross]);

  const [preview, setPreview] = useState<PreviewShape | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const channel = channels.find((c) => c.id === channelId);
  const channelDays = days.filter((d) => d.channelId === channelId);
  const day = days.find((d) => d.salesDayId === salesDayId);
  const loan = loans.find((l) => l.id === loanId);
  /** ⭐ The cross-store case (T-150 §6): the loan belongs to a store other than the one being paid. */
  const crossStoreLoan = Boolean(loan && channel && loan.storeId !== channel.storeId);

  /** Everything the arithmetic depends on. When this moves, the last check is stale. */
  const figuresKey = useMemo(
    () =>
      JSON.stringify([
        channelId,
        day?.businessDate ?? '',
        gross,
        net,
        deductions,
        loanId,
        loanAmount,
        recognizeGain,
      ]),
    [channelId, day?.businessDate, gross, net, deductions, loanId, loanAmount, recognizeGain],
  );
  const stale = checkedKey !== null && checkedKey !== figuresKey;
  const checked = checkedKey === figuresKey && preview !== null;
  const canPost = checked && preview!.blockers.length === 0 && salesDayId !== '';

  function pickChannel(id: string) {
    setChannelId(id);
    // The day list is per channel, so a day from the previous channel would be a mismatch the
    // domain then refuses. Reset to that channel's oldest waiting day, which is the one to settle.
    const next = days.find((d) => d.channelId === id);
    setSalesDayId(next?.salesDayId ?? '');
    setGross(next?.reportedAmount ?? '');
  }

  function pickDay(id: string) {
    setSalesDayId(id);
    const d = days.find((x) => x.salesDayId === id);
    // ⚠️ Prefilled, never locked. What the day REPORTED and what the platform says it SETTLED are
    // two different claims, and the gap between them is exactly the variance being measured — so
    // the gross stays editable and the platform statement wins.
    if (d) setGross(d.reportedAmount);
  }

  function check() {
    setPreviewError(null);
    const key = figuresKey;
    startTransition(async () => {
      const res = await previewAction({
        storeId: channel?.storeId ?? '',
        channelId,
        businessDate: day?.businessDate ?? '',
        grossAmount: gross,
        netDeposited: net,
        commission: deductions.commission || '0',
        marketing: deductions.marketing || '0',
        platformFee: deductions.platformFee || '0',
        vatOnFees: deductions.vatOnFees || '0',
        withholdingTax: deductions.withholdingTax || '0',
        penalty: deductions.penalty || '0',
        loanId,
        loanAmount: loanAmount || '0',
        loanOwnerStoreId: crossStoreLoan ? (loan?.storeId ?? '') : '',
        recognizeGain,
      });
      if (res.ok) {
        setPreview(res.preview);
        setCheckedKey(key);
      } else {
        setPreview(null);
        setCheckedKey(null);
        setPreviewError(res.error);
      }
    });
  }

  if (channels.length === 0) {
    return (
      <Banner tone="warning">
        No channel raises a receivable yet. A platform that settles days later is a sales channel
        with <span className="font-mono">is_remitted_daily = false</span> and a receivable account —
        cash and walk-in channels reach the till on the day and have nothing to settle.
      </Banner>
    );
  }

  return (
    <CheckedForm rules={CHANNEL_SETTLEMENT_RECORD_RULES} action={recordSettlementAction} className="space-y-5">
      <input type="hidden" name="storeId" value={channel?.storeId ?? ''} />
      <input type="hidden" name="salesDayId" value={salesDayId} />
      <input type="hidden" name="businessDate" value={day?.businessDate ?? ''} />
      <input type="hidden" name="loanOwnerStoreId" value={crossStoreLoan ? (loan?.storeId ?? '') : ''} />
      {/*
        ⚠️ The acknowledgement travels as a HIDDEN field, not as the checkbox's own name.
        The checkbox is only rendered while a gain past tolerance is on screen — and ticking it
        makes the figures stale, so the next check clears the blocker and unmounts the checkbox.
        A named checkbox would then be gone from the form at submit time and the acknowledgement
        would silently not be sent: the posting would refuse the very thing the person just
        agreed to, with a message saying they had not agreed to it.
      */}
      <input type="hidden" name="recognizeGain" value={recognizeGain ? 'on' : ''} />

      {/* ── Which payout ─────────────────────────────────────────────────────────────── */}
      <FormGrid>
        <label className={LABEL}>
          Channel
          <Select
            name="channelId"
            value={channelId}
            onChange={(e) => pickChannel(e.target.value)}
            className="w-full"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.storeName} — {c.name} ({money(c.outstanding)} owed)
              </option>
            ))}
          </Select>
          {channel && !channel.destinationMoneyAccountId && (
            <span className="text-warning-ink">
              No payout account set — set it above before recording.
            </span>
          )}
          {channel?.destinationAccountName && (
            <span className="text-neutral-400 dark:text-neutral-600">
              Banks into {channel.destinationAccountName}
            </span>
          )}
        </label>

        <label className={LABEL}>
          Day being settled
          <Select
            name="salesDayPicker"
            value={salesDayId}
            onChange={(e) => pickDay(e.target.value)}
            className="w-full"
          >
            <option value="">Choose a verified day…</option>
            {channelDays.map((d) => (
              <option key={d.salesDayId} value={d.salesDayId}>
                {d.businessDate} — reported {money(d.reportedAmount)}
                {d.ageDays > 0 ? ` · ${d.ageDays}d old` : ''}
              </option>
            ))}
          </Select>
          {channelDays.length === 0 && (
            <span className="text-warning-ink">
              Nothing waiting on this channel. Only a <strong>verified</strong> day raises a
              receivable — an unverified one has posted nothing to clear.
            </span>
          )}
        </label>
      </FormGrid>

      {/* ── The two observable figures ───────────────────────────────────────────────── */}
      <FormGrid>
        <Field label="Gross the platform settled" hint="Prefilled from the day, editable — the statement wins" rule={CHANNEL_SETTLEMENT_RECORD_RULES.grossAmount}>
          <input
            {...nativeAttrs(CHANNEL_SETTLEMENT_RECORD_RULES.grossAmount)}
            ref={grossRef}
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            placeholder="0.00"
            className={INPUT}
          />
        </Field>
        <Field label="Net actually deposited" hint="What landed in the account. Both figures are on the payout statement" rule={CHANNEL_SETTLEMENT_RECORD_RULES.netDeposited}>
          <input
            {...nativeAttrs(CHANNEL_SETTLEMENT_RECORD_RULES.netDeposited)}
            value={net}
            onChange={(e) => setNet(e.target.value)}
            placeholder="0.00"
            className={INPUT}
          />
        </Field>
      </FormGrid>

      {/* ── The deductions, each its own signed line ─────────────────────────────────── */}
      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          What the platform deducted — each line to its own account
        </legend>
        <FormGrid>
          {DEDUCTIONS.map((d) => (
            <label key={d.name} className={LABEL}>
              <span>
                {d.label} <span className="font-mono text-neutral-400">{accountLabel(d.account)}</span>
              </span>
              <Input
                name={d.name}
                value={deductions[d.name]}
                onChange={(e) => setDeductions((prev) => ({ ...prev, [d.name]: e.target.value }))}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full"
              />
              <span className="text-neutral-400 dark:text-neutral-600">{d.hint}</span>
            </label>
          ))}
        </FormGrid>
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⛔ <strong>A deduction may be negative.</strong> A promo-heavy day genuinely hands money
          back, and that credit must survive — the legacy system filtered it out and overstated fees
          by exactly the amount it dropped.
        </p>
      </fieldset>

      {/* ── The loan the platform docked ─────────────────────────────────────────────── */}
      <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Loan repayment docked out of the payout — optional
        </legend>
        <FormGrid>
          <label className={LABEL}>
            Loan
            <Select
              name="loanId"
              value={loanId}
              onChange={(e) => setLoanId(e.target.value)}
              className="w-full"
            >
              <option value="">Nothing docked</option>
              {loans.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label} — {money(l.outstanding)} outstanding
                </option>
              ))}
            </Select>
          </label>
          <Field label="Amount docked" rule={CHANNEL_SETTLEMENT_RECORD_RULES.loanAmount}>
            <Input
              {...nativeAttrs(CHANNEL_SETTLEMENT_RECORD_RULES.loanAmount)}
              value={loanAmount}
              onChange={(e) => setLoanAmount(e.target.value)}
              placeholder="0.00"
              disabled={loanId === ''}
              className="w-full"
            />
          </Field>
        </FormGrid>
        {crossStoreLoan && (
          <Banner tone="warning">
            <strong>This loan belongs to another store.</strong> The paying store books{' '}
            <span>Due from related store</span> and the owning store{' '}
            <span>Due to related store</span>, so the pair nets to zero
            across the group and neither store&apos;s books absorb the other&apos;s debt.
          </Banner>
        )}
      </fieldset>

      {/* ── Provenance ───────────────────────────────────────────────────────────────── */}
      <FormGrid>
        <Field label="Payout reference" rule={CHANNEL_SETTLEMENT_RECORD_RULES.reference}>
          <Input
            {...nativeAttrs(CHANNEL_SETTLEMENT_RECORD_RULES.reference)}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="The platform's payout reference"
            className="w-full"
          />
        </Field>
        <Field label="Settled on" hint="The entry dates on this, not on the sales day" rule={CHANNEL_SETTLEMENT_RECORD_RULES.settledOn}>
          <Input
            {...nativeAttrs(CHANNEL_SETTLEMENT_RECORD_RULES.settledOn)}
            value={settledOn}
            onChange={(e) => setSettledOn(e.target.value)}
            type="date"
            className="w-full"
          />
        </Field>
      </FormGrid>

      {/* ── ⭐ The preview. The reason this component exists ─────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={check} disabled={pending || salesDayId === ''} variant="secondary">
            {pending ? 'Checking…' : 'Check the numbers'}
          </Button>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            Nothing is written. This is the same arithmetic the posting runs.
          </span>
        </div>

        {previewError && (
          <Banner tone="error">{previewError}</Banner>
        )}

        {preview && (
          <div className={stale ? 'opacity-40' : ''}>
            <SettlementPreviewFigures preview={preview} />

            {preview.blockers.length > 0 && (
              <div className="mt-3">
                <Banner tone="error">
                  <ul className="space-y-1">
                    {preview.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </Banner>
              </div>
            )}

            {/* ⭐ The gain acknowledgement is offered ONLY once a gain past tolerance is on
                screen. A permanently visible tick is one people learn to tick. */}
            {preview.needsGainAcknowledgement && (
              <label className="mt-3 flex items-start gap-2 rounded border border-warning bg-warning-soft p-3 text-sm text-warning-ink">
                <input
                  type="checkbox"
                  checked={recognizeGain}
                  onChange={(e) => setRecognizeGain(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>Recognise {money(preview.settlementGain)} as income.</strong> The platform
                  paid more than the day reported, past the tolerance. Tick this only if the payout
                  is right and the day under-reported — a typo must not quietly become revenue.
                </span>
              </label>
            )}

            {stale && (
              <p className="mt-3 text-sm font-medium text-warning-ink">
                The figures changed since this check. Check again before posting.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton disabled={!canPost}>Post this settlement</SubmitButton>
        {!canPost && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {salesDayId === ''
              ? 'Choose the day this payout settles.'
              : checked
                ? 'Resolve what is listed above first.'
                : 'Check the numbers first — the variance is shown before it is posted, not after.'}
          </span>
        )}
      </div>

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        Every platform fee is booked here, once. ⛔ Do not also raise an expense document for the
        same fee — that double-count cost ₱198,148.29 across two stores in the legacy system, and
        this screen is the single place these legs are written.
      </p>
    </CheckedForm>
  );
}

/**
 * T-351 / DEF-482 — the preview's figure rows, extracted so a render test can pin them without
 * mounting the whole client form. `figuresComputed === false` means every field below is a
 * placeholder zero (`ZERO_COMPUTED_SETTLEMENT`), so NO figure row renders — a config blocker
 * sitting beside real arithmetic is worth seeing, but "Banked ₱0.00" under a typed `1,5` is not a
 * figure, it is a bug pretending to be one. When figures ARE computed, the "reconciles exactly"
 * row only reads as good when nothing else is blocking the post — a green line above a red blocker
 * list said "this is fine" about a settlement that could not post.
 */
export function SettlementPreviewFigures({ preview }: { preview: PreviewShape }) {
  if (!preview.figuresComputed) {
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        The arithmetic appears once every figure reads as an amount — fix the ones listed below,
        then check again.
      </p>
    );
  }
  const reconciles = Number(preview.variance) === 0 && Number(preview.settlementGain) === 0;
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <Row label={`${preview.channelName} is owed`} value={money(preview.outstanding)} />
      <Row label="This settlement clears" value={money(preview.outstandingCleared)} />
      <Row label="Deductions" value={money(preview.feesTotal)} />
      {Number(preview.loanDeduction) !== 0 && <Row label="Loan docked" value={money(preview.loanDeduction)} />}
      <Row label="Banked" value={money(preview.netDeposited)} />
      {Number(preview.variance) !== 0 && (
        <Row label="Shortfall → Channel settlement variance" value={money(preview.variance)} tone="warn" />
      )}
      {Number(preview.settlementGain) !== 0 && (
        <Row label="Excess → Platform settlement gain" value={money(preview.settlementGain)} tone="warn" />
      )}
      {reconciles && (
        <Row
          label="Difference"
          value="none — it reconciles exactly"
          tone={preview.blockers.length === 0 ? 'good' : undefined}
        />
      )}
      <Row label="Tolerance for this day" value={money(preview.tolerance)} />
    </dl>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'good';
}) {
  const colour =
    tone === 'warn'
      ? 'text-warning-ink'
      : tone === 'good'
        ? 'text-emerald-700 dark:text-emerald-400'
        : '';
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-200 py-1 last:border-0 dark:border-neutral-800">
      <dt className={`text-neutral-600 dark:text-neutral-400 ${colour}`}>{label}</dt>
      <dd className={`font-mono tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}

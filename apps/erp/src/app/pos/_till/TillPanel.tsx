'use client';

/**
 * T-531 R6 - the Till tab: the reading so far (X), Close day (Z) with a manager's approval, the recent Zs with their v1 status, and a link to the ERP till
 * counts (row 319: the drawer count stays in the ERP, this tab adds no till UI of its own).
 *
 * Pure presentation over what the server sent: it computes no money (figures print as given) and decides nothing. The manager's PIN is checked on the server
 * by the close itself; it lives in this component's state only while the sheet is open and is cleared after every attempt, so it is never left on screen.
 * Closing the day needs the internet (an API call, not an outbox event): offline the button is off and says so.
 */
import { useRef, useState } from 'react';
import { money } from '@shareat/core/money';
import { Banner, Dialog } from '@/components/ui';
import { formatXSlip, printAmount, type PrintLayout } from '@/lib/pos-print';
import type { PrintResult } from '@/lib/pos-print/adapter';
import { Keypad } from '../_shell/Keypad';
import { readingSlipView, type ReadingJson } from './slips';

export const CLOSE_NEEDS_INTERNET = 'Closing the day needs the internet.';
export const MORE_THAN_TWO_DAYS = 'This close would cover more than 2 days. Call a manager.';
const NOT_SENT = 'Not yet sent to v1. Tap Resend.';
const EMPLOYEE_ID_MAX = 20;
const PIN_MAX = 12;

export interface TillHistoryRow {
  id: string;
  zNo: number;
  businessDate: string;
  grossTotal: string;
  tenders: { name: string; amount: string }[];
  v1Status: 'sent' | 'failed' | 'pending' | 'not_applicable';
  /** The Z-slip lines for Reprint; absent: no Reprint button. */
  slip?: string[];
}
export interface CloseAnswer {
  ok: boolean;
  error?: string;
  dayCloseId?: string;
  zNo?: number;
  slip?: string[];
}
export interface TillDeps {
  postClose: (body: { closeId: string; approval: { employeeId: string; pin: string } }) => Promise<CloseAnswer>;
  postBacklog: (body: { closeRunId: string; approval: { employeeId: string; pin: string } }) => Promise<CloseAnswer>;
  postResend: (businessDate: string) => Promise<{ ok: boolean; error?: string }>;
  print: (lines: string[], opts: { copies: number }) => Promise<PrintResult>;
  newId: () => string;
}
export interface TillPanelProps {
  reading: ReadingJson;
  history: TillHistoryRow[];
  online: boolean;
  /** A store manager or above who may approve corrections: only they can use Close day by day and Resend. */
  isManager: boolean;
  layout: PrintLayout;
  store: { name: string; vatRegistered?: boolean };
  cashierName: string;
  tillCountsHref: string;
  deps: TillDeps;
}

// Plain literals: the touch-target census reads them.
const PRIMARY = 'min-h-16 inline-flex w-full items-center justify-center rounded-full border border-transparent bg-brand px-6 text-base font-semibold text-white hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const SECONDARY = 'min-h-12 min-w-12 inline-flex items-center justify-center gap-2 rounded-full border border-surface-border bg-surface px-4 text-base font-semibold text-ink hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-50';
const FIELD = 'min-h-12 flex w-full items-center justify-center rounded-2xl border bg-field px-4 text-2xl font-semibold tabular-nums tracking-widest placeholder:text-base placeholder:font-medium placeholder:tracking-normal placeholder:text-muted';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className={strong ? 'text-base font-semibold text-ink' : 'text-base text-muted'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold text-ink' : 'text-base text-ink'}`}>{value}</dd>
    </div>
  );
}
const amount = (m: string): string => printAmount(money(m));

export function TillPanel({ reading, history, online, isManager, layout, store, cashierName, tillCountsHref, deps }: TillPanelProps) {
  const [sheet, setSheet] = useState<null | 'z' | 'backlog'>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [pin, setPin] = useState('');
  const [field, setField] = useState<'id' | 'pin'>('id');
  const [problem, setProblem] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<{ zNo: number; slip: string[]; notice: string | null } | null>(null);
  const [sent, setSent] = useState<Record<string, true>>({});
  // One id per opened sheet, so a retry after a lost answer is the same close (idempotent), never a second one.
  const attempt = useRef<{ closeId: string; runId: string } | null>(null);

  const closeSheet = () => {
    setSheet(null);
    setPin('');
    setEmployeeId('');
    setField('id');
    setProblem(null);
    setTooMany(false);
    attempt.current = null;
  };
  const openSheet = (mode: 'z' | 'backlog') => {
    if (!attempt.current) attempt.current = { closeId: deps.newId(), runId: deps.newId() };
    setProblem(null);
    setPin('');
    setField(employeeId ? 'pin' : 'id');
    setSheet(mode);
  };
  const onDigit = (d: string) => {
    setProblem(null);
    if (field === 'id') setEmployeeId((v) => (v + d).slice(0, EMPLOYEE_ID_MAX));
    else setPin((v) => (v + d).slice(0, PIN_MAX));
  };
  const onBack = () => (field === 'id' ? setEmployeeId((v) => v.slice(0, -1)) : pin ? setPin((v) => v.slice(0, -1)) : setField('id'));
  const onClear = () => (field === 'id' ? setEmployeeId('') : setPin(''));

  const printX = async () => {
    const lines = formatXSlip(readingSlipView(reading, { storeName: store.name, vatRegistered: store.vatRegistered ?? true, printedBy: cashierName }), layout);
    const result = await deps.print(lines, { copies: 1 });
    setNotice(result === 'failed' ? 'The slip did not print. Try again.' : null);
  };

  const submit = async () => {
    if (!attempt.current || busy) return;
    setBusy(true);
    const approval = { employeeId: employeeId.trim(), pin };
    try {
      const answer = sheet === 'backlog' ? await deps.postBacklog({ closeRunId: attempt.current.runId, approval }) : await deps.postClose({ closeId: attempt.current.closeId, approval });
      if (answer.ok) {
        const slip = answer.slip ?? [];
        const result = slip.length > 0 ? await deps.print(slip, { copies: 1 }) : 'printed';
        setDone({ zNo: answer.zNo ?? 0, slip, notice: result === 'failed' ? 'The slip did not print. Tap Reprint.' : null });
        closeSheet();
      } else {
        setProblem(answer.error ?? 'The day could not be closed.');
        setTooMany(answer.error === MORE_THAN_TWO_DAYS);
        setPin('');
        setField('pin');
      }
    } catch {
      setProblem('The day could not be closed. Check the internet and try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const reprintDone = async () => {
    if (!done) return;
    const result = await deps.print(done.slip, { copies: 1 });
    setDone({ ...done, notice: result === 'failed' ? 'The slip did not print. Tap Reprint.' : null });
  };
  const reprintRow = async (row: TillHistoryRow) => {
    if (!row.slip) return;
    const result = await deps.print(row.slip, { copies: 1 });
    setNotice(result === 'failed' ? 'The slip did not print. Try again.' : null);
  };
  const resend = async (row: TillHistoryRow) => {
    setBusy(true);
    try {
      const answer = await deps.postResend(row.businessDate);
      if (answer.ok) {
        setSent((s) => ({ ...s, [row.id]: true }));
        setNotice(null);
      } else setNotice(answer.error ?? 'v1 could not be reached. Try again.');
    } catch {
      setNotice('v1 could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const ready = employeeId.trim() !== '' && pin !== '';
  const hasSales = reading.receiptCount > 0;
  return (
    <div className="space-y-8 pb-8">
      <section aria-labelledby="till-reading" className="max-w-md space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="till-reading" className="text-xl font-semibold text-ink">
            Reading so far
          </h2>
          <button type="button" data-erp-size="free" className={SECONDARY} onClick={() => void printX()}>
            Print X
          </button>
        </div>
        {reading.spansTwoDates ? <Banner tone="warning">Spans two dates</Banner> : null}
        <dl className="divide-y divide-surface-border">
          <Row label="Receipts" value={String(reading.receiptCount)} />
          <Row label="Gross total" value={amount(reading.grossTotal)} strong />
          <Row label="Senior discount" value={amount(reading.discounts.senior)} />
          <Row label="PWD discount" value={amount(reading.discounts.pwd)} />
          <Row label="Other discount" value={amount(reading.discounts.other)} />
          {reading.byTender.map((t) => (
            <Row key={t.name} label={t.name} value={amount(t.amount)} />
          ))}
          {reading.toCheckCount > 0 ? <Row label="Wallet payments to check" value={String(reading.toCheckCount)} /> : null}
          {reading.lateCount > 0 ? <Row label="Late receipts" value={String(reading.lateCount)} /> : null}
        </dl>
        {notice ? (
          <p role="alert" className="text-base font-semibold text-danger">
            {notice}
          </p>
        ) : null}
      </section>

      <section aria-label="Close the day" className="max-w-md space-y-2">
        <button type="button" data-erp-size="free" className={PRIMARY} disabled={!online || busy} aria-disabled={!online || busy} onClick={() => openSheet('z')}>
          Close day (Z)
        </button>
        {online ? null : <p className="text-base text-muted">{CLOSE_NEEDS_INTERNET}</p>}
        {online && !hasSales ? <p className="text-base text-muted">There are no sales to close since the last Z.</p> : null}
        <a href={tillCountsHref} className="inline-flex min-h-12 items-center text-base font-semibold text-brand underline underline-offset-4 hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">
          Till counts and handover
        </a>
      </section>

      <section aria-labelledby="till-history" className="max-w-md space-y-3">
        <h2 id="till-history" className="text-xl font-semibold text-ink">
          Recent closes
        </h2>
        {history.length === 0 ? <p className="text-base text-muted">No day has been closed yet.</p> : null}
        <ul className="divide-y divide-surface-border">
          {history.map((row) => {
            const status = sent[row.id] ? 'sent' : row.v1Status;
            return (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-base font-semibold tabular-nums text-ink">
                    Z-{String(row.zNo).padStart(4, '0')} <span className="font-normal text-muted">{row.businessDate}</span>
                  </p>
                  <p className="text-base tabular-nums text-ink">{amount(row.grossTotal)}</p>
                  <p className="text-sm text-muted">{row.tenders.map((t) => `${t.name} ${amount(t.amount)}`).join(' · ')}</p>
                  {status === 'failed' ? <p className="text-base font-semibold text-danger">{NOT_SENT}</p> : null}
                </div>
                <div className="flex gap-2">
                  {status === 'failed' && isManager ? (
                    <button type="button" data-erp-size="free" className={SECONDARY} disabled={busy} onClick={() => void resend(row)}>
                      Resend
                    </button>
                  ) : null}
                  {status === 'failed' && !isManager ? (
                    <button type="button" data-erp-size="free" className={SECONDARY} disabled aria-disabled>
                      Resend
                    </button>
                  ) : null}
                  {row.slip ? (
                    <button type="button" data-erp-size="free" className={SECONDARY} onClick={() => void reprintRow(row)}>
                      Reprint
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <Dialog
        open={sheet !== null}
        onClose={closeSheet}
        title={sheet === 'backlog' ? 'Close day by day' : 'Close day (Z)'}
        description={sheet === 'backlog' ? 'A manager closes each earlier day on its own. Today stays open.' : 'A manager approves with their Employee ID and PIN.'}
        size="md"
      >
        <div className="space-y-4 p-5">
          <dl className="divide-y divide-surface-border">
            <Row label="Receipts" value={String(reading.receiptCount)} />
            <Row label="Gross total" value={amount(reading.grossTotal)} strong />
            {reading.byTender.map((t) => (
              <Row key={t.name} label={t.name} value={amount(t.amount)} />
            ))}
          </dl>
          <div className="grid grid-cols-2 gap-3">
            <input
              readOnly
              inputMode="none"
              aria-label="Employee ID"
              placeholder="Employee ID"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value.slice(0, EMPLOYEE_ID_MAX))}
              onFocus={() => setField('id')}
              className={`${FIELD} ${field === 'id' ? 'border-ink' : 'border-field-border'}`}
            />
            <input
              readOnly
              inputMode="none"
              type="password"
              autoComplete="off"
              aria-label="PIN"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.slice(0, PIN_MAX))}
              onFocus={() => setField('pin')}
              className={`${FIELD} ${field === 'pin' ? 'border-ink' : 'border-field-border'}`}
            />
          </div>
          {problem ? <Banner tone="error">{problem}</Banner> : null}
          {tooMany ? (
            <button type="button" data-erp-size="free" className={SECONDARY} disabled={!isManager || busy} aria-disabled={!isManager || busy} onClick={() => openSheet('backlog')}>
              Close day by day
            </button>
          ) : null}
          {tooMany && !isManager ? <p className="text-base text-muted">Only a store manager can close the days one by one.</p> : null}
          <Keypad onDigit={onDigit} onBack={onBack} onClear={onClear} disabled={busy} />
          <button type="button" data-erp-size="free" className={PRIMARY} disabled={!ready || busy} aria-disabled={!ready || busy} onClick={() => void submit()}>
            Close day
          </button>
        </div>
      </Dialog>

      <Dialog
        open={done !== null}
        onClose={() => setDone(null)}
        title={done ? `Closed · Z-${String(done.zNo).padStart(4, '0')}` : 'Closed'}
        description="Cash control, not a BIR document. This is the paper."
        size="md"
        footer={
          done ? (
            <div className="space-y-2">
              {done.notice ? (
                <p role="alert" className="text-base font-semibold text-danger">
                  {done.notice}
                </p>
              ) : null}
              <div className="flex gap-2">
                <button type="button" data-erp-size="free" className={`${SECONDARY} flex-1`} onClick={() => void reprintDone()}>
                  Reprint
                </button>
                <button type="button" data-erp-size="free" className={`${PRIMARY} flex-1`} onClick={() => setDone(null)}>
                  Done
                </button>
              </div>
            </div>
          ) : null
        }
      >
        {done && done.slip.length > 0 ? (
          <pre aria-label="Z-reading" className="overflow-x-auto whitespace-pre pb-6 pr-3 font-mono text-sm leading-snug text-ink">
            {done.slip.join('\n')}
          </pre>
        ) : null}
        {done && done.slip.length === 0 ? <p className="p-5 text-base text-ink">The days were closed. Print each one from Recent closes with Reprint.</p> : null}
      </Dialog>
    </div>
  );
}

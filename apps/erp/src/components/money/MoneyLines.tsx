'use client';

/**
 * `<MoneyLines>` — one control for every peso that moves. T-266,
 * `docs/tasks/266-money-lines.md`.
 *
 * ⛔ **This component decides nothing.** Which methods are offered, how sources are banded, what
 * each line requires and whether the document is coherent all come from
 * `@shareat/domain`'s `money-lines` module — the same functions `expenses/actions.ts` re-runs
 * server-side. v1's equivalent kept its own copy of those rules beside a validator that kept
 * another, and they drifted: `enabledPaymentMethods` is computed in v1's expense editor and never
 * passed to the component, so a store that disabled Credit still offers it.
 *
 * ⚠️ **It also takes a PREPARED payload**, never a fetcher — balances are derived from the ledger
 * and need a transaction (`lib/money-lines/load.ts`). A plain function cannot cross the
 * server/client boundary as a prop.
 *
 * ⛔ **Imports the `@shareat/domain/money-lines` SUBPATH, never the package barrel.** The barrel
 * re-exports every domain module and several import `@shareat/db`, so `from '@shareat/domain'`
 * here pulls the Postgres driver into the browser bundle. `next build` refuses it — which is how
 * this was caught rather than shipped, and why `judgeDraw` now lives in its own DB-free file.
 *
 * ⭐ **T-353 / DEF-484 — issues are computed live, but SHOWN only once a field is touched or a
 * submit attempt fires.** `validateMoneyLines` still judges every line on every render, exactly as
 * before; the server re-runs the same function regardless. What changed is presentation timing
 * (`money-line-visibility.ts`'s `visibleIssues`), never the rule.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  METHOD_LABELS,
  availableOf,
  drawnPerSource,
  groupSourcesByCoverage,
  keyOfSource,
  labelOf,
  methodsForDirection,
  sourceKey,
  totalOfLines,
  tryMoney,
  validateMoneyLines,
  judgeDraw,
  type MoneyDirection,
  type MoneyLine,
  type MoneyLineMethod,
  type SourceOption,
} from '@shareat/domain/money-lines';
import { money } from '@shareat/core/money';
import { visibleIssues, type LineField } from './money-line-visibility';

const ALL_LINE_FIELDS: readonly LineField[] = ['method', 'amount', 'moneyAccountId', 'cashRequestId', 'staffId'];

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';

const peso = (v: string | number) =>
  `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface MoneyLinesProps {
  direction: MoneyDirection;
  sources: SourceOption[];
  staff: { id: string; displayName: string }[];
  /** Field-name prefix, so two instances can live on one form. */
  name?: string;
  supplierId?: string | null;
  supplierName?: string | null;
  /** ⭐ NULL = this supplier is cash-on-delivery, and Credit is offered-but-disabled with a reason. */
  supplierCreditTermsDays?: number | null;
  /** When the document has a fixed total, the lines must reach exactly it. */
  mustTotal?: string | null;
  initialLines?: MoneyLine[];
}

const blankLine = (): MoneyLine => ({ method: 'cash', amount: '', moneyAccountId: null });

export function MoneyLines({
  direction,
  sources,
  staff,
  name = 'line',
  supplierId = null,
  supplierName = null,
  supplierCreditTermsDays = null,
  mustTotal = null,
  initialLines,
}: MoneyLinesProps) {
  const [lines, setLines] = useState<MoneyLine[]>(
    initialLines?.length ? initialLines : [blankLine()],
  );
  // T-353 (R2.3) — server-supplied lines are judged at once, same as v1's edit-mode `trigger()`:
  // every field of an initial line starts touched. A fresh blank line starts untouched.
  const [touched, setTouched] = useState<ReadonlySet<LineField>[]>(
    initialLines?.length ? initialLines.map(() => new Set<LineField>(ALL_LINE_FIELDS)) : [new Set<LineField>()],
  );
  const [attempted, setAttempted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const patch = (i: number, change: Partial<MoneyLine>) =>
    setLines((prev) => prev.map((l, n) => (n === i ? { ...l, ...change } : l)));
  const markTouched = (i: number, fields: readonly LineField[]) =>
    setTouched((prev) => prev.map((set, n) => (n === i ? new Set([...set, ...fields]) : set)));

  // T-353 (R4) — the submit attempt is detected on the ENCLOSING form, never cancelled: `invalid`
  // fires (capture phase; it does not bubble) on each control the browser's own `required`/etc.
  // blocks, which is why `submit` alone is not enough — on a fresh `/expenses/new`, Category and
  // Particulars are native-required, so the browser blocks the submit and `submit` never fires.
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const onAttempt = () => setAttempted(true);
    form.addEventListener('submit', onAttempt);
    form.addEventListener('invalid', onAttempt, true);
    return () => {
      form.removeEventListener('submit', onAttempt);
      form.removeEventListener('invalid', onAttempt, true);
    };
  }, []);

  const methods = methodsForDirection(direction);
  const byKey = useMemo(() => new Map(sources.map((s) => [keyOfSource(s), s] as const)), [sources]);

  // ⭐ Summed per SOURCE across every line, never per line (§6.3) — `approveExpense` does exactly
  // this, and for the stated reason: two ₱600 lines against one ₱1,000 drawer are individually
  // affordable and together are not. A preview that checked each alone would show green and then
  // be refused at approve.
  const drawn = useMemo(() => drawnPerSource(lines), [lines]);

  const issues = useMemo(
    () =>
      validateMoneyLines({
        direction,
        lines,
        sources,
        supplierId,
        supplierCreditTermsDays,
        supplierName,
        mustTotal,
      }),
    [direction, lines, sources, supplierId, supplierCreditTermsDays, supplierName, mustTotal],
  );

  // T-353 / DEF-484 — the DOMAIN decides what is wrong (`issues`, above); this decides only WHEN
  // it is shown: a field that has been touched, or a submit attempt, or an initial (server-loaded)
  // line (already all-touched in `touched`'s initial state).
  const shown = useMemo(() => visibleIssues(issues, touched, attempted), [issues, touched, attempted]);
  const issueFor = (i: number, field: MoneyLine extends never ? never : string) =>
    shown.find((s) => s.line === i && s.field === field)?.message;
  const documentIssues = shown.filter((s) => s.line === null);

  /**
   * ⭐ The overdraft verdict is `judgeDraw()` ITSELF — the same pure function `approveExpense`
   * calls — rendered verbatim. The person recording the spend reads, at entry time, the exact
   * sentence approval will give them.
   *
   * ⚠️ A warning is NOT a block: `judgeDraw` returns `blocked: false` with a message for an
   * unverified till, because that drawer's balance is genuinely unknowable until the day is
   * verified. It renders amber and must never disable submit.
   *
   * ⛔ Money coming IN cannot overdraw anything, so there is no verdict on that direction.
   */
  const verdicts = useMemo(() => {
    if (direction === 'in') return [];
    const out: { key: string; label: string; blocked: boolean; message: string }[] = [];
    for (const [key, amount] of drawn) {
      const source = byKey.get(key);
      if (!source || source.kind === 'float') continue; // a float's ceiling is its own line issue
      const verdict = judgeDraw(
        {
          name: source.name,
          custodian: source.custodian,
          overdraftLimit: source.overdraftLimit,
          floatTarget: source.floatTarget,
        },
        Number(availableOf(source)),
        Number(amount),
      );
      if (verdict.message) {
        out.push({ key, label: source.name, blocked: verdict.blocked, message: verdict.message });
      }
    }
    return out;
  }, [direction, drawn, byKey]);

  const total = totalOfLines(lines);
  const needsSource = (m: MoneyLineMethod) => m === 'cash' || m === 'online';

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      <input type="hidden" name={`${name}Count`} value={lines.length} />

      {lines.map((line, i) => {
        const needed = tryMoney(line.amount) ?? money('0');
        const alreadyElsewhere = (key: string) => {
          const mine = tryMoney(line.amount);
          const all = drawn.get(key);
          if (!all) return money('0');
          return mine ? money((Number(all) - Number(mine)).toFixed(2)) : all;
        };

        return (
          <fieldset
            key={i}
            className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {direction === 'out' ? 'Paid' : 'Received'} {i + 1}
            </legend>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">Method</span>
                <select
                  id={`${name}-method-${i}`}
                  name={`${name}Method_${i}`}
                  value={line.method}
                  className={INPUT}
                  onChange={(e) => {
                    const method = e.target.value as MoneyLineMethod;
                    // Clearing the fields the old method owned — a stale staffId on a cash line
                    // would post a party nobody chose.
                    patch(i, {
                      method,
                      moneyAccountId: needsSource(method) ? line.moneyAccountId : null,
                      cashRequestId: needsSource(method) ? line.cashRequestId : null,
                      staffId: method === 'reimbursable' ? line.staffId : null,
                    });
                    // T-353 — a pick is a finished answer; a select marks touched on change too,
                    // not only on blur.
                    markTouched(i, ['method']);
                  }}
                  onBlur={() => markTouched(i, ['method'])}
                >
                  {methods.map((m) => {
                    // ⭐ Credit is OFFERED and disabled, never hidden — a person needs to see that
                    // it exists and learn why it is unavailable, which is the fix that makes
                    // `credit_terms_days` discoverable at all.
                    const creditBlocked =
                      m === 'credit' && (supplierCreditTermsDays === null || !supplierId);
                    return (
                      <option key={m} value={m} disabled={creditBlocked}>
                        {METHOD_LABELS[m]}
                        {creditBlocked ? ' — no terms set' : ''}
                      </option>
                    );
                  })}
                </select>
              </label>

              {needsSource(line.method) ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {direction === 'out' ? 'Paid from' : 'Received into'}
                  </span>
                  <select
                    id={`${name}-source-${i}`}
                    name={`${name}Source_${i}`}
                    value={sourceKey(line) ?? ''}
                    className={INPUT}
                    onChange={(e) => {
                      const source = byKey.get(e.target.value);
                      patch(i, {
                        moneyAccountId: !source ? null : source.kind === 'float' ? source.moneyAccountId : source.id,
                        // ⭐ Picking a float IS picking its request. The user never sees an id.
                        cashRequestId: source?.kind === 'float' ? source.cashRequestId : null,
                      });
                      markTouched(i, ['moneyAccountId', 'cashRequestId']);
                    }}
                    onBlur={() => markTouched(i, ['moneyAccountId', 'cashRequestId'])}
                  >
                    <option value="">— choose —</option>
                    {groupSourcesByCoverage(sources, needed, new Map(
                      [...drawn].map(([k, v]) => [k, alreadyElsewhere(k)]),
                    )).map((group) => (
                      <optgroup
                        key={group.band}
                        label={
                          group.band === 'covers' && Number(needed) > 0
                            ? `${group.label} ${peso(needed)}`
                            : group.label
                        }
                      >
                        {group.sources.map((s) => (
                          <option key={keyOfSource(s)} value={keyOfSource(s)}>
                            {labelOf(s)}
                            {s.kind === 'float' ? ' · float' : ` · ${s.custodian}`}
                            {'  '}
                            {peso(availableOf(s))}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              ) : line.method === 'reimbursable' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">Who paid</span>
                  <select
                    id={`${name}-staff-${i}`}
                    name={`${name}Staff_${i}`}
                    value={line.staffId ?? ''}
                    className={INPUT}
                    onChange={(e) => {
                      patch(i, { staffId: e.target.value || null });
                      markTouched(i, ['staffId']);
                    }}
                    onBlur={() => markTouched(i, ['staffId'])}
                  >
                    <option value="">— choose —</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>{s.displayName}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="self-end pb-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {line.method === 'credit' && supplierCreditTermsDays !== null
                    ? `On account — ${supplierCreditTermsDays} day terms`
                    : 'On account'}
                </p>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">Amount</span>
                <input
                  id={`${name}-amount-${i}`}
                  name={`${name}Amount_${i}`}
                  value={line.amount}
                  inputMode="decimal"
                  placeholder="0.00"
                  className={`${INPUT} text-right tabular-nums`}
                  onChange={(e) => patch(i, { amount: e.target.value })}
                  // T-353 — NOT on change: a half-typed "1." must show nothing until the box is
                  // left, or every keystroke of a valid amount would flash "not a valid amount".
                  onBlur={() => markTouched(i, ['amount'])}
                />
              </label>
            </div>

            {/* ⭐ Reference per LINE, not per document (DEF-067) — a three-way split has three. */}
            {line.method === 'online' && (
              <label className="mt-3 flex flex-col gap-1">
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Reference <span className="text-neutral-400 dark:text-neutral-600">— what reconciles this against the statement</span>
                </span>
                <input
                  id={`${name}-ref-${i}`}
                  name={`${name}Ref_${i}`}
                  value={line.referenceNo ?? ''}
                  className={INPUT}
                  onChange={(e) => patch(i, { referenceNo: e.target.value || null })}
                />
              </label>
            )}

            <input type="hidden" name={`${name}Account_${i}`} value={line.moneyAccountId ?? ''} />
            <input type="hidden" name={`${name}Request_${i}`} value={line.cashRequestId ?? ''} />

            {(['amount', 'moneyAccountId', 'cashRequestId', 'staffId', 'method'] as const).map((field) => {
              const message = issueFor(i, field);
              return message ? (
                <p key={field} className="mt-2 text-xs text-red-700 dark:text-red-400">{message}</p>
              ) : null;
            })}

            {/* ⚠️ `py-1.5` below is load-bearing, not spacing taste — WCAG 2.5.8 wants a 24px
                box and bare `text-xs` models to 16px. `action-link-sweep.test.ts` measures it
                (DEF-269) and caught this control at 16px on its first write. */}
            {lines.length > 1 && (
              <button
                type="button"
                className="mt-3 inline-flex items-center rounded px-2 py-1.5 text-xs text-neutral-500 underline hover:bg-neutral-100 hover:text-red-700 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-red-400"
                onClick={() => {
                  setLines((prev) => prev.filter((_, n) => n !== i));
                  setTouched((prev) => prev.filter((_, n) => n !== i));
                }}
              >
                Remove this line
              </button>
            )}
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          onClick={() => {
            setLines((prev) => [...prev, blankLine()]);
            setTouched((prev) => [...prev, new Set<LineField>()]);
          }}
        >
          Add another {direction === 'out' ? 'payment' : 'receipt'}
        </button>
        <p className="text-sm tabular-nums text-neutral-600 dark:text-neutral-400">
          Total <strong className="text-neutral-900 dark:text-neutral-100">{peso(total)}</strong>
          {mustTotal ? <> of {peso(mustTotal)}</> : null}
        </p>
      </div>

      {verdicts.map((v) => (
        <p
          key={v.key}
          className={
            v.blocked
              ? 'rounded border-l-4 border-red-600 bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300'
              : 'rounded border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          }
        >
          {v.message}
        </p>
      ))}

      {documentIssues.map((s, n) => (
        <p key={n} className="text-xs text-red-700 dark:text-red-400">{s.message}</p>
      ))}
    </div>
  );
}

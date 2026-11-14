'use client';

/**
 * InvoiceBatchRecord - T-502 section 12. "Record expenses" on /ap/invoices/[id]: one expense per ticked PART of the bill, saved together.
 *
 * A table of the bill's parts that still have something left (category groups, Uncategorised, Fees), each with an include tick; a part
 * that has no category of its own needs one picked. Payments use the same rows as a single expense and may come from several sources;
 * their total must EQUAL the ticked parts' total (Save stays off until it does). Under the form a live preview shows how the payments
 * will be split, in order, across the parts - computed by `allocateBatchPayments`, the SAME function the server uses to save.
 *
 * Posts `partCount`, `partKey_i`, `partOn_i`, `partPick_i` and the MoneyLines rows. The server re-judges everything.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { add, compare, money, ZERO, type Money } from '@shareat/core/money';
import { allocateBatchPayments } from '@shareat/domain/expenses/allocate';
import { METHOD_LABELS, tryMoney, type MoneyLineMethod, type SourceOption } from '@shareat/domain/money-lines';
import { Select } from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { MoneyLines, type MoneyLinesProps } from '@/components/money/MoneyLines';
import { hasLeft, type CategoryChoice, type InvoicePartsView } from './parts-types';

const peso = (v: string | number) => `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const GROUPS: Array<CategoryChoice['group']> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];

type PaymentProps = Omit<MoneyLinesProps, 'direction' | 'supplierId' | 'supplierName' | 'supplierCreditTermsDays' | 'initialLines' | 'mustTotal'>;

interface PaymentRow {
  method: string;
  moneyAccountId: string | null;
  amount: Money;
}

/** The payment rows as typed in the form (blank or unreadable rows dropped), read from MoneyLines' own posted controls. */
function readRows(form: HTMLFormElement): PaymentRow[] {
  const count = Number((form.elements.namedItem('lineCount') as HTMLInputElement | null)?.value ?? '0');
  const rows: PaymentRow[] = [];
  const limit = Number.isFinite(count) ? Math.min(count, 50) : 0;
  for (const i of Array.from({ length: limit }, (_, n) => n)) {
    const method = (form.elements.namedItem(`lineMethod_${i}`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
    const amount = tryMoney((form.elements.namedItem(`lineAmount_${i}`) as HTMLInputElement | null)?.value ?? '');
    if (!method || !amount || compare(amount, ZERO) <= 0) continue;
    rows.push({ method, moneyAccountId: (form.elements.namedItem(`lineAccount_${i}`) as HTMLInputElement | null)?.value || null, amount });
  }
  return rows;
}

export interface InvoiceBatchRecordProps {
  action: (formData: FormData) => void | Promise<void>;
  invoiceId: string;
  storeId: string;
  supplierId: string;
  supplierName: string | null;
  /** null = cash-on-delivery. */
  supplierCreditTermsDays: number | null;
  invoiceStatus: 'pending' | 'verified';
  view: InvoicePartsView;
  categories: CategoryChoice[];
  moneyLines: PaymentProps;
  returnTo: string;
  /** Slot for the closed-month override control when the bill's month is closed (verified bills only). */
  children?: ReactNode;
}

export function InvoiceBatchRecord({
  action,
  invoiceId,
  storeId,
  supplierId,
  supplierName,
  supplierCreditTermsDays,
  invoiceStatus,
  view,
  categories,
  moneyLines,
  returnTo,
  children,
}: InvoiceBatchRecordProps) {
  const rows = useMemo(() => view.parts.filter((p) => hasLeft(p.left)), [view]);
  const formRef = useRef<HTMLFormElement>(null);
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((p) => [p.key, true])));
  const [pick, setPick] = useState<Record<string, string>>({});
  const [paid, setPaid] = useState<PaymentRow[]>([]);

  const ticked = rows.filter((p) => on[p.key]);
  const total: Money = ticked.length > 0 ? add(...ticked.map((p) => money(p.left))) : ZERO;
  const paidTotal: Money = paid.length > 0 ? add(...paid.map((p) => p.amount)) : ZERO;
  const missingPick = ticked.some((p) => p.kind !== 'category' && !pick[p.key]);
  const matches = ticked.length > 0 && compare(paidTotal, total) === 0;
  const canSave = matches && !missingPick;

  // Follow the payment rows (typed amounts, added/removed rows, picked sources) without owning them.
  // ⛔ NEVER a native input listener on the form that calls setState: the browser runs a microtask checkpoint
  // between listeners, so React renders the parent (with the OLD payment rows) BEFORE its own root handler has seen the
  // keystroke - the controlled Amount box is rewritten with its old value and onChange never fires (typing "does nothing").
  // The form's React `onInput`/`onChange` below run inside React's own dispatch, after the row's onChange, in one batch.
  const lastSig = useRef('');
  const syncPaid = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    const next = readRows(form);
    const sig = JSON.stringify(next);
    if (sig === lastSig.current) return; // no change: never re-render (the observer below also watches what a render writes)
    lastSig.current = sig;
    setPaid(next);
  }, []);
  // Rows added/removed and values a render wrote (no input event): the observer fires AFTER React has committed, which is safe.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;
    syncPaid();
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(syncPaid);
    observer?.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
    return () => observer?.disconnect();
  }, [syncPaid]);

  const sourceName = (id: string | null): string | null => {
    if (!id) return null;
    const s = ([...moneyLines.sources, ...(moneyLines.otherStoreSources ?? [])] as SourceOption[]).find((x) =>
      x.kind === 'float' ? x.moneyAccountId === id : x.id === id,
    );
    return s ? (s.kind === 'float' ? s.holderName : s.name) : null;
  };
  const sourceLabel = (r: { method: string; moneyAccountId?: string | null }) => {
    const base = METHOD_LABELS[r.method as MoneyLineMethod] ?? r.method;
    const acct = sourceName(r.moneyAccountId ?? null);
    return acct ? `${base} · ${acct}` : base;
  };

  // The SAME allocator the server runs. Only when the payments equal the ticked total (it refuses otherwise).
  const preview = useMemo(() => {
    if (!matches) return null;
    try {
      return allocateBatchPayments(
        ticked.map((p) => ({ key: p.key, amount: money(p.left) })),
        paid,
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ticked` is derived from `on`/`rows`
  }, [matches, paid, on, rows]);

  const method = supplierCreditTermsDays != null ? 'credit' : 'cash';
  const offered = categories.filter((c) => c.isActive);

  return (
    <form ref={formRef} action={action} onInput={syncPaid} onChange={syncPaid} className="space-y-4 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800" data-batch-record>
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="supplierInvoiceId" value={invoiceId} />
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="partCount" value={rows.length} />
      <div>
        <h2 className="font-medium">Record expenses</h2>
        <p className="text-neutral-600 dark:text-neutral-400">
          One expense for each part of this bill you tick, saved together.{' '}
          {invoiceStatus === 'verified' ? 'This bill is verified, so they post straight away.' : 'This bill is still pending, so they are saved as drafts; verifying the bill posts them.'}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-xs text-neutral-500 dark:text-neutral-400">
              <th className="py-1 pr-3 font-medium">Include</th>
              <th className="py-1 pr-3 font-medium">Part of the bill</th>
              <th className="py-1 pr-3 font-medium">Items</th>
              <th className="py-1 pr-3 text-right font-medium">Left</th>
              <th className="py-1 font-medium">Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.key} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-3">
                  <input type="hidden" name={`partKey_${i}`} value={p.key} />
                  <input
                    type="checkbox"
                    name={`partOn_${i}`}
                    checked={!!on[p.key]}
                    onChange={(e) => setOn((prev) => ({ ...prev, [p.key]: e.target.checked }))}
                    aria-label={`Include ${p.label}`}
                  />
                </td>
                <td className="py-2 pr-3 font-medium">{p.label}</td>
                <td className="py-2 pr-3 text-neutral-600 dark:text-neutral-400">{[...new Set(p.itemNames)].join(', ') || '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{peso(p.left)}</td>
                <td className="py-2">
                  {p.kind === 'category' ? (
                    <span className="text-neutral-500 dark:text-neutral-400">from the items</span>
                  ) : (
                    <Select
                      name={`partPick_${i}`}
                      value={pick[p.key] ?? ''}
                      onChange={(e) => setPick((prev) => ({ ...prev, [p.key]: e.target.value }))}
                      disabled={!on[p.key]}
                      aria-label={`Category for ${p.label}`}
                    >
                      <option value="" disabled>
                        Pick a category…
                      </option>
                      {GROUPS.map((g) => {
                        const list = offered.filter((c) => c.group === g);
                        if (list.length === 0) return null;
                        return (
                          <optgroup key={g} label={g}>
                            {list.map((c) => (
                              <option key={c.id} value={c.id} disabled={!c.accountCode}>
                                {c.category}
                                {!c.accountCode ? ' (unmapped — cannot post)' : ''}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </Select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missingPick && <p className="text-xs text-danger">Pick a category for the items that don&apos;t have one yet.</p>}

      <div>
        <h3 className="mb-2 text-sm font-medium">
          Payments — add a line for each place the money came from. Together they must equal {peso(total)}, the parts you ticked.
        </h3>
        <MoneyLines
          key={String(total)}
          direction="out"
          {...moneyLines}
          supplierId={supplierId}
          supplierName={supplierName}
          supplierCreditTermsDays={supplierCreditTermsDays}
          mustTotal={ticked.length > 0 ? String(total) : null}
          initialLines={ticked.length > 0 ? [{ method, amount: String(total), moneyAccountId: null }] : undefined}
        />
      </div>

      {ticked.length > 0 && !matches && paid.length > 0 && (
        <p className="text-xs text-danger" role="status">
          The payments add up to {peso(paidTotal)}, but the parts you ticked total {peso(total)}. They must match.
        </p>
      )}

      {preview && (
        <ul className="space-y-0.5 text-xs text-neutral-600 dark:text-neutral-400" aria-label="How the payments will be split" data-batch-preview>
          {preview.map((g) => {
            const part = rows.find((p) => p.key === g.key);
            const amount = part ? part.left : '0';
            return (
              <li key={g.key}>
                {part?.label ?? g.key} {peso(amount)} = {g.lines.map((l) => `${sourceLabel(l)} ${peso(l.amount)}`).join(' + ')}
              </li>
            );
          })}
        </ul>
      )}

      {children}

      <SubmitButton variant="secondary" pendingLabel="Saving…" disabled={!canSave}>
        {`Record ${ticked.length} expense${ticked.length === 1 ? '' : 's'}`}
      </SubmitButton>
    </form>
  );
}

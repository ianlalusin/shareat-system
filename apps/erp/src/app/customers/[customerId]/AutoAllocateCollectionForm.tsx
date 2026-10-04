'use client';

/**
 * T-330 — "Record a payment" (an AR collection), with "Auto-allocate (oldest first)" added.
 *
 * ⭐ AP's mirror exactly — see `ap/suppliers/[id]/AutoAllocatePaymentForm.tsx`'s header for why
 * this is a client component, how `touched` keeps a typed box from being re-filled (Ian's ruling
 * 2), the checkbox/staleness fixes from the 2026-09-20 audit (F1/F3/F4), the `isSpokenFor`
 * predicate and ref-based staleness fix from the second audit round (F1/F2), the click-to-merge
 * race suppression and synchronous ref writes from the third round (A1/A2), and why every item
 * starts pre-filled at its full outstanding but untouched. This file adds nothing AP's twin does
 * not already explain; only the field names and the proof-of-payment upload differ.
 *
 * ⚠️ WHAT REMAINS UNVERIFIED: the click-to-merge race itself is not eliminated, only the false
 * banner it could produce. §9.4 cannot run this cycle (DEF-401), so nothing here has been
 * exercised in a real browser.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { compare, money, ZERO } from '@shareat/core/money';
import { PhotoInput } from '@/components/PhotoInput';
import type { AutoAllocateCollectionRequest, AutoAllocateCollectionResponse } from '../actions';

export interface ReceivableItem {
  chargeId: string;
  referenceNo: string | null;
  chargeDate: string;
  dueDate: string | null;
  outstanding: string;
}
export interface Wallet {
  id: string;
  name: string;
  custodian: string;
  balance: string;
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function peso(v: string): string {
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(n)
    : v;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}

export function AutoAllocateCollectionForm({
  postAction,
  previewAction,
  customerId,
  storeId,
  items,
  wallets,
  today,
  credit,
}: {
  postAction: (fd: FormData) => void | Promise<void>;
  previewAction: (req: AutoAllocateCollectionRequest) => Promise<AutoAllocateCollectionResponse>;
  customerId: string;
  storeId: string;
  items: readonly ReceivableItem[];
  wallets: readonly Wallet[];
  today: string;
  credit: string;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.chargeId, i.outstanding])),
  );
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [totalAmount, setTotalAmount] = useState('');
  const [surplus, setSurplus] = useState<string | null>(null);
  const [lastComputedKey, setLastComputedKey] = useState<string | null>(null);
  const [pageStale, setPageStale] = useState(false);
  const [raceDetected, setRaceDetected] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // ⛔ F2 — always hold the LATEST state, so a merge landing after an `await` reads what the
  // operator has on screen right now, never what was true when the click fired.
  const amountsRef = useRef(amounts);
  const touchedRef = useRef(touched);
  const totalAmountRef = useRef(totalAmount);
  useEffect(() => {
    amountsRef.current = amounts;
    touchedRef.current = touched;
    totalAmountRef.current = totalAmount;
  });

  function figuresKey(amount: string, values: Record<string, string>): string {
    return JSON.stringify([amount, items.map((i) => values[i.chargeId] ?? '')]);
  }
  const editedSinceCheck =
    lastComputedKey !== null && lastComputedKey !== figuresKey(totalAmount, amounts);

  // ⛔ F1 — THE one predicate for "this box is the operator's, not auto-allocate's": touched AND
  // non-blank. Used identically to build the `typed` payload and to gate the merge.
  function isSpokenFor(id: string, values: Record<string, string>, touchedIds: Set<string>): boolean {
    return touchedIds.has(id) && values[id] !== '' && values[id] !== undefined;
  }

  function setAmount(id: string, value: string) {
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(id);
      touchedRef.current = next; // A2 — synchronous, not just the backstop effect
      return next;
    });
    setAmounts((prev) => {
      const next = { ...prev, [id]: value };
      amountsRef.current = next; // A2
      return next;
    });
  }

  function setTotal(value: string) {
    totalAmountRef.current = value; // A2
    setTotalAmount(value);
  }

  function autoAllocate() {
    setPreviewError(null);
    const amountsAtClick = amountsRef.current;
    const touchedAtClick = touchedRef.current;
    const totalAtClick = totalAmountRef.current;
    const typed = items
      .filter((i) => isSpokenFor(i.chargeId, amountsAtClick, touchedAtClick))
      .map((i) => ({ chargeId: i.chargeId, amount: amountsAtClick[i.chargeId]! }));
    startTransition(async () => {
      const res = await previewAction({ customerId, storeId, amount: totalAtClick || '0', typed });
      if (!res.ok) {
        setPreviewError(res.error);
        setSurplus(null);
        setLastComputedKey(null);
        setRaceDetected(false);
        return;
      }

      // F4 — the action re-reads `openItems` itself and can legitimately return an id this page
      // never rendered a box for. Drop it rather than silently understate what `surplus` claims.
      const knownIds = new Set(items.map((i) => i.chargeId));
      const kept = res.allocations.filter((a) => knownIds.has(a.chargeId));
      setPageStale(kept.length !== res.allocations.length);

      // F2 — read live, not the click-time closure.
      const liveAmounts = amountsRef.current;
      const liveTouched = touchedRef.current;
      const liveTotal = totalAmountRef.current;

      const next = { ...liveAmounts };
      for (const item of items) {
        if (isSpokenFor(item.chargeId, liveAmounts, liveTouched)) continue;
        next[item.chargeId] = '';
      }
      for (const a of kept) {
        if (isSpokenFor(a.chargeId, liveAmounts, liveTouched)) continue;
        next[a.chargeId] = a.amountApplied;
      }
      setAmounts(next);

      // A1 — suppress the figure if any input changed between click and merge (see AP's header
      // comment for the full failure this closes: an under-allocation is legal, so a wrong "fully
      // allocated" banner is the one thing standing between this race and a silent short payment).
      const racedDuringFlight =
        amountsAtClick !== liveAmounts || touchedAtClick !== liveTouched || totalAtClick !== liveTotal;
      if (racedDuringFlight) {
        setSurplus(null);
        setLastComputedKey(null);
        setRaceDetected(true);
      } else {
        setSurplus(res.surplus);
        setLastComputedKey(figuresKey(liveTotal, next));
        setRaceDetected(false);
      }
    });
  }

  return (
    <form action={postAction} className="space-y-3">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="storeId" value={storeId} />

      <div className="space-y-1">
        {items.map((i) => {
          const value = amounts[i.chargeId] ?? '';
          const checked = value !== '';
          return (
            <label key={i.chargeId} className="flex flex-wrap items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="allocateChargeId"
                value={i.chargeId}
                checked={checked}
                onChange={(e) => setAmount(i.chargeId, e.target.checked ? i.outstanding : '')}
              />
              <span className="min-w-0 flex-1">
                {i.referenceNo ?? i.chargeDate} — owed {peso(i.outstanding)}
                {i.dueDate && (
                  <span
                    className={
                      i.dueDate < today
                        ? 'ml-2 text-xs font-medium text-red-700 dark:text-red-400'
                        : 'ml-2 text-xs text-neutral-500'
                    }
                  >
                    due {i.dueDate}
                    {i.dueDate < today && ' · overdue'}
                  </span>
                )}
              </span>
              <input
                type="text"
                inputMode="decimal"
                name={`allocateAmount_${i.chargeId}`}
                value={value}
                aria-label={`Amount applied to ${i.referenceNo ?? i.chargeDate}`}
                onChange={(e) => setAmount(i.chargeId, e.target.value)}
                className="w-28 rounded border border-neutral-300 bg-white px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          );
        })}
      </div>

      <div>
        <button
          type="button"
          onClick={autoAllocate}
          disabled={pending}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {pending ? 'Allocating…' : 'Auto-allocate (oldest first)'}
        </button>
        {pageStale && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            ⚠️ The open items changed since this page loaded — refresh before relying on this
            figure or pressing Save.
          </p>
        )}
        {!pageStale && (raceDetected || (surplus !== null && editedSinceCheck)) && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            The boxes changed since that check — press &ldquo;Auto-allocate&rdquo; again for an
            up to date figure.
          </p>
        )}
        {surplus !== null && !pageStale && !raceDetected && !editedSinceCheck && (
          <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
            {compare(money(surplus), ZERO) > 0
              ? `₱${surplus} would be surplus — booked as 2140 (customer store credit) unless you edit the boxes above.`
              : 'Fully allocated across the boxes above.'}
          </p>
        )}
        {previewError && (
          <p className="mt-2 text-xs text-red-700 dark:text-red-400">Refused: {previewError}</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Total received (gross)">
          <input
            name="amount"
            required
            inputMode="decimal"
            placeholder="0.00"
            value={totalAmount}
            onChange={(e) => setTotal(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field label="Platform fee" hint="⛔ Booked here (6400) and NOWHERE else. Never also as an expense.">
          <input name="platformFee" inputMode="decimal" placeholder="0.00" className={INPUT} />
        </Field>
        <Field label="Date">
          <input type="date" name="collectionDate" required defaultValue={today} className={INPUT} />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Into account">
          <select name="moneyAccountId" required defaultValue="" className={INPUT}>
            <option value="" disabled>Choose…</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>{w.name} ({w.custodian}) — {peso(w.balance)}</option>
            ))}
          </select>
        </Field>
        <Field label="Reference no." hint="Optional.">
          <input name="referenceNo" className={INPUT} />
        </Field>
      </div>

      {compare(money(credit), ZERO) > 0 && (
        <Field
          label="Store credit to apply"
          hint={`${peso(credit)} held at 2140. Spending it draws the liability down instead of taking cash.`}
        >
          <input name="creditApplied" inputMode="decimal" placeholder="0.00" className={INPUT} />
        </Field>
      )}

      <Field
        label="Proof of payment"
        hint="Required for an online or e-wallet account: the deposit slip or transfer screenshot."
      >
        <PhotoInput name="receiptPhoto" accept="image/*" className="text-sm" />
      </Field>

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        Record payment
      </button>
    </form>
  );
}

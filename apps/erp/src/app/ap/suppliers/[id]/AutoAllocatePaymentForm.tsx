'use client';

/**
 * T-330 — "Record a payment", with "Auto-allocate (oldest first)" added.
 *
 * ⚠️ A client component only because it must react to the amount boxes and call the server for a
 * proposal before Save — same reason `channel-settlements/SettlementForm.tsx` is one. It computes
 * nothing itself: `previewAction` is `autoAllocatePaymentAction`, which calls the same
 * `suggestPaymentAllocation` the domain owns; this file only decides which boxes are "already
 * typed" and therefore off-limits to the next auto-allocate click (Ian's ruling 2).
 *
 * ⭐ "Typed" is tracked per box in `touched` — set the moment the operator edits a checkbox or an
 * amount by hand, and never cleared by an auto-allocate response. Auto-allocate only ever
 * overwrites boxes NOT in `touched`, matching `allocateOldestFirst`'s own contract exactly. Every
 * item starts pre-filled at its full outstanding but NOT touched, so a single-invoice supplier can
 * just press "Record payment" with no extra click — exactly T-330-before's behaviour — while a
 * first auto-allocate click is still free to re-decide every box.
 *
 * ⛔ FIX (audit, 2026-09-20): the checkbox used to be `checked={value !== '' && Number(value) > 0}`
 * — CONTROLLED BY A PARSE. Typing `3,000.00` (comma) makes `Number()` return `NaN`, so the box
 * silently UNTICKS ITSELF and the row is never submitted at all (`recordPaymentAction` only reads
 * `allocateAmount_X` for ids present in `allocateExpenseId`). That is the exact predicate T-328
 * deleted from this file's own server action, rebuilt one layer out where T-328's fix cannot reach
 * it. `checked` is now `value !== ''` — any non-blank box submits, and a malformed one is refused
 * readably by the server's own `parseMoneyInput` (F5), never silently dropped.
 *
 * ⛔ FIX (audit, F4): the server re-reads `openItems` inside its own transaction and can legally
 * return an id that is no longer in `items` (this page's snapshot) if the open set changed after
 * render. That id has no box to hold it, so it is dropped from the merge and the operator is told
 * the page is stale, rather than the screen quietly understating what reaches 1240.
 *
 * ⭐ FIX (audit, F3): `lastComputedKey` snapshots what an auto-allocate response was actually
 * computed against. If the operator edits ANY box or the total afterward, the banner stops
 * claiming "fully allocated" and says the figure is stale instead — same principle
 * `SettlementForm`'s `figuresKey`/`stale` uses, sized to what T-330 actually needs (this screen
 * never blocks Save on it — §2 already lets the operator edit and post directly).
 *
 * ⛔⛔ FIX (audit round 2, F1) — RULING, NOT MERELY A BUG FIX: `isSpokenFor` is the ONE predicate
 * for "this box is the operator's, not auto-allocate's" — derived once, used both to build the
 * `typed` payload sent to the server AND to decide which boxes the merge may touch. The two used
 * to disagree (`typed` required non-blank; the merge skip did not), which meant a box the operator
 * CLEARED was invisible to the server (so it planned money for it) but untouchable by the merge
 * (so that money could never land in a box) — the payment's own total could vanish into 1240 with
 * every invoice still open, silently. Ian's ruling 2 only forbids overwriting a TYPED amount; a
 * cleared box IS empty, so re-filling it on the next Auto-allocate click is correct, not a
 * violation — mildly annoying, visible, and safe, the opposite of a screen that looks full and
 * submits nothing.
 *
 * ⛔⛔ FIX (audit round 2, F2): the merge used to close over `amounts`/`touched`/`totalAmount` as
 * they stood at CLICK time, then write the merged result with a plain `setAmounts(next)` after the
 * `await` — so a box the operator edited WHILE the request was in flight was silently discarded
 * and, if untouched in the closure, immediately overwritten by the server's suggestion. `pending`
 * cannot guard this window: React 18's `startTransition` drops `isPending` at the first `await`,
 * so the button and the boxes are live again well before the response lands. Fixed with refs that
 * always hold the latest state — the merge reads `amountsRef.current`/`touchedRef.current` at THE
 * MOMENT THE RESPONSE ARRIVES, not what was captured when the click fired.
 *
 * ⛔⛔ FIX (audit round 3, A1) — THE BANNER, NOT THE RACE, IS WHAT MAKES THIS DANGEROUS: F2's merge
 * always trusts the LIVE boxes, so an edit made mid-flight lands correctly in the box itself — but
 * `lastComputedKey` used to be derived from that same merged state, which made `editedSinceCheck`
 * compare the merged result against itself and never fire for exactly the edits it existed to
 * catch. `autoAllocate` now also snapshots `amountsAtClick`/`touchedAtClick`/`totalAtClick` before
 * the `await`, and if any of the three differ from the live refs once the response lands, the
 * figure is SUPPRESSED (`unallocated` stays `null`, `raceDetected` becomes `true`) rather than
 * shown next to boxes it no longer describes — an under-allocation here is legal (DEF-394) and
 * `recordPayment`'s own guard cannot catch it, so a wrong "fully allocated" claim is the one thing
 * standing between this and a silent short payment. ⭐ Not "fixed by computing the key from the
 * click-time snapshot instead" — that message would fire after every successful auto-allocate
 * (the merge always changes the boxes) and be ignored within a day. Comparing snapshot-to-snapshot,
 * not key-to-render, is what makes it fire only when it should. The underlying race is NOT closed
 * by this — see the file-level note below.
 *
 * ⛔ FIX (audit round 3, A2): `amountsRef`/`touchedRef`/`totalAmountRef` are now also written
 * SYNCHRONOUSLY inside `setAmount` and the total field's `onChange`, not only inside the `useEffect`
 * below (kept as a backstop). An effect is a passive, scheduled flush; an event handler is not —
 * writing the ref at the same moment the event fires removes any theoretical ordering question
 * between "the effect has run" and "the awaited response resumed."
 *
 * ⚠️ WHAT REMAINS UNVERIFIED: the click-to-merge race itself is not eliminated, only the false
 * banner it could produce. §9.4 cannot run this cycle (DEF-401 — nobody can open the app), so
 * nothing here has been exercised in a real browser.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { compare, money, ZERO } from '@shareat/core/money';
import type { AutoAllocateRequest, AutoAllocateResponse } from '../../actions';
import { Button, Input, Select } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { SUPPLIER_PAYMENT_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';

export interface PayableItem {
  expenseId: string;
  particulars: string;
  businessDate: string;
  outstanding: string;
  /** T-432: the bill this open item belongs to, so `?bill=` can pre-fill only that bill's items. */
  supplierInvoiceId?: string;
}
export interface Wallet {
  id: string;
  name: string;
  custodian: string;
  instrument?: string;
  balance: string;
}
/** T-432: an open cash request at this store the viewer may spend (the `openFloatsForStore` shape). */
export interface PayableFloat {
  cashRequestId: string;
  holderName: string;
  outstanding: string;
  moneyAccountId: string | null;
  storeId: string;
}

function peso(v: string): string {
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(n)
    : v;
}

function Field({ label, hint, rule, children }: { label: string; hint?: string; rule?: FieldRule; children: React.ReactNode }) {
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field puts its live helper line OUTSIDE the label, so the line never joins the accessible name.
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

export function AutoAllocatePaymentForm({
  // T-440: the prop is the page's `recordPaymentAction`; it keeps that name here so the form's server action is the one the guard traces.
  postAction: recordPaymentAction,
  previewAction,
  supplierId,
  storeId,
  requestId,
  items,
  wallets,
  floats = [],
  hasUnroutedFloat = false,
  prefillBill = null,
  today,
}: {
  postAction: (fd: FormData) => void | Promise<void>;
  previewAction: (req: AutoAllocateRequest) => Promise<AutoAllocateResponse>;
  supplierId: string;
  storeId: string;
  /** DEF-778: generated when the page renders and submitted back, so a double click is a replay, not a second payment. */
  requestId: string;
  items: readonly PayableItem[];
  wallets: readonly Wallet[];
  floats?: readonly PayableFloat[];
  /** T-432 ruling 4: a holder only - a request at this store has no staff cash account yet. */
  hasUnroutedFloat?: boolean;
  /** T-432 ruling 7: when set (and it matches an item), only that bill's items start filled. */
  prefillBill?: string | null;
  today: string;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const only = prefillBill && items.some((i) => i.supplierInvoiceId === prefillBill) ? prefillBill : null;
    return Object.fromEntries(items.map((i) => [i.expenseId, only === null || i.supplierInvoiceId === only ? i.outstanding : '']));
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [totalAmount, setTotalAmount] = useState('');
  const [unallocated, setUnallocated] = useState<string | null>(null);
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
    return JSON.stringify([amount, items.map((i) => values[i.expenseId] ?? '')]);
  }
  const editedSinceCheck =
    lastComputedKey !== null && lastComputedKey !== figuresKey(totalAmount, amounts);

  // ⛔ F1 — THE one predicate for "this box is the operator's, not auto-allocate's": touched AND
  // non-blank. Used identically to build the `typed` payload and to gate the merge, so the two
  // can never again disagree about which boxes are spoken for.
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
      .filter((i) => isSpokenFor(i.expenseId, amountsAtClick, touchedAtClick))
      .map((i) => ({ expenseId: i.expenseId, amount: amountsAtClick[i.expenseId]! }));
    startTransition(async () => {
      const res = await previewAction({ supplierId, storeId, amount: totalAtClick || '0', typed });
      if (!res.ok) {
        setPreviewError(res.error);
        setUnallocated(null);
        setLastComputedKey(null);
        setRaceDetected(false);
        return;
      }

      // F4 — the action re-reads `openItems` itself and can legitimately return an id this page
      // never rendered a box for (the open set changed after load). Drop it rather than silently
      // understate what `unallocated` claims is covered.
      const knownIds = new Set(items.map((i) => i.expenseId));
      const kept = res.allocations.filter((a) => knownIds.has(a.expenseId));
      setPageStale(kept.length !== res.allocations.length);

      // F2 — read live, not the click-time closure: the operator may have typed into a box while
      // this request was in flight, and that box must win over a suggestion computed without it.
      const liveAmounts = amountsRef.current;
      const liveTouched = touchedRef.current;
      const liveTotal = totalAmountRef.current;

      const next = { ...liveAmounts };
      for (const item of items) {
        if (isSpokenFor(item.expenseId, liveAmounts, liveTouched)) continue;
        next[item.expenseId] = '';
      }
      for (const a of kept) {
        if (isSpokenFor(a.expenseId, liveAmounts, liveTouched)) continue;
        next[a.expenseId] = a.amountApplied;
      }
      setAmounts(next);

      // A1 — the response was computed against the CLICK-time snapshot. If any of the three inputs
      // changed before this point (mid-flight edit), the figure describes inputs that no longer
      // exist: suppress it rather than let it sit next to boxes the operator has since edited.
      const racedDuringFlight =
        amountsAtClick !== liveAmounts || touchedAtClick !== liveTouched || totalAtClick !== liveTotal;
      if (racedDuringFlight) {
        setUnallocated(null);
        setLastComputedKey(null);
        setRaceDetected(true);
      } else {
        setUnallocated(res.unallocated);
        setLastComputedKey(figuresKey(liveTotal, next));
        setRaceDetected(false);
      }
    });
  }

  return (
    <CheckedForm rules={SUPPLIER_PAYMENT_RULES} action={recordPaymentAction} className="space-y-3">
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="space-y-1">
        {items.map((i) => {
          const value = amounts[i.expenseId] ?? '';
          const checked = value !== '';
          return (
            <label key={i.expenseId} className="flex flex-wrap items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="allocateExpenseId"
                value={i.expenseId}
                checked={checked}
                onChange={(e) => setAmount(i.expenseId, e.target.checked ? i.outstanding : '')}
              />
              <span className="min-w-0 flex-1 basis-48">{i.particulars} — owed {peso(i.outstanding)}</span>
              <Input
                type="text"
                inputMode="decimal"
                name={`allocateAmount_${i.expenseId}`}
                value={value}
                onChange={(e) => setAmount(i.expenseId, e.target.value)}
                className="min-w-0 flex-1 basis-28 text-right"
              />
            </label>
          );
        })}
      </div>

      <div>
        <Button type="button" variant="secondary" onClick={autoAllocate} disabled={pending}>
          {pending ? 'Allocating…' : 'Auto-allocate (oldest first)'}
        </Button>
        {pageStale && (
          <p className="mt-2 text-xs text-warning-ink">
            ⚠️ The open items changed since this page loaded — refresh before relying on this
            figure or pressing Save.
          </p>
        )}
        {!pageStale && (raceDetected || (unallocated !== null && editedSinceCheck)) && (
          <p className="mt-2 text-xs text-warning-ink">
            The boxes changed since that check — press &ldquo;Auto-allocate&rdquo; again for an
            up to date figure.
          </p>
        )}
        {unallocated !== null && !pageStale && !raceDetected && !editedSinceCheck && (
          <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
            {compare(money(unallocated), ZERO) > 0
              ? `₱${unallocated} would be unallocated — routed to advances to suppliers as an overpayment unless you edit the boxes above.`
              : 'Fully allocated across the boxes above.'}
          </p>
        )}
        {previewError && (
          <p className="mt-2 text-xs text-danger">Refused: {previewError}</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Total handed over" rule={SUPPLIER_PAYMENT_RULES.amount}>
          <Input
            {...nativeAttrs(SUPPLIER_PAYMENT_RULES.amount)}
            placeholder="0.00"
            value={totalAmount}
            onChange={(e) => setTotal(e.target.value)}
            className="w-full"
          />
        </Field>
        <Field label="Pay from" hint={hasUnroutedFloat ? 'A cash request at this store has no staff cash account yet; it can be spent on a new expense.' : undefined} rule={SUPPLIER_PAYMENT_RULES.source}>
          <Select {...nativeAttrs(SUPPLIER_PAYMENT_RULES.source)} defaultValue="" className="w-full">
            <option value="" disabled>Choose…</option>
            {/* T-432 ruling 2: staff cash is reached only through a request. */}
            {wallets
              .filter((w) => !(w.custodian === 'staff' && w.instrument === 'cash'))
              .map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.custodian}) — {peso(w.balance)}</option>
              ))}
            {floats.map((f) => (
              <option key={f.cashRequestId} value={`float:${f.cashRequestId}`}>
                {f.holderName} · cash request — Balance {peso(f.outstanding)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" rule={SUPPLIER_PAYMENT_RULES.businessDate}>
          <Input type="date" {...nativeAttrs(SUPPLIER_PAYMENT_RULES.businessDate)} defaultValue={today} className="w-full" />
        </Field>
      </div>
      <Field label="Reference no." hint="Optional.">
        <Input name="referenceNo" className="w-full" />
      </Field>
      <Button type="submit" variant="primary">
        Record payment
      </Button>
    </CheckedForm>
  );
}

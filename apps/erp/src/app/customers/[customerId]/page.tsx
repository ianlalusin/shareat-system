import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, money, ZERO } from '@shareat/core/money';
import { authorize, heldCapabilities, can } from '@shareat/auth';
import { canReadFiles } from '@shareat/domain';
import { ACTION_LINK } from '@/components/action-link';
import { requirePageAccess, StoreNotAvailable } from '../../../lib/page-access';
import {
  recordCollectionAction,
  autoAllocateCollectionAction,
  voidChargeAction,
  voidCollectionAction,
  writeOffChargeAction,
} from '../actions';
import { AutoAllocateCollectionForm } from './AutoAllocateCollectionForm';
import {
  TREATMENT_LABEL,
  TREATMENT_TONE,
  creditBalance,
  arStoresFor,
  getCustomer,
  getPosition,
  isOverLimit,
  listCharges,
  listCollections,
  moneyAccountsFor,
  openItemsFor,
  peso,
  storesWithOpenItems,
  today,
  withOrgPrincipal,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { withFlash } from '@/lib/flash';
import { Badge, Button, ConfirmDestructive, FlashBanner, Input, LinkRow, RowAction, RowLink } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import {
  CHARGE_VOID_RULES,
  CHARGE_WRITE_OFF_RULES,
  COLLECTION_VOID_RULES,
  nativeAttrs,
  type FieldRule,
} from '@shareat/domain/field-rules';

export const metadata = { title: 'Customer — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-226 / DEF-190 — **the screen that clears a receivable.**
 *
 * ⛔ `1210 Accounts receivable` was raised automatically by trade dispatch (`trade/index.ts:460` —
 * dispatch IS the billing event) and reported by `/reports/ar-aging` and by a balance column on
 * `/customers`, and **nothing anywhere cleared it**. `recordCollection`, `voidCollection` and
 * `writeOffCharge` shipped with T-131 on 2 September, gated and tested, with zero callers under
 * `apps/`. That is not merely a missing convenience: `recordCharge` enforces the credit limit from
 * the live position, so a customer whose debt can never be cleared eventually hits their limit and
 * can no longer be dispatched to — **the missing screen eventually stops sales.**
 *
 * ⭐ **Every figure here is derived.** There is no `outstanding` column and this task adds none:
 * v1's stored `outstandingBalance` disagreed with its own inputs on 106 of 794 live rows (13.3%),
 * and its *"recompute balance"*, *"repair collection"* and *"mark reconciled"* buttons all exist
 * only to patch that. Nothing to recompute here, so none of the three is ported.
 *
 * ⛔ **The page gates nothing itself, with one exception.** Every domain function authorizes by
 * contract; this file renders controls and surfaces refusals. DEF-189's lesson binds the reads:
 * never call a gated domain function to satisfy a page read — that returns HTTP 500 where a
 * refusal is wanted.
 *
 * ⭐ **T-367 S1 audit finding 4 (Ian's ruling) — the write-off/void section IS gated per store.**
 * `writeOffCharge`, `voidCharge` and `voidCollection` all give a non-holder the SAME uniform
 * "does not exist" sentence as a forged id (the DEF-497 shape, `ar/index.ts`'s
 * `CHARGE_OUT_OF_REACH` / `CHARGE_VOID_OUT_OF_REACH` / `COLLECTION_VOID_OUT_OF_REACH`, DEF-546), so
 * showing either form to someone who cannot use it would tell them a real charge or collection does
 * not exist. `heldCapabilities` is the cheap org-wide pre-check; a per-store `authorize()` probe
 * narrows it down per store — the same idiom `channel-settlements/page.tsx` uses, not a new auth
 * helper. `authorize()` in the domain stays the real gate; this only decides what renders.
 */
interface SearchParams {
  error?: string;
  ok?: string;
  /** Which store's receivables are being settled. AR is store-scoped, exactly as AP is. */
  store?: string;
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { customerId } = await params;
  const sp = await withFlash(searchParams);
  // T-435 / bible row 353 - `record_ar_collection` to read; everything below is limited to the viewer's own stores.
  const { actor, refusal } = await requirePageAccess(`/customers/${customerId}`);
  if (refusal) return refusal;
  const orgId = actor.orgId;
  if ((await arStoresFor(actor)).length === 0) return <StoreNotAvailable />;

  // The same notFound() for a customer outside the viewer's stores as for a forged id (DEF-497).
  const customer = await getCustomer(actor, customerId);
  if (!customer) notFound();

  const [owedOverall, overLimit, credit, storeOptions] = await Promise.all([
    getPosition(actor, customerId),
    isOverLimit(actor, customerId),
    creditBalance(actor, customerId),
    storesWithOpenItems(actor, customerId),
  ]);
  // A requested store the viewer does not hold: one sentence, nothing of that store (and no quiet fallback).
  if (sp.store) {
    const heldIds = new Set((await arStoresFor(actor)).map((x) => x.id));
    if (!heldIds.has(sp.store)) return <StoreNotAvailable />;
  }

  // ⭐ CHOSEN, never inferred from whichever open item sorted first — `/ap/suppliers/[id]`'s rule,
  // copied with its reason: that older AP behaviour booked every leg of a payment at one store when
  // the supplier was owed at two, so one store's control account went negative and the other's
  // never cleared. ⚠️ A customer with nothing open still renders; the actions that need an open
  // item are simply absent, with the reason on screen.
  const storeId =
    sp.store && storeOptions.some((s) => s.storeId === sp.store)
      ? sp.store
      : (storeOptions[0]?.storeId ?? '');

  const [charges, collections, openItems, wallets, owedHere] = await Promise.all([
    listCharges(actor, customerId),
    listCollections(actor, customerId),
    storeId ? openItemsFor(actor, customerId, storeId) : Promise.resolve([]),
    storeId ? moneyAccountsFor(actor, storeId) : Promise.resolve([]),
    storeId ? getPosition(actor, customerId, storeId) : Promise.resolve('0.00'),
  ]);

  // Photo links only for receipts this viewer can actually open (the same check the route makes).
  const viewableReceipts = await withOrgPrincipal(orgId, (tx) =>
    canReadFiles(tx, actor, collections.map((c) => c.receiptFileId).filter((x): x is string => !!x)),
  );
  const now = today();
  const storeName = (id: string) => storeOptions.find((s) => s.storeId === id)?.storeName ?? '—';

  // T-367 S1 audit finding 4 — see the file header. `write_off_receivable` and `approve_buyer`
  // (`voidCharge`'s own capability) are checked per store, over only the stores a POSTED charge
  // is actually at.
  const postedChargeStoreIds = [...new Set(charges.filter((c) => c.status === 'posted').map((c) => c.storeId))];
  const [canWriteOffAtStore, canVoidAtStore] = await withOrgPrincipal(orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    const probe = async (capability: 'write_off_receivable' | 'approve_buyer') => {
      if (!held.has(capability)) return new Set<string>();
      const ok = new Set<string>();
      for (const sid of postedChargeStoreIds) {
        if (await can(tx, actor, capability, { storeId: sid })) ok.add(sid);
      }
      return ok;
    };
    return Promise.all([probe('write_off_receivable'), probe('approve_buyer')]);
  });
  const canWriteOffAt = (id: string) => canWriteOffAtStore.has(id);
  const canVoidAt = (id: string) => canVoidAtStore.has(id);
  const canActOnCharge = (c: { storeId: string }) => canWriteOffAt(c.storeId) || canVoidAt(c.storeId);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/customers"
            className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
          >
            ← Customers
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{customer.name}</h1>
          <p className={`text-xs ${TREATMENT_TONE[customer.treatment] ?? ''}`}>
            {TREATMENT_LABEL[customer.treatment]}
            {customer.status !== 'active' && (
              <Badge status={customer.status} className="ml-2" />
            )}
          </p>
        </div>
        <div className="text-right">
          {/* ⚠️ Two positions, deliberately kept apart. The credit limit is judged ORG-WIDE — a
              limit is extended to a buyer, not to a buyer at one branch — while allocation happens
              per store. Conflating them is how a limit silently becomes per-branch. */}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Owed at your stores</p>
          <p className="text-2xl font-semibold tabular-nums">{peso(owedOverall)}</p>
          {customer.creditLimit !== null && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              limit {peso(customer.creditLimit)}
              {overLimit && (
                <span className="ml-1 font-medium text-danger">over limit</span>
              )}
            </p>
          )}
          {storeId && (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {peso(owedHere)} at {storeName(storeId)}
            </p>
          )}
          {compare(money(credit), ZERO) > 0 && (
            <p className="mt-1 text-xs text-success">
              {peso(credit)} store credit held
            </p>
          )}
        </div>
      </div>

      <FlashBanner flash={sp} />

      {storeOptions.length > 1 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Which store&rsquo;s receivables?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            This customer owes money at more than one store. A collection settles ONE store&rsquo;s
            charges and lands in that store&rsquo;s own account &mdash; collecting across stores
            would clear a receivable the receiving store never recorded.
          </p>
          <div className="flex flex-wrap gap-2">
            {storeOptions.map((s) => (
              <Link
                key={s.storeId}
                href={`/customers/${customerId}?store=${s.storeId}`}
                className={
                  s.storeId === storeId
                    ? 'rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                    : 'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900'
                }
              >
                {s.storeName} &mdash; {peso(s.outstanding)} <span className="opacity-60">({s.count})</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ Record a collection */}
      {openItems.length > 0 ? (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Record a payment</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⛔ Name the charges this settles (bible §16.10 &mdash; a collection must never float
            unallocated), or press &ldquo;Auto-allocate&rdquo; to fill the empty boxes
            most-overdue-first (T-330) and edit from there. <strong>Total received is GROSS</strong>:
            the receivable is relieved by it, and the account receives it minus the fee. Paying
            more than allocated becomes real store credit, which the next payment can draw
            on.
          </p>
          <AutoAllocateCollectionForm
            postAction={recordCollectionAction}
            previewAction={autoAllocateCollectionAction}
            customerId={customerId}
            storeId={storeId}
            items={openItems}
            wallets={wallets}
            today={now}
            credit={credit}
          />
        </section>
      ) : (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          Nothing outstanding — there is no open charge to collect against.
          {charges.length === 0 && ' This customer has never been charged.'}
        </p>
      )}

      {/* ------------------------------------------------------------------------------ Charges */}
      <section className="space-y-2">
        <h2 className="font-medium">Charges</h2>
        {charges.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Written off</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => {
                  const overdue = c.dueDate !== null && c.dueDate < now && compare(money(c.outstanding), ZERO) > 0;
                  return (
                    <LinkRow
                      key={c.chargeId}
                      // T-258/DEF-244: the row itself is the tap target when there's an entry to view —
                      // LinkRow (T-411) is the containing block the "entry" RowLink stretches over. A `<tr>`
                      // cannot be wrapped in `<a>` (invalid HTML), so the stretched link is how a real anchor
                      // still ends up covering the whole row without breaking table semantics.
                      className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                        c.status === 'posted' ? '' : 'opacity-60'
                      } ${c.journalEntryId ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40' : ''}`}
                    >
                      <td className="px-3 py-3">{c.chargeDate}</td>
                      <td className={`px-3 py-3 ${overdue ? 'font-medium text-danger' : ''}`}>
                        {c.dueDate ?? '—'}
                        {overdue && <span className="ml-1 text-xs">overdue</span>}
                      </td>
                      <td className="px-3 py-3">
                        {c.referenceNo ?? '—'}
                        {/* ⭐ Every figure walks back to the entry that produced it — the thing v1
                            structurally cannot do, because its "entry" was a single leg. */}
                        {c.journalEntryId && (
                          <RowLink
                            href={`/reports/journal-lines?entry=${c.journalEntryId}`}
                            aria-label={`View journal entry — ${c.referenceNo ?? c.chargeDate}, ${peso(c.outstanding)} outstanding`}
                            className="ml-2 text-xs text-neutral-500 dark:text-neutral-400"
                          >
                            entry
                          </RowLink>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.totalAmount)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.allocatedAmount)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.writtenOffAmount)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.outstanding)}</td>
                      <td className="px-3 py-3 text-xs">{c.status}</td>
                    </LinkRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No charges yet. A charge is raised when a trade order is dispatched — dispatch is the
            billing event.
          </p>
        )}
      </section>

      {/* --------------------------------------------------------- Write off / void a charge */}
      {charges.some((c) => c.status === 'posted' && canActOnCharge(c)) && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Write off or void a charge</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⛔ <strong>A write-off takes two people.</strong> Whoever recorded the charge cannot
            also declare it dead — the service refuses it by identity, whatever the role. A partial
            write-off is allowed and leaves the remainder outstanding. ⚠️ <strong>Void</strong> is a
            different act: it says the charge should never have existed, and reverses its entry.
          </p>
          {charges
            .filter((c) => c.status === 'posted' && canActOnCharge(c))
            .map((c) => (
              <div
                key={c.chargeId}
                className="space-y-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              >
                <p className="font-medium">
                  {c.referenceNo ?? c.chargeDate} &mdash; {peso(c.outstanding)} outstanding of{' '}
                  {peso(c.totalAmount)}
                  <span className="ml-2 text-xs font-normal text-neutral-500">{storeName(c.storeId)}</span>
                </p>
                {compare(money(c.outstanding), ZERO) > 0 && canWriteOffAt(c.storeId) && (
                  <CheckedForm rules={CHARGE_WRITE_OFF_RULES} action={writeOffChargeAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="customerId" value={customerId} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="chargeId" value={c.chargeId} />
                    <Field label="Write off" className="min-w-[8rem] flex-1" rule={CHARGE_WRITE_OFF_RULES.amount}>
                      <Input
                        {...nativeAttrs(CHARGE_WRITE_OFF_RULES.amount)}
                        defaultValue={c.outstanding}
                        className="w-full"
                      />
                    </Field>
                    <Field label="Why is it uncollectible?" className="min-w-[14rem] flex-[2]" rule={CHARGE_WRITE_OFF_RULES.reason}>
                      <Input {...nativeAttrs(CHARGE_WRITE_OFF_RULES.reason)} className="w-full" />
                    </Field>
                    <ConfirmDestructive
                      tier="admin-pin"
                      label="Write off as bad debt"
                      consequence="Writes this charge off to bad debt. An administrator must approve with their own PIN."
                    />
                  </CheckedForm>
                )}
                {canVoidAt(c.storeId) && (
                  <CheckedForm rules={CHARGE_VOID_RULES} action={voidChargeAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="customerId" value={customerId} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="chargeId" value={c.chargeId} />
                    <Field label="Void this charge — why?" className="min-w-[14rem] flex-[2]" rule={CHARGE_VOID_RULES.reason}>
                      <Input {...nativeAttrs(CHARGE_VOID_RULES.reason)} className="w-full" />
                    </Field>
                    <ConfirmDestructive
                      tier="admin-pin"
                      label="Void charge"
                      consequence="Voids this charge and reverses its entry. An administrator must approve with their own PIN."
                    />
                  </CheckedForm>
                )}
              </div>
            ))}
        </section>
      )}

      {/* -------------------------------------------------------------------------- Collections */}
      <section className="space-y-2">
        <h2 className="font-medium">Collections</h2>
        {collections.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Gross</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2 font-medium">Into</th>
                  <th className="px-3 py-2 font-medium">Settled</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <LinkRow
                    key={c.collectionId}
                    // T-258/DEF-244: same stretched-link technique as the Charges table. This row can
                    // carry BOTH the entry link and the void form at once (a posted collection with a
                    // journal entry) — the void form and the receipt link sit in a RowAction above the
                    // stretched entry link, so neither swallows the other.
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      c.status === 'posted' ? '' : 'opacity-60'
                    } ${c.journalEntryId ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40' : ''}`}
                  >
                    <td className="px-3 py-3">
                      {c.collectionDate}
                      {c.journalEntryId && (
                        <RowLink
                          href={`/reports/journal-lines?entry=${c.journalEntryId}`}
                          aria-label={`View journal entry — collection ${c.collectionDate}, ${peso(c.amount)}`}
                          className="ml-2 text-xs text-neutral-500 dark:text-neutral-400"
                        >
                          entry
                        </RowLink>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.amount)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.platformFee)}</td>
                    <td className="px-3 py-3 text-xs">
                      {c.moneyAccountName ?? '—'}
                      {c.referenceNo && <div className="text-neutral-400">{c.referenceNo}</div>}
                      {c.receiptFileId && viewableReceipts.has(c.receiptFileId) && (
                        <RowAction>
                          <a
                            href={`/files/${c.receiptFileId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={ACTION_LINK}
                          >
                            View photo
                          </a>
                        </RowAction>
                      )}
                    </td>
                    {/* ⭐ WHAT it settled, not merely how much came in. A list of amounts cannot
                        answer the only question a disputed payment ever raises. */}
                    <td className="px-3 py-3 text-xs">
                      {c.allocations.length === 0 ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        c.allocations.map((a) => (
                          <div key={`${c.collectionId}-${a.chargeId}`}>
                            {a.referenceNo ?? a.chargeDate} — {peso(a.amountApplied)}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {c.status}
                      {c.status === 'posted' && (
                        <RowAction className="mt-1 flex">
                          <CheckedForm rules={COLLECTION_VOID_RULES} action={voidCollectionAction} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="customerId" value={customerId} />
                            <input type="hidden" name="storeId" value={storeId} />
                            <input type="hidden" name="collectionId" value={c.collectionId} />
                            <Field label={<span className="sr-only">Why is this collection being voided?</span>} rule={COLLECTION_VOID_RULES.reason}>
                              <Input
                                {...nativeAttrs(COLLECTION_VOID_RULES.reason)}
                                placeholder="why?"
                                className="w-28 text-xs"
                              />
                            </Field>
                            <ConfirmDestructive
                              tier="admin-pin"
                              label="Void collection"
                              consequence="Voids this collection and reverses its entry; the charges it settled open again. An administrator must approve with their own PIN."
                            />
                          </CheckedForm>
                        </RowAction>
                      )}
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing has been collected yet.</p>
        )}
      </section>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ⭐ Every figure on this page is a query over the ledger and the AR tables&rsquo; own CTEs.
        There is no stored balance to recompute, repair or reconcile &mdash; which is why the three
        buttons v1 needed for exactly that are not here.
      </p>
    </Page>
  );
}

function Field({
  label,
  hint,
  rule,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  rule?: FieldRule;
  className?: string;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
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

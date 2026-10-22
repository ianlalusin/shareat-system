import { FormDisclosure } from '@/components/forms/FormDisclosure';
import { CheckedForm } from '@/components/forms';
import { ITEMS_APPROVE_RULES, ITEMS_REJECT_RULES, ITEMS_REQUEST_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requireSession } from '../../lib/session';
import {
  approveItemRequestAction,
  createItemAction,
  dismissDuplicatePairAction,
  mergeItemsAction,
  rejectItemRequestAction,
  requestItemAction,
  suggestItemCodeAction,
  undoDuplicateDismissalAction,
} from './actions';
import { ItemCodeField } from './ItemCodeField';
import {
  dismissedPairs,
  duplicateCandidates,
  itemKindCounts,
  listItems,
  mayApproveItem,
  parseKindFilter,
  pendingRequestCodes,
  pendingRequests,
  soldAsLabel,
  variationParentOptions,
} from './lib';
import { arrangeFamilies } from './family';
import { BASE_UNITS, ITEM_KINDS, ITEM_KIND_LABEL, itemKindLabel } from '@shareat/db';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { Banner, Button, Checkbox, FlashBanner, Input, LinkRow, RowLink, Select, FormGrid, FormSection, Field, SplitWorkspace } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { DisclosureCard } from '@/components/ui/DisclosureCard';

export const metadata = { title: 'Items — Shareat System' };
export const dynamic = 'force-dynamic';

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; warning?: string; kind?: string }>;
}) {
  // T-443 R3: `kind` is not a flash key; read it from the raw params before `withFlash` consumes them.
  const rawParams = await searchParams;
  const kind = parseKindFilter(typeof rawParams.kind === 'string' ? rawParams.kind : undefined);
  const sp = await withFlash(Promise.resolve(rawParams));
  const { actor } = await requireSession(kind ? `/items?kind=${kind}` : '/items');
  const [items, requests, dupes, dismissed, kindCounts, parentOptions] = await Promise.all([
    listItems(actor.orgId, true, kind),
    pendingRequests(actor.orgId),
    duplicateCandidates(actor.orgId),
    dismissedPairs(actor.orgId),
    itemKindCounts(actor.orgId),
    variationParentOptions(actor.orgId),
  ]);
  const rows = arrangeFamilies(items);
  const totalItems = Object.values(kindCounts).reduce((a, b) => a + b, 0);
  // T-386 R10. Presentation aids only (the domain stays the enforcement): who gets the override inputs, and what each pending
  // request would be coded if approved right now (its stored code is only the requester's frozen preview).
  const [canOverride, willBe] = await Promise.all([mayApproveItem(actor), pendingRequestCodes(actor, requests)]);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Items</h1>
        <PageDescription>
          The shared item catalogue for every store. Request a new item here; a super-admin approves it. Open an item for its settings, suppliers and price history.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <SplitWorkspace
        balance="details"
        formTitle="Request or add an item"
        detailsTitle="Item catalogue"
        form={<>
      <DisclosureCard id="new-item" title="Request a new item" action="Add">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Choose the unit used to measure stock and compare prices. Boxes and packs use conversions on the invoice.
        </p>
            <CheckedForm rules={ITEMS_REQUEST_RULES} action={requestItemAction} className="erp-item-form space-y-3">
              <FormSection title="Identity">
                <FormGrid layout="fields" className="erp-item-identity">
                  <Field rule={ITEMS_REQUEST_RULES.name} width="name" label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name</span>} className="text-sm">
                    <Input {...nativeAttrs(ITEMS_REQUEST_RULES.name)} id="item-name"   placeholder="Pork belly" className="mt-1 block w-full" />
                  </Field>
                  <Field rule={ITEMS_REQUEST_RULES.kind} width="code" label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Kind</span>} className="text-sm">
                    <select {...nativeAttrs(ITEMS_REQUEST_RULES.kind)}   defaultValue="" className="mt-1 block w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink">
                      <option value="">Kind…</option>
                      {ITEM_KINDS.map((k) => (
                        <option key={k} value={k}>{ITEM_KIND_LABEL[k]}</option>
                      ))}
                    </select>
                  </Field>
                  <Field rule={ITEMS_REQUEST_RULES.baseUnit} width="short" label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Measured in</span>} className="text-sm">
                    <Select {...nativeAttrs(ITEMS_REQUEST_RULES.baseUnit)}   defaultValue="" className="mt-1 block w-full">
                      <option value="">Unit…</option>
                      {BASE_UNITS.map((u) => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </Select>
                  </Field>
                </FormGrid>
                <div className="mt-2">
                  <ItemCodeField nameInputId="item-name" mode="new" canOverride={false} suggestAction={suggestItemCodeAction} />
                </div>
              </FormSection>
              <FormSection title="Item family">
                <FormGrid layout="fields">
                  <Field width="long"
                    span="full"
                    label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Variation of <span className="italic">(optional — e.g. Kimchi 250g under Kimchi)</span></span>}
                    className="text-sm"
                  >
                    <Select name="variantOfItemId" defaultValue="" className="mt-1 block w-full">
                      <option value="">(none, a top-level item)</option>
                      {parentOptions.map((o) => (
                        <option key={o.id} value={o.id}>{o.name} ({o.code})</option>
                      ))}
                    </Select>
                  </Field>
                </FormGrid>
              </FormSection>
              <FormSection title="Request details">
                <FormGrid layout="fields">
                  <Field width="long"
                    span="full"
                    label={
                      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                        Why do we need it? <span className="italic">(optional — helps whoever approves)</span>
                      </span>
                    }
                    className="text-sm"
                  >
                    <Input name="reason" className="mt-1 block w-full" />
                  </Field>
                </FormGrid>
              </FormSection>
              {/*
            ⭐ DEF-130. T-149's three independent facts. Until 2026-09-03 the form never asked, both
            "sold" columns default to false, and every item made here was sold to nobody — which
            `createTradeOrder` then refused, correctly, on its own gate.
          */}
              <fieldset className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
                <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Buying and selling
                </legend>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <Checkbox name="isPurchasable" defaultChecked label="Buy" aria-label="Bought from suppliers" />
                  <Checkbox name="sellableRetail" label="Retail" aria-label="Sold à la carte (retail)" />
                  <Checkbox name="sellableWholesale" label="Wholesale" aria-label="Sold to other stores or buyers (wholesale)" />
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Buy = bought from suppliers. Retail = sold à la carte. Wholesale = sold to our branches, franchisees or outside buyers like Xlice. These are independent choices; a store can override them on the item&rsquo;s page.
                </p>
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary">Request item</Button>
                {/* T-386 R7: the override belongs to the direct add (a super-admin), not to the request fields. */}
                {canOverride && (
                  <Field label={<span className="text-xs text-neutral-500 dark:text-neutral-400">Use a different code (super-admin)</span>} rule={ITEMS_REQUEST_RULES.code} className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <Input {...nativeAttrs(ITEMS_REQUEST_RULES.code)}
                      pattern="[A-Za-z0-9]{4}-[0-9]{3}"

                      type="text"
                      autoComplete="off"

                      placeholder="CHWN-001"
                      className="font-mono"
                    />
                  </Field>
                )}
                <Button type="submit" variant="secondary" formAction={createItemAction}>
                  Add directly (super-admin)
                </Button>
              </div>
            </CheckedForm>
      </DisclosureCard>

        </>}
        details={<div className="min-w-0 space-y-4">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Catalogue</h2>
          <span className="text-xs text-muted">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
        </div>
        {/* T-443 R3: filter the table by kind (server-side; an unknown ?kind= shows all). */}
        <nav aria-label="Filter by kind" className="flex flex-wrap gap-2 text-sm">
          {[{ key: undefined, label: 'All', count: totalItems }, ...ITEM_KINDS.map((k) => ({ key: k as string | undefined, label: ITEM_KIND_LABEL[k], count: kindCounts[k] ?? 0 }))].map((c) => {
            const active = (kind ?? undefined) === c.key;
            return (
              <a
                key={c.key ?? 'all'}
                href={c.key ? `/items?kind=${c.key}` : '/items'}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'rounded-full border border-neutral-900 bg-neutral-900 px-3 py-1 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                    : 'rounded-full border border-neutral-300 px-3 py-1 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900'
                }
              >
                {c.label} · {c.count}
              </a>
            );
          })}
        </nav>
        {items.length > 0 ? (
          <div data-screen-scroll="catalogue" className="catalogue-table min-w-0 rounded-lg border border-surface-border bg-surface">
            <table data-card-title="Item" data-card-subtitle="Kind" data-card-keys="Priced per" className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th scope="col" className="px-3 py-2 font-medium">Item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Code</th>
                  <th scope="col" className="px-3 py-2 font-medium">Kind</th>
                  <th scope="col" className="px-3 py-2 font-medium">Priced per</th>
                  {/* ⭐ DEF-130. The org's default — a store may differ; see the item's page. */}
                  <th scope="col" className="px-3 py-2 font-medium">Sold as</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item: i, indented }) => (
                  <LinkRow key={i.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className={indented ? 'py-2 pl-8 pr-3' : 'px-3 py-2'}>
                      {indented && <span aria-hidden="true" className="mr-1 text-neutral-400">↳</span>}
                      <RowLink href={`/items/${i.id}`}>{i.name}</RowLink>
                      {i.status !== 'active' && (
                        <span className="ml-2 text-xs text-neutral-500">({i.status})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i.code}</td>
                    <td className="px-3 py-2">{itemKindLabel(i.kind)}</td>
                    <td className="px-3 py-2">{i.baseUnit}</td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{soldAsLabel(i)}</td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {kind
              ? 'No items of this kind.'
              : 'No items yet. Their price history builds itself from the invoices you record.'}
          </p>
        )}
      </section>


          {(dupes.length > 0 || dismissed.length > 0 || requests.length > 0) && (
            <details className="rounded-lg border border-surface-border bg-surface p-3">
              <summary className="cursor-pointer py-1 text-sm font-semibold">Review and approvals · {requests.length} waiting · {dupes.length} similar pairs</summary>
              <div className="mt-3 space-y-3">


      {dupes.length > 0 && (
        <section className="space-y-3 rounded-lg border border-warning-ink bg-warning-soft p-4">
          <h2 className="font-medium text-warning-ink">
            {dupes.length === 1 ? 'One pair looks' : `${dupes.length} pairs look`} like the same item
          </h2>
          <p className="text-xs text-warning-ink">
            Spelling-similarity check. ⚠️ It is a prompt, not a verdict — &ldquo;Coke 1.5&rdquo; and
            &ldquo;Coke 15&rdquo; look alike and are different products. Merging is permanent:
            every invoice line, price and supplier link moves to the item you keep.
          </p>
          <ul className="space-y-2">
            {dupes.map((d) => (
              <li
                key={`${d.aId}-${d.bId}`}
                className="rounded border border-warning-ink bg-surface p-3 text-sm"
              >
                <div className="mb-2">
                  <a href={`/items/${d.aId}`} className="underline hover:no-underline">{d.aName}</a>
                  <span className="text-neutral-500"> ({d.aUnit})</span>
                  <span className="mx-2 text-neutral-400">vs</span>
                  <a href={`/items/${d.bId}`} className="underline hover:no-underline">{d.bName}</a>
                  <span className="text-neutral-500"> ({d.bUnit})</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {Math.round(d.similarity * 100)}% alike
                  </span>
                </div>
                {d.unitsDiffer ? (
                  <p className="text-xs text-danger">
                    ⛔ Measured differently ({d.aUnit} vs {d.bUnit}). Merging is refused until one
                    of them is corrected — combining them would make every past price incomparable.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <form action={mergeItemsAction} className="flex items-center gap-2">
                      <input type="hidden" name="winnerId" value={d.aId} />
                      <input type="hidden" name="loserId" value={d.bId} />
                      <Button type="submit" variant="secondary">
                        Keep &ldquo;{d.aName}&rdquo;
                      </Button>
                    </form>
                    <form action={mergeItemsAction} className="flex items-center gap-2">
                      <input type="hidden" name="winnerId" value={d.bId} />
                      <input type="hidden" name="loserId" value={d.aId} />
                      <Button type="submit" variant="secondary">
                        Keep &ldquo;{d.bName}&rdquo;
                      </Button>
                    </form>
                  </div>
                )}
                {/* T-443 R2: a real pair (Samyang Cheese / Samyang 4 Cheese) is dismissed, not merged, and stops being suggested. */}
                <FormDisclosure called><form action={dismissDuplicatePairAction} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="itemAId" value={d.aId} />
                  <input type="hidden" name="itemBId" value={d.bId} />
                  <Input name="note" placeholder="Note (optional)" className="min-w-[10rem]" />
                  <Button type="submit" variant="ghost">
                    Different items — stop asking
                  </Button>
                </form></FormDisclosure>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dismissed.length > 0 && (
        <details className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <summary className="cursor-pointer py-0.5 font-medium">
            {dismissed.length === 1 ? '1 pair marked as different' : `${dismissed.length} pairs marked as different`}
          </summary>
          <ul className="mt-2 space-y-2">
            {dismissed.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <a href={`/items/${d.itemAId}`} className="inline-block py-0.5 underline hover:no-underline">{d.itemAName}</a>
                <span className="text-neutral-400">and</span>
                <a href={`/items/${d.itemBId}`} className="inline-block py-0.5 underline hover:no-underline">{d.itemBName}</a>
                {d.note ? <span className="text-xs text-neutral-500 dark:text-neutral-400">— {d.note}</span> : null}
                <form action={undoDuplicateDismissalAction}>
                  <input type="hidden" name="dismissalId" value={d.id} />
                  <Button type="submit" variant="ghost">Undo</Button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}

      {requests.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">
            {requests.length === 1 ? 'One item is' : `${requests.length} items are`} waiting for a
            super-admin
          </h2>
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="font-medium">{r.name}</div>
                {(() => {
                  const w = willBe.get(r.id);
                  if (!w || !w.stem) return null;
                  return (
                    <div className="text-xs text-neutral-600 dark:text-neutral-300">
                      {w.code ? (
                        <>Will be coded {w.code} on approval</>
                      ) : (
                        <>Every number under {w.stem} has been used (999 items); a super-admin must type a code.</>
                      )}
                      {w.sameStem.length > 0 && (
                        <span className="block text-warning-ink">
                          Same code letters as: {w.sameStem.map((s) => `${s.code} ${s.name} (${s.status})`).join(', ')}
                        </span>
                      )}
                    </div>
                  );
                })()}
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {itemKindLabel(r.kind)} · measured in {r.baseUnit} · {soldAsLabel(r)}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
                {r.similarWarning && (
                  <Banner tone="warning" className="mt-2">
                    ⚠️ {r.similarWarning}
                  </Banner>
                )}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <CheckedForm rules={ITEMS_APPROVE_RULES} action={approveItemRequestAction} className="flex flex-wrap items-end gap-2 gap-y-2" called>
                    <input type="hidden" name="requestId" value={r.id} />
                    {/* T-378 R5: the approver confirms the unit (pre-selected to the requester's choice) and the three ticks. */}
                    <Field label={<span className="text-xs text-neutral-500 dark:text-neutral-400">Measured in</span>} rule={ITEMS_APPROVE_RULES.baseUnit} className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                      <Select {...nativeAttrs(ITEMS_APPROVE_RULES.baseUnit)}   defaultValue={r.baseUnit}>
                        {BASE_UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </Select>
                    </Field>
                    {/* T-443 R1: the requester's "variation of", which the approver may change or clear. */}
                    <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                      Variation of
                      <Select name="variantOfItemId" defaultValue={r.variantOfItemId ?? ''}>
                        <option value="">(none, a top-level item)</option>
                        {parentOptions.map((o) => (
                          <option key={o.id} value={o.id}>{o.name} ({o.code})</option>
                        ))}
                      </Select>
                    </label>
                    {canOverride && (
                      <Field label={<span className="text-xs text-neutral-500 dark:text-neutral-400">Use a different code</span>} rule={ITEMS_APPROVE_RULES.code} className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                        <Input {...nativeAttrs(ITEMS_APPROVE_RULES.code)}
                          pattern="[A-Za-z0-9]{4}-[0-9]{3}"

                          autoComplete="off"

                          placeholder={willBe.get(r.id)?.code ?? 'CHWN-001'}
                          className="font-mono"
                        />
                      </Field>
                    )}
                    <Checkbox name="isPurchasable" defaultChecked={r.isPurchasable} label="Bought" />
                    <Checkbox name="sellableRetail" defaultChecked={r.sellableRetail} label="Sold à la carte" />
                    <Checkbox name="sellableWholesale" defaultChecked={r.sellableWholesale} label="Sold to other stores/buyers" />
                    <Button type="submit" variant="secondary">Approve</Button>
                  </CheckedForm>
                  <CheckedForm rules={ITEMS_REJECT_RULES} action={rejectItemRequestAction} className="flex flex-wrap items-end gap-2 gap-y-2" called>
                    <input type="hidden" name="requestId" value={r.id} />
                    <Field label={<span className="text-xs text-neutral-500 dark:text-neutral-400">Why not?</span>} rule={ITEMS_REJECT_RULES.note}><Input {...nativeAttrs(ITEMS_REJECT_RULES.note)}   placeholder="Why not?" /></Field>
                    <Button type="submit" variant="danger">
                      Reject
                    </Button>
                  </CheckedForm>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}


              </div>
            </details>
          )}
        </div>}
      />
    </Page>
  );
}

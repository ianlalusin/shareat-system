import { requireSession } from '../../lib/session';
import {
  approveItemRequestAction,
  createItemAction,
  mergeItemsAction,
  rejectItemRequestAction,
  requestItemAction,
  suggestItemCodeAction,
} from './actions';
import { ItemCodeField } from './ItemCodeField';
import { listItems, mayApproveItem, pendingRequestCodes, pendingRequests, duplicateCandidates, soldAsLabel } from './lib';
import { BASE_UNITS, ITEM_KINDS, ITEM_KIND_LABEL, itemKindLabel } from '@shareat/db';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { Banner, Button, Checkbox, FlashBanner, Input, LinkRow, RowLink, Select, FormGrid, Field } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Items — Shareat System' };
export const dynamic = 'force-dynamic';

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; warning?: string }>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/items');
  const [items, requests, dupes] = await Promise.all([
    listItems(actor.orgId),
    pendingRequests(actor.orgId),
    duplicateCandidates(actor.orgId),
  ]);
  // T-386 R10. Presentation aids only (the domain stays the enforcement): who gets the override inputs, and what each pending
  // request would be coded if approved right now (its stored code is only the requester's frozen preview).
  const [canOverride, willBe] = await Promise.all([mayApproveItem(actor), pendingRequestCodes(actor, requests)]);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Items</h1>
        <PageDescription>
          One identity per thing the business buys, for the whole organisation. ⭐ Only a
          <strong> super-admin</strong> can add one — everyone else requests it, because a duplicate
          is not a row you delete later, it is a price history split in two.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

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
              </li>
            ))}
          </ul>
        </section>
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
                  <form action={approveItemRequestAction} className="flex flex-wrap items-end gap-2 gap-y-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    {/* T-378 R5: the approver confirms the unit (pre-selected to the requester's choice) and the three ticks. */}
                    <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                      Measured in
                      <Select name="baseUnit" required defaultValue={r.baseUnit}>
                        {BASE_UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </Select>
                    </label>
                    {canOverride && (
                      <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                        Use a different code
                        <Input
                          name="code"
                          autoComplete="off"
                          pattern="[A-Za-z0-9]{4}-[0-9]{3}"
                          placeholder={willBe.get(r.id)?.code ?? 'CHWN-001'}
                          className="font-mono"
                        />
                      </label>
                    )}
                    <Checkbox name="isPurchasable" defaultChecked={r.isPurchasable} label="Bought" />
                    <Checkbox name="sellableRetail" defaultChecked={r.sellableRetail} label="Sold à la carte" />
                    <Checkbox name="sellableWholesale" defaultChecked={r.sellableWholesale} label="Sold wholesale" />
                    <Button type="submit" variant="secondary">Approve</Button>
                  </form>
                  <form action={rejectItemRequestAction} className="flex flex-wrap items-end gap-2 gap-y-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <Input name="note" required placeholder="Why not?" />
                    <Button type="submit" variant="danger">
                      Reject
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Priced per</th>
                  {/* ⭐ DEF-130. The org's default — a store may differ; see the item's page. */}
                  <th className="px-3 py-2 font-medium">Sold as</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <LinkRow key={i.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
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
            No items yet. Their price history builds itself from the invoices you record.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Request a new item</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A super-admin approves it, and then every store can use it. ⚠️ &ldquo;Measured in&rdquo;
          is the unit every price is compared in, so pick the one you actually measure by. A box is
          not a unit of measure — it belongs on the invoice line with its conversion.
        </p>
        <form action={requestItemAction} className="space-y-3">
          <FormGrid>
            <Field label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name</span>} className="text-sm">
              <Input id="item-name" name="name" required placeholder="Pork belly" className="mt-1 block w-full" />
            </Field>
            <ItemCodeField nameInputId="item-name" mode="new" canOverride={false} suggestAction={suggestItemCodeAction} />
            <Field label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Kind</span>} className="text-sm">
              <select name="kind" required defaultValue="" className="mt-1 block w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink">
                <option value="">Choose a kind</option>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>{ITEM_KIND_LABEL[k]}</option>
                ))}
              </select>
            </Field>
            <Field label={<span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Measured in</span>} className="text-sm">
              <Select name="baseUnit" required defaultValue="" className="mt-1 block w-full">
                <option value="">Choose a unit</option>
                {BASE_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </Select>
            </Field>
          <Field
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
          {/*
            ⭐ DEF-130. T-149's three independent facts. Until 2026-09-03 the form never asked, both
            "sold" columns default to false, and every item made here was sold to nobody — which
            `createTradeOrder` then refused, correctly, on its own gate.
          */}
          <fieldset className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              What it may be bought and sold as
            </legend>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <Checkbox name="isPurchasable" defaultChecked label="Bought from suppliers" />
              <Checkbox name="sellableRetail" label="Sold à la carte (retail)" />
              <Checkbox name="sellableWholesale" label="Sold wholesale / to franchisees" />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Three independent facts — Milkis is all three, a bento box is retail-only and made
              here, charcoal is bought and sold to nobody. These apply to a request too: the
              super-admin sees them when approving and can correct them. A store that differs from
              the organisation says so on the item&rsquo;s page.
            </p>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary">Request item</Button>
            {/* T-386 R7: the override belongs to the direct add (a super-admin), not to the request fields. */}
            {canOverride && (
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                Use a different code (super-admin)
                <Input
                  name="code"
                  type="text"
                  autoComplete="off"
                  pattern="[A-Za-z0-9]{4}-[0-9]{3}"
                  placeholder="CHWN-001"
                  className="font-mono"
                />
              </label>
            )}
            <Button type="submit" variant="secondary" formAction={createItemAction}>
              Add directly (super-admin)
            </Button>
          </div>
        </form>
      </section>
    </Page>
  );
}

import { commissaryCatalogueRepo } from '@shareat/db';
import { requireSession } from '../../../lib/session';
import { removeMapAction, upsertLinkAction, upsertMapAction, upsertOfferingAction } from './actions';
import {
  EXPENSE_GROUPS,
  catalogueData,
  listCategoriesGrouped,
  listStores,
  mapData,
  peso,
  withOrgPrincipal,
} from './lib';
import { selectDefaultCommissaryStoreId } from './default-store';
import { Page } from '@/components/shell/Page';
import { Button, ConfirmDestructive, Field, FlashBanner, FormGrid, FormModal, Input, LinkRow, RowLink, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { COMMISSARY_LINK_RULES, COMMISSARY_MAP_RULES, COMMISSARY_OFFERING_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Commissary catalogue — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  commissary?: string;
  branch?: string;
  error?: string;
  ok?: string;
}

export default async function CommissaryCataloguePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const session = await requireSession('/commissary/catalogue');
  const { actor } = session;
  const stores = await listStores(actor.orgId);

  // DEF-220: which stores ARE commissaries (hold at least one outgoing commissary_links row,
  // either status) — the property the default must respect, never a name, code or position.
  const allLinks = await withOrgPrincipal(actor.orgId, (tx) => commissaryCatalogueRepo.listLinks(tx, actor.orgId));
  const commissaryStoreIds = new Set(allLinks.map((l) => l.commissaryStoreId));

  const commissaryStoreId =
    sp.commissary && stores.some((s) => s.id === sp.commissary)
      ? sp.commissary
      : selectDefaultCommissaryStoreId(stores, commissaryStoreIds, session.storeId);

  if (!commissaryStoreId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Commissary catalogue</h1>
        <p className="mt-4 text-sm text-neutral-600">
          {stores.length === 0
            ? 'This organisation has no stores yet.'
            : 'No store is set up as a commissary yet. Link a branch to a commissary to get started.'}
        </p>
      </Page>
    );
  }

  const [{ links, offerings, purchasableItems }, categories] = await Promise.all([
    catalogueData(actor.orgId, commissaryStoreId),
    listCategoriesGrouped(actor.orgId),
  ]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const otherStores = stores.filter((s) => s.id !== commissaryStoreId);

  const branchStoreId =
    sp.branch && links.some((l) => l.branchStoreId === sp.branch) ? sp.branch : undefined;
  const mapSection = branchStoreId ? await mapData(actor.orgId, commissaryStoreId, branchStoreId) : undefined;

  return (
    <Page density="table" className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Commissary catalogue</h1>
        <PageDescription className="mt-1">
          What a commissary offers, which branches may buy from it, and which of a branch&rsquo;s own
          items each commissary line becomes. ⭐ <strong>A line with no map cannot be submitted, and
          a real internal receipt with no map throws</strong> — this screen is what makes both
          possible (DEF-129).
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Commissary</span>
          <Select name="commissary" defaultValue={commissaryStoreId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {/* ---- Links ---------------------------------------------------------------------- */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Branches linked to this commissary</h2>
          <FormModal trigger="+ Link branch" title="Link a branch to this commissary" size="md">
<CheckedForm
          rules={COMMISSARY_LINK_RULES}
          action={upsertLinkAction}
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="commissaryStoreId" value={commissaryStoreId} />
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Branch</span>} className="text-sm" rule={COMMISSARY_LINK_RULES.branchStoreId}>
            <Select {...nativeAttrs(COMMISSARY_LINK_RULES.branchStoreId)} defaultValue="">
              <option value="" disabled>
                Select a store
              </option>
              {otherStores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Status</span>
            <Select name="status" defaultValue="active">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </label>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </CheckedForm>
          </FormModal>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A branch may only order from a commissary it is linked to. Linking also creates the
          internal customer record a trade order needs to name the branch.
        </p>
        {links.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No branch is linked yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Branch</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Item map</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <LinkRow key={l.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      {l.branchName} <span className="ml-1 font-mono text-xs text-neutral-500">{l.branchCode}</span>
                    </td>
                    <td className="px-3 py-2">{l.status}</td>
                    <td className="px-3 py-2">
                      <RowLink href={`/commissary/catalogue?commissary=${commissaryStoreId}&branch=${l.branchStoreId}`}>
                        Map items →
                      </RowLink>
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}


      </section>

      {/* ---- Offerings ------------------------------------------------------------------ */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">What this commissary offers</h2>
          <FormModal trigger="+ Offer item" title="Offer an item from this commissary" size="md">
<CheckedForm
          rules={COMMISSARY_OFFERING_RULES}
          action={upsertOfferingAction}
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="commissaryStoreId" value={commissaryStoreId} />
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Item</span>} className="text-sm" rule={COMMISSARY_OFFERING_RULES.itemId}>
            <Select {...nativeAttrs(COMMISSARY_OFFERING_RULES.itemId)} defaultValue="">
              <option value="" disabled>
                Select an item
              </option>
              {purchasableItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.baseUnit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Manual cost (optional)</span>} className="text-sm" rule={COMMISSARY_OFFERING_RULES.manualCost}>
            <Input {...nativeAttrs(COMMISSARY_OFFERING_RULES.manualCost)} placeholder="tier 3 of the price fallback" className="w-full" />
          </Field>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </CheckedForm>
          </FormModal>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Only an active, purchasable item can be offered. The manual cost is the last-resort
          price — used only when the item has no branch-price rule and no purchase history.
        </p>
        {offerings.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No offerings yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 text-right font-medium">Manual cost</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {offerings.map((o) => (
                  <tr key={o.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      {o.itemName} <span className="ml-1 font-mono text-xs text-neutral-500">{o.itemCode}</span>
                    </td>
                    <td className="px-3 py-2">{o.baseUnit}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {o.manualCost ? peso(o.manualCost) : '—'}
                    </td>
                    <td className="px-3 py-2">{o.status}</td>
                    <td className="px-3 py-2 text-right">
                      <form action={upsertOfferingAction}>
                        <input type="hidden" name="commissaryStoreId" value={commissaryStoreId} />
                        <input type="hidden" name="itemId" value={o.itemId} />
                        <input type="hidden" name="manualCost" value={o.manualCost ?? ''} />
                        <input type="hidden" name="status" value={o.status === 'active' ? 'inactive' : 'active'} />
                        <Button type="submit" variant="ghost">
                          {o.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}


      </section>

      {/* ---- Item map --------------------------------------------------------------------- */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Item map</h2>
          {branchStoreId && mapSection ? (
          <FormModal trigger="+ Map item" title="Map a commissary item to a branch item" size="md">
<CheckedForm
              rules={COMMISSARY_MAP_RULES}
              action={upsertMapAction}
              className="space-y-3"
            >
              <input type="hidden" name="commissaryStoreId" value={commissaryStoreId} />
              <input type="hidden" name="branchStoreId" value={branchStoreId} />
              <FormGrid>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Commissary item</span>} className="min-w-0 text-sm" rule={COMMISSARY_MAP_RULES.commissaryItemId}>
                <Select {...nativeAttrs(COMMISSARY_MAP_RULES.commissaryItemId)} defaultValue="" className="w-full">
                  <option value="" disabled>
                    Select an offering
                  </option>
                  {mapSection.commissaryItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Branch item</span>} className="min-w-0 text-sm" rule={COMMISSARY_MAP_RULES.branchItemId}>
                <Select {...nativeAttrs(COMMISSARY_MAP_RULES.branchItemId)} defaultValue="" className="w-full">
                  <option value="" disabled>
                    Select an item
                  </option>
                  {mapSection.branchItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="isLedgerOnly" />
                Ledger only (no branch stock moves)
              </label>
              <label className="min-w-0 text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Expense category (optional)</span>
                <Select name="expenseCategoryId" defaultValue="" className="w-full">
                  <option value="">None</option>
                  {/* ⭐ T-229 slice 2 — active only: this mapping governs FUTURE receipts. */}
                  {EXPENSE_GROUPS.map((g) => {
                    const rows = categories.filter((c) => c.group === g && c.isActive);
                    if (rows.length === 0) return null;
                    return (
                      <optgroup key={g} label={g}>
                        {rows.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.category}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </Select>
              </label>
              </FormGrid>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </CheckedForm>
          </FormModal>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Which of the branch&rsquo;s own items a commissary line becomes. The two must share a base
          unit — nothing here guesses a conversion.
        </p>

        <FilterRow>
          <input type="hidden" name="commissary" value={commissaryStoreId} />
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Branch</span>
            <Select name="branch" defaultValue={branchStoreId ?? ''}>
              <option value="" disabled>
                Pick a linked branch
              </option>
              {links.map((l) => (
                <option key={l.branchStoreId} value={l.branchStoreId}>
                  {l.branchName}
                </option>
              ))}
            </Select>
          </label>
        </FilterRow>

        {!branchStoreId || !mapSection ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Pick a branch above to map its items.</p>
        ) : (
          <>
            {mapSection.map.length === 0 ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                No items mapped to {storeName.get(branchStoreId) ?? '—'} yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                      <th className="px-3 py-2 font-medium">Commissary item</th>
                      <th className="px-3 py-2 font-medium">Branch item</th>
                      <th className="px-3 py-2 font-medium">Ledger only</th>
                      <th className="px-3 py-2 font-medium">Expense category</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {mapSection.map.map((m) => (
                      <tr key={m.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                        <td className="px-3 py-2">
                          {m.commissaryItemName}{' '}
                          <span className="text-xs text-neutral-500">({m.commissaryItemUnit})</span>
                        </td>
                        <td className="px-3 py-2">
                          {m.branchItemName} <span className="text-xs text-neutral-500">({m.branchItemUnit})</span>
                        </td>
                        <td className="px-3 py-2">{m.isLedgerOnly ? 'Yes' : 'No'}</td>
                        <td className="px-3 py-2">
                          {m.expenseGroup
                            ? `${m.expenseGroup} — ${m.expenseCategory}`
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <form action={removeMapAction}>
                            <input type="hidden" name="id" value={m.id} />
                            <input type="hidden" name="commissaryStoreId" value={commissaryStoreId} />
                            <input type="hidden" name="branchStoreId" value={branchStoreId} />
                            <ConfirmDestructive
                              tier="retype"
                              label="Remove mapping"
                              consequence="Removes this item mapping."
                              expectedName={m.branchItemName}
                            />
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}


          </>
        )}
      </section>
    </Page>
  );
}

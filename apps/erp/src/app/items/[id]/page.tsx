import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import { authorize, AuthorizationError } from '@shareat/auth';
import { getItem, itemPrices, peso, retireReadout, sellabilityByStore, soldAsLabel, unitHistoryExists, withOrgPrincipal } from '../lib';
import { whoSells } from '../../ap/lib';
import {
  changeItemUnitAction,
  clearStoreSellabilityAction,
  renameItemAction,
  setItemStatusAction,
  setStoreSellabilityAction,
  suggestItemCodeAction,
  updateItemFlagsAction,
} from '../actions';
import { ItemCodeField } from '../ItemCodeField';
import { BASE_UNITS, itemKindLabel } from '@shareat/db';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { EditableRecord } from '@/components/forms';
import { Banner, Button, Checkbox, FlashBanner, Input, Select, FormGrid, Field } from '@/components/ui';

export const metadata = { title: 'Item — Shareat System' };
export const dynamic = 'force-dynamic';

/** ₱ per base unit, to 2dp for reading. The stored figure keeps 4 — a per-gram price needs them. */
/**
 * T-371 — a month's bar, as a share of the dearest price seen. Display only. No relational test on a figure read from a
 * string: a ratio that is not finite (a zero peak, or a price that does not read as a number) simply draws no bar.
 */
function barWidth(avgPrice: string, peak: number): string {
  const ratio = Number(avgPrice) / peak;
  return Number.isFinite(ratio) ? `${ratio * 100}%` : '0%';
}

function per(value: string): string {
  return peso(Number(value).toFixed(2));
}

/** Renders a tri-state override as its select value. `null` is "follow the org", never "no". */
function triValue(v: boolean | null | undefined): string {
  return v === true ? 'yes' : v === false ? 'no' : '';
}

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/items/${id}`);
  const item = await getItem(actor.orgId, id);
  if (!item) notFound();

  const [{ history, movement, bySupplier }, sellers, byStore, unitLocked] = await Promise.all([
    itemPrices(actor.orgId, id),
    whoSells(actor.orgId, id),
    sellabilityByStore(actor.orgId, id),
    unitHistoryExists(actor.orgId, id),
  ]);
  // T-378 S4 (DEF-600). Presentation aid only: the same gate the action uses, asked here so the form is drawn only for
  // who may use it. `changeItemBaseUnit` stays the enforcement. Pattern: channel-settlements/page.tsx.
  const mayApproveItem = await withOrgPrincipal(actor.orgId, async (tx) => {
    try {
      await authorize(tx, actor, 'approve_item', {});
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  });
  // T-383 R5/B2.4. Advisory readout for the Retire section: active or retired, never merged, and only for who may use it.
  const readout =
    mayApproveItem && (item.status === 'active' || item.status === 'inactive')
      ? await retireReadout(actor.orgId, id)
      : null;
  // A refusal must show where the user acted: the action returns to #retire, so the section repeats its own outcomes.
  const RETIRE_OUTCOMES = [
    'Only a super-admin can rename, retire or restore an item.',
    'This item was merged into another, so it cannot be retired or restored.',
    'Choose Retire or Restore, then try again.',
  ];
  const retireFlash = sp.error && RETIRE_OUTCOMES.includes(sp.error) ? sp.error : null;
  const peak = movement.reduce((m, r) => Math.max(m, Number(r.maxPrice)), 0);

  const FLAGS = [
    { key: 'isPurchasable', label: 'Bought from suppliers', org: item.isPurchasable },
    { key: 'sellableRetail', label: 'Sold à la carte', org: item.sellableRetail },
    { key: 'sellableWholesale', label: 'Sold wholesale', org: item.sellableWholesale },
  ] as const;

  return (
    <Page density="table">
      <div>
        <a href="/items" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Items
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{item.name}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          <span className="font-mono text-xs">{item.code}</span> · {itemKindLabel(item.kind)} ·
          priced per {item.baseUnit} · {soldAsLabel(item)}
        </p>
      </div>

      <FlashBanner flash={sp} />

      {/* T-383 R6. Rename: name and code, super-admin only; the domain (`renameItem`) is the enforcement. */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Name and code</h2>
        {mayApproveItem ? (
          <EditableRecord action={renameItemAction} label={item.name} hidden={{ itemId: item.id }}>
            <FormGrid>
              <Field label="Name">
                <Input id="rename-name" name="name" type="text" required defaultValue={item.name} className="w-full" />
              </Field>
              <Field label="Code">
                <Input name="code" type="text" required defaultValue={item.code} className="w-full" />
              </Field>
              {/* T-386 R10 (q4): the code stays on rename; the tick offers the new suggestion. */}
              <ItemCodeField
                nameInputId="rename-name"
                mode="rename"
                canOverride
                currentCode={item.code}
                itemId={item.id}
                suggestAction={suggestItemCodeAction}
              />
            </FormGrid>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Past records keep pointing at this item and show its new name. To replace an item measured in the wrong
              unit: rename this one (for example add &quot;(old)&quot;), add the replacement with the old name, then
              retire this one.
            </p>
          </EditableRecord>
        ) : (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Only a super-admin can rename, retire or restore an item.
          </p>
        )}
      </section>

      {/* T-378 R2/R4. The form shows only while the database says the item has no history; the trigger is the rule. */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Measured in</h2>
        {unitLocked ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {"This item's unit can no longer change: it already has stock, counts, invoices, recipes, prices or orders recorded in its current unit, and changing it would re-read every one of them in the new unit."}{' '}
            It is measured in {item.baseUnit}.
          </p>
        ) : !mayApproveItem ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Only a super-admin can change an item&apos;s unit. It is measured in {item.baseUnit}.
          </p>
        ) : (
          <EditableRecord action={changeItemUnitAction} label={`${item.name} unit`} hidden={{ itemId: item.id }}>
            <FormGrid>
              <Field label="Unit">
                <Select name="baseUnit" required defaultValue={item.baseUnit} className="w-full">
                  {BASE_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </Select>
              </Field>
            </FormGrid>
            <p className="mt-3 w-full text-xs text-neutral-500 dark:text-neutral-400">
              Only a super-admin can change it, and only until the item has stock, counts, invoices,
              recipes, prices or orders.
            </p>
          </EditableRecord>
        )}
      </section>

      {/*
        ⭐ DEF-130 / T-149. Three independent facts, and TWO layers: the organisation's answer,
        then the store that differs. Bulgogi sauce is one item — one identity, one price history —
        but Lipa MAKES it and sells it wholesale while another branch buys it in. The override
        table holds only the exceptions, so a store that agrees with the org has no row at all.
      */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">What it may be bought and sold as</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The organisation&rsquo;s answer first. A wholesale order is refused for an item the{' '}
            <strong>selling store</strong> does not sell wholesale, and a supplier invoice is refused
            for one the store makes rather than buys — so an item nobody has flagged can be
            neither sold nor bought.
          </p>
        </div>

        <EditableRecord action={updateItemFlagsAction} label={`${item.name} organisation default`} hidden={{ itemId: item.id }}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {FLAGS.map((f) => (
              <Checkbox key={f.key} name={f.key} defaultChecked={f.org} label={f.label} />
            ))}
          </div>
        </EditableRecord>

        {byStore.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Where a store differs</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              ⚠️ &ldquo;Follow the organisation&rdquo; is not the same as &ldquo;no&rdquo; — it keeps
              tracking the default above when that changes; a store that says &ldquo;no&rdquo;
              freezes its own answer.
            </p>
            <ul className="space-y-2">
              {byStore.map((s) => (
                <li
                  key={s.storeId}
                  className="space-y-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                >
                  {/*
                    ⚠️ Save and Clear are TWO forms, side by side, not one form with a
                    `formAction` button. A click that lands before React hydrates submits the
                    form natively, and a native submit ignores a server-action `formAction` —
                    "Clear" then SAVED the override instead. Two plain forms behave the same
                    with or without JS.
                  */}
                  {s.override ? (
                  <EditableRecord
                      action={setStoreSellabilityAction}
                      label={`${s.storeName} sellability`}
                      hidden={{ itemId: item.id, storeId: s.storeId }}
                      extra={
                        s.override ? (
                          <form action={clearStoreSellabilityAction}>
                            <input type="hidden" name="itemId" value={item.id} />
                            <input type="hidden" name="storeId" value={s.storeId} />
                            <Button type="submit" variant="ghost">
                              Clear
                            </Button>
                          </form>
                        ) : null
                      }
                    >
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-[8rem]">
                          <div className="font-medium">{s.storeName}</div>
                          <div className="text-xs text-neutral-500 dark:text-neutral-400">
                            {s.override ? 'has its own answer' : 'follows the organisation'}
                            {' · here: '}
                            {soldAsLabel(s.resolved)}
                          </div>
                        </div>
                        {FLAGS.map((f) => (
                          <label key={f.key} className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                            {f.label}
                            <Select name={f.key} defaultValue={triValue(s.override?.[f.key])}>
                              <option value="">Follow the organisation ({f.org ? 'yes' : 'no'})</option>
                              <option value="yes">Yes, here</option>
                              <option value="no">No, here</option>
                            </Select>
                          </label>
                        ))}
                        <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                          Why
                          <Input
                            name="note"
                            defaultValue={s.override?.note ?? ''}
                            placeholder="made in-house here"
                            className="w-full min-w-[10rem]"
                          />
                        </label>
                      </div>
                    </EditableRecord>
                  ) : (
                  <form action={setStoreSellabilityAction}>
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="storeId" value={s.storeId} />
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-[8rem]">
                        <div className="font-medium">{s.storeName}</div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                          {'follows the organisation'}
                          {' · here: '}
                          {soldAsLabel(s.resolved)}
                        </div>
                      </div>
                      {FLAGS.map((f) => (
                        <label key={f.key} className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                          {f.label}
                          <Select name={f.key} defaultValue={triValue(undefined)}>
                            <option value="">Follow the organisation ({f.org ? 'yes' : 'no'})</option>
                            <option value="yes">Yes, here</option>
                            <option value="no">No, here</option>
                          </Select>
                        </label>
                      ))}
                      <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                        Why
                        <Input
                          name="note"
                          defaultValue=""
                          placeholder="made in-house here"
                          className="w-full min-w-[10rem]"
                        />
                      </label>
                    </div>
                    <Button type="submit" variant="secondary" className="mt-3">
                      Save
                    </Button>
                  </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {sellers.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Who sells this</h2>
          {sellers.length === 1 && (
            <p className="text-xs text-warning-ink">
              ⚠️ Only one supplier &mdash; a single point of supply for this item.
            </p>
          )}
          <ul className="flex flex-wrap gap-2 text-sm">
            {sellers.map((s) => (
              <li
                key={s.supplierId}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
              >
                <a href={`/ap/suppliers/${s.supplierId}`} className="underline hover:no-underline">
                  {s.supplierName}
                </a>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {s.source === 'observed'
                    ? `billed ${s.timesBilled}× since ${s.firstSeenOn}`
                    : 'declared — never billed'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* T-383 R6/B2.4. Retire or restore: super-admin only, never for a merged item. The domain (`setItemStatus`) is the enforcement. */}
      {mayApproveItem && readout && (
        <section id="retire" className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Retire or restore</h2>
          {retireFlash && (
            <Banner tone="error">{retireFlash}</Banner>
          )}
          {item.status === 'inactive' && <p className="text-sm font-medium">Retired.</p>}
          {readout.onHand.length > 0 && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {`Still holds stock at: ${readout.onHand.map((r) => `${r.storeName} (${r.quantity} ${item.baseUnit})`).join(', ')}. ${
                item.status === 'inactive'
                  ? 'It can still be used, wasted, moved and counted until it runs out.'
                  : 'It stays on count sheets until counted out.'
              }`}
            </p>
          )}
          {readout.activePosMaps > 0 && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {`${readout.activePosMaps} live POS ${readout.activePosMaps === 1 ? 'map' : 'maps'} still use it. Point them at the replacement; sales keep using up this item until its stock runs out.`}
            </p>
          )}
          {readout.activeRecipes > 0 && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {`${readout.activeRecipes} live ${readout.activeRecipes === 1 ? 'recipe' : 'recipes'} still use it.`}
            </p>
          )}
          {item.status === 'active' ? (
            <form action={setItemStatusAction} className="space-y-2">
              <input type="hidden" name="itemId" value={item.id} />
              <input type="hidden" name="status" value="inactive" />
              <Button type="submit" variant="danger">Retire</Button>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Retiring keeps every record. It can no longer be ordered, received, priced, mapped to a POS item or put on a new recipe. Stock already on hand can still be used, wasted, moved and counted until it runs out. You can restore it.
              </p>
            </form>
          ) : (
            <form action={setItemStatusAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <input type="hidden" name="status" value="active" />
              <Button type="submit" variant="secondary">Restore</Button>
            </form>
          )}
        </section>
      )}

      {history.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          No prices yet. Record a supplier invoice with this item on a line, and its history starts
          here — nothing is typed in twice.
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Price by month</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              The average is <strong>weighted</strong> — total spent ÷ total {item.baseUnit} — never
              an average of averages. Buying 100{item.baseUnit} cheap and 1{item.baseUnit} dear is
              not a mid-price month.
            </p>
            <div className="space-y-1">
              {movement.map((m) => (
                <div key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 font-mono text-xs">{m.month}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-900">
                    <div
                      className="h-full rounded bg-neutral-800 dark:bg-neutral-200"
                      style={{ width: barWidth(m.avgPrice, peak) }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right font-mono tabular-nums">
                    {per(m.avgPrice)}
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-neutral-500 dark:text-neutral-400">
                    {per(m.minPrice)}–{per(m.maxPrice)} ({m.observations})
                  </span>
                </div>
              ))}
            </div>
          </section>

          {bySupplier.length > 1 && (
            <section className="space-y-2">
              <h2 className="font-medium">By supplier — cheapest first</h2>
              <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                      <th className="px-3 py-2 font-medium">Supplier</th>
                      <th className="px-3 py-2 text-right font-medium">Average</th>
                      <th className="px-3 py-2 text-right font-medium">Last</th>
                      <th className="px-3 py-2 text-right font-medium">Times bought</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySupplier.map((s) => (
                      <tr key={s.supplierId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                        <td className="px-3 py-2">{s.supplierName}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{per(s.avgPrice)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {per(s.lastPrice)}
                          <span className="ml-2 text-xs text-neutral-500">{s.lastDate}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{s.observations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Every price paid</h2>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Supplier</th>
                    <th className="px-3 py-2 font-medium">Billed as</th>
                    <th className="px-3 py-2 text-right font-medium">Per {item.baseUnit}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.invoiceId + h.invoiceDate} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      <td className="px-3 py-2">{h.invoiceDate}</td>
                      <td className="px-3 py-2">{h.supplierName}</td>
                      <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                        {h.quantity} {h.purchaseUnit} @ {per(h.unitPrice)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{per(h.basePrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Page>
  );
}

import { notFound } from 'next/navigation';
import { ASSET_CATEGORIES } from '@shareat/db';
import { formatMoney, money, subtract } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { buildSchedule } from '@shareat/domain';
import { requirePageAccess } from '../../../lib/page-access';
import { disposeAssetAction, setAssetInServiceAction, updateTermsAction } from '../actions';
import { CATEGORY_LABEL, INTERVAL_LABEL, getAsset, listStores } from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { CheckedForm, EditableRecord, FieldCheck } from '@/components/forms';
import {
  ASSET_DISPOSE_RULES,
  ASSET_IN_SERVICE_CONFIRM_RULES,
  ASSET_IN_SERVICE_RULES,
  ASSET_TERMS_RULES,
  nativeAttrs,
  type FieldRule,
} from '@shareat/domain/field-rules';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, Button, ConfirmDestructive, FlashBanner, Input, Select, Textarea } from '@/components/ui';
import { typedFor } from '@/lib/keep-typing';
import { ASSET_IN_SERVICE_EDIT, ASSET_TERMS_EDIT } from '../typed-forms';

export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
  /** Set by `setAssetInServiceAction` when a reversal needs confirming — its own refusal text. */
  confirm?: string;
  plan?: string;
  mode?: string;
  inServiceOn?: string;
  reason?: string;
}

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/fixed-assets/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const found = await getAsset(actor.orgId, id);
  if (!found) notFound();
  const { asset, accumulated, periods } = found;

  const stores = await listStores(actor.orgId);
  const store = stores.find((s) => s.id === asset.storeId);
  const carry = new URLSearchParams();
  if (sp.store) carry.set('store', sp.store);

  const cost = money(asset.cost ?? '0');
  const bookValue = subtract(cost, money(accumulated));
  const isActive = asset.status === 'active';
  const isHeld = isActive && asset.inServiceOn === null;

  // The full schedule, so the screen can show what is still owed rather than only what has been
  // charged. Pure — no database, and it is the SAME function the posting uses, so what is shown
  // here and what will be posted cannot disagree.
  // ⭐ T-346 S2 (DEF-427) — starts from `in_service_on`, not `acquired_on`. A HELD asset
  // (`in_service_on IS NULL`) has no schedule at all: it depreciates nothing until it is.
  const schedule =
    asset.inServiceOn && asset.cost
      ? buildSchedule({
          startsOn: asset.inServiceOn,
          cost,
          salvageValue: money(asset.salvageValue ?? '0'),
          usefulLifeMonths: asset.usefulLifeMonths,
          interval: asset.interval,
        })
      : [];
  const postedSet = new Set(periods);

  return (
    <Page view="detail" density="table">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a href={`/fixed-assets?${carry.toString()}`} className="text-sm underline hover:no-underline">
            ← Fixed assets
          </a>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {asset.name}
            <Badge status={asset.status} />
            {asset.needsReview && (
              <Badge
                tone="warning"
                label="Needs review"
              />
            )}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {CATEGORY_LABEL[asset.category] ?? asset.category} · {store?.name ?? '—'} · acquired{' '}
            {asset.acquiredOn ?? '—'}
          </p>
        </div>
      </div>

      <FlashBanner flash={sp} />

      {asset.needsReview && (
        <Banner tone="warning">
          <strong className="font-medium">These terms are a default, not a decision.</strong> This
          asset was capitalised automatically from an expense, so its life and salvage were applied
          from policy without anyone looking at the thing itself. Editing them below confirms them
          and clears this flag.
        </Banner>
      )}

      <DetailLayout
        summary={
          /* ⭐ Three figures, and only ONE of them is stored. */
          /* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these tiles stay
             three-across inside a 320px rail. T-240 §3.5. */
          <section className="grid gap-4 sm:grid-cols-3 min-[1440px]:grid-cols-1">
            <Figure label="Cost" value={formatMoney(cost)} note="Stored on the asset" />
            <Figure
              label="Accumulated depreciation"
              value={formatMoney(money(accumulated))}
              note="⭐ Derived — summed from the ledger, never stored"
            />
            <Figure
              label="Book value"
              value={formatMoney(bookValue)}
              note="⭐ Derived — cost less accumulated"
            />
          </section>
        }
      >
      {/*
        ⚠️ `min-[1440px]:grid-cols-1` HERE TOO, and this one is not in the summary — it is the same
        viewport-vs-container trap one level further in, and it is the only page of the six that has
        it. The rail takes 344px off the record column, so at 1440 these two columns are 376px each,
        their sections 344px inside, and the `sm:grid-cols-2` field pairs below fall to **164px** —
        readable in a screenshot only. Dropping back to one column at exactly the width the rail
        appears puts them back at ~372px. Amendment to T-240 §3.5, reported not silently made.
      */}
      {/* ⭐ T-346 S2 (DEF-427), §3.4/§3.6. HELD means on the books at cost, depreciating nothing,
          until the store opens or someone sets a date directly — not an error state. */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">In service</h2>
        {isHeld ? (
          <p className="text-sm text-warning-ink">
            <strong className="font-medium">Not yet in service.</strong> This asset is on the
            books at cost and depreciates nothing until its store opens, or a date is set below.
          </p>
        ) : (
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            In service since <strong>{asset.inServiceOn ?? '—'}</strong>
            {asset.inServiceSource === 'store_opening' && " — follows this store's opening date"}
            {asset.inServiceSource === 'acquired' && ' — the acquisition date'}
            {asset.inServiceSource === 'set' && ' — set directly'}
            .
          </p>
        )}

        {isActive && (
          <>
            {sp.confirm && (
              <Banner tone="warning">{sp.confirm}</Banner>
            )}
            {sp.confirm && sp.reason === undefined && (
              <p className="text-xs text-neutral-500">
                What you typed could not be carried over. Enter the choice, date and reason again before you confirm.
              </p>
            )}
            {sp.confirm && (
              <CheckedForm rules={ASSET_IN_SERVICE_CONFIRM_RULES} action={setAssetInServiceAction} className="space-y-3">
                <input type="hidden" name="assetId" value={asset.id} />
                <input type="hidden" name="filterStore" value={sp.store ?? ''} />
                <input type="hidden" name="mode" value={sp.mode ?? asset.inServiceSource ?? 'acquired'} />
                <input type="hidden" name="inServiceOn" value={sp.inServiceOn ?? asset.inServiceOn ?? ''} />
                {sp.reason !== undefined ? (
                  <input type="hidden" name="reason" value={sp.reason} />
                ) : (
                  <Field label="Reason" hint="Required — an audit trail with no reason is unauditable" rule={ASSET_IN_SERVICE_CONFIRM_RULES.reason}>
                    <Input {...nativeAttrs(ASSET_IN_SERVICE_CONFIRM_RULES.reason)} className="w-full" />
                  </Field>
                )}
                <input type="hidden" name="confirmedPlan" value={sp.plan ?? ''} />
                <Button type="submit" variant="primary">
                  Confirm change
                </Button>
              </CheckedForm>
            )}
            <EditableRecord
              action={setAssetInServiceAction}
              label={`${asset.name} in-service date`}
              hidden={{ assetId: asset.id, filterStore: sp.store ?? '' }}
              typed={typedFor(sp, ASSET_IN_SERVICE_EDIT, asset.id, actor.personId)}
              rules={ASSET_IN_SERVICE_RULES}
            >
              <div className="space-y-3">
              {/* ⛔ A `<select>`, not radios — a native radio's box is unresolvable-by-construction
                  for the touch-target sweep (Ian's ruling §6.1, T-262); a `<select>` sizes from its
                  own classes exactly like this file's other pickers. */}
              <Field label="Choice">
                <Select
                  name="mode"
                  defaultValue={sp.mode ?? asset.inServiceSource ?? 'acquired'}
                  className="w-full"
                >
                  <option value="acquired">On the acquisition date ({asset.acquiredOn ?? '—'})</option>
                  <option value="store_opening">When the store opens</option>
                  <option value="set">A specific date —</option>
                </Select>
              </Field>
              <Field label="Specific date" hint="Only used when 'A specific date' is chosen above" rule={ASSET_IN_SERVICE_RULES.inServiceOn}>
                <Input
                  type="date"
                  {...nativeAttrs(ASSET_IN_SERVICE_RULES.inServiceOn)}
                  defaultValue={sp.inServiceOn ?? asset.inServiceOn ?? ''}
                  className="w-full"
                />
              </Field>
              <Field label="Reason" hint="Required — an audit trail with no reason is unauditable" rule={ASSET_IN_SERVICE_RULES.reason}>
                <Input {...nativeAttrs(ASSET_IN_SERVICE_RULES.reason)} defaultValue={sp.reason ?? ''} className="w-full" />
              </Field>
              {/* ⛔ A hidden input, not a checkbox — clicking "Confirm change" IS the confirmation
                  (same one-button shape as the dispose form below); a checkbox here would be a
                  second, redundant gesture, and its native box is unresolvable-by-construction for
                  the touch-target sweep the same way the radios above were. */}
              </div>
            </EditableRecord>
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2 min-[1440px]:grid-cols-1">
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Depreciation terms</h2>
          {isActive ? (
            <EditableRecord
              action={updateTermsAction}
              label={asset.name}
              hidden={{ assetId: asset.id, filterStore: sp.store ?? '' }}
              typed={typedFor(sp, ASSET_TERMS_EDIT, asset.id, actor.personId)}
              rules={ASSET_TERMS_RULES}
            >
              <div className="space-y-4">
              <Field label="Name" rule={ASSET_TERMS_RULES.name}>
                <Input {...nativeAttrs(ASSET_TERMS_RULES.name)} defaultValue={asset.name} className="w-full" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Category">
                  <Select name="category" defaultValue={asset.category} className="w-full">
                    {ASSET_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c] ?? c}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Useful life (months)" rule={ASSET_TERMS_RULES.usefulLifeMonths}>
                  <input
                    {...nativeAttrs(ASSET_TERMS_RULES.usefulLifeMonths)}
                    defaultValue={asset.usefulLifeMonths}
                    className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
                  />
                </Field>
                <Field label="Interval">
                  <Select name="interval" defaultValue={asset.interval} className="w-full">
                    {(['monthly', 'quarterly', 'semiannual', 'annually'] as const).map((i) => (
                      <option key={i} value={i}>
                        {INTERVAL_LABEL[i]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Salvage value" rule={ASSET_TERMS_RULES.salvageValue}>
                  <Input
                    {...nativeAttrs(ASSET_TERMS_RULES.salvageValue)}
                    defaultValue={asset.salvageValue ?? ''}
                    className="w-full"
                  />
                </Field>
              </div>
              <Field label="Notes">
                <Textarea name="notes" rows={2} defaultValue={asset.notes ?? ''} className="w-full" />
              </Field>
              {/* ⚠️ Changing a life does NOT rewrite what has already posted. Past periods are
                  history; the remaining ones re-derive from the new terms. */}
              <p className="text-xs text-neutral-400 dark:text-neutral-600">
                Changing the life or interval affects periods not yet posted. Entries already
                posted are history and are not rewritten.
              </p>
              </div>
            </EditableRecord>
          ) : (
            <dl className="space-y-2 text-sm">
              <Row k="Life" v={`${asset.usefulLifeMonths} months`} />
              <Row k="Interval" v={INTERVAL_LABEL[asset.interval] ?? asset.interval} />
              <Row k="Salvage" v={formatMoney(money(asset.salvageValue ?? '0'))} />
              <Row k="Disposed on" v={asset.disposedOn ?? '—'} />
              <Row k="Reason" v={asset.disposalReason ?? '—'} />
              {asset.notes && <Row k="Notes" v={asset.notes} />}
            </dl>
          )}
        </section>

        <section className="space-y-4">
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-3 font-medium">Schedule</h2>
            {schedule.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {isHeld
                  ? 'Not yet in service — nothing to schedule yet.'
                  : 'No schedule — this asset has no cost or in-service date yet.'}
              </p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
                      <th className="px-2 py-1.5 font-medium">Period</th>
                      <th className="px-2 py-1.5 text-right font-medium">Charge</th>
                      <th className="px-2 py-1.5 font-medium">Posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((p) => (
                      <tr
                        key={p.period}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                      >
                        <td className="px-2 py-1.5 font-mono text-xs">{p.period}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatMoney(p.amount)}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {postedSet.has(p.period) ? (
                            <span className="text-success">Posted</span>
                          ) : (
                            <span className="text-neutral-400 dark:text-neutral-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {isActive && (
            <section className="space-y-3 rounded-lg border border-danger p-4">
              <h2 className="font-medium text-danger">Dispose / write off</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Clears the accumulated depreciation, removes the cost, and writes the remaining{' '}
                <strong>{formatMoney(bookValue)}</strong> off to loss on disposal. This is a
                write-off at zero proceeds — there is no sale-with-proceeds flow.
              </p>
              <CheckedForm rules={ASSET_DISPOSE_RULES} action={disposeAssetAction} className="space-y-3">
                <input type="hidden" name="assetId" value={asset.id} />
                <input type="hidden" name="filterStore" value={sp.store ?? ''} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Disposed on" rule={ASSET_DISPOSE_RULES.disposedOn}>
                    <Input
                      type="date"
                      {...nativeAttrs(ASSET_DISPOSE_RULES.disposedOn)}
                      defaultValue={toBusinessDate()}
                      className="w-full"
                    />
                  </Field>
                  <Field label="Reason" hint="Required — a write-off with no reason is unauditable" rule={ASSET_DISPOSE_RULES.reason}>
                    <Input {...nativeAttrs(ASSET_DISPOSE_RULES.reason)} placeholder="Compressor failed" className="w-full" />
                  </Field>
                </div>
                <ConfirmDestructive
                  tier="admin-pin"
                  label="Dispose this asset"
                  consequence="Disposes of this asset and posts the disposal. An administrator must approve with their own PIN."
                />
              </CheckedForm>
            </section>
          )}
        </section>
      </div>
      </DetailLayout>
    </Page>
  );
}

function Field({ label, hint, rule, children }: { label: string; hint?: string; rule?: FieldRule; children: React.ReactNode }) {
  const body = (
    <>      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    
    </>
  );
  // T-440: a ruled field keeps its label and puts the live helper line OUTSIDE it (never part of the accessible name).
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-neutral-400 dark:text-neutral-600">{note}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}

import { ASSET_CATEGORIES } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { createAssetAction } from '../actions';
import { CATEGORY_LABEL, INTERVAL_LABEL, listActiveStores, readPolicyForDisplay } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Add asset — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function NewAssetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/fixed-assets/new');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const stores = await listActiveStores(actor.orgId);
  const policy = await readPolicyForDisplay(actor.orgId);
  const today = toBusinessDate();

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Add asset</h1>
        <PageDescription>
          Adding it here records what the business owns.{' '}
          <strong>It does not post the purchase</strong> — an asset bought through an expense is
          already in 1510. Use this for something being brought onto the register directly.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <form action={createAssetAction} className="space-y-6">
        <input type="hidden" name="filterStore" value={sp.store ?? ''} />

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
            What it is
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What somebody would call it when pointing at it">
              <input
                name="name"
                required
                maxLength={200}
                placeholder="Chest freezer — kitchen"
                className={INPUT}
              />
            </Field>
            <Field label="Store">
              <select name="storeId" required defaultValue={sp.store ?? ''} className={INPUT}>
                <option value="">Choose a store…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category">
              <select name="category" required defaultValue="equipment" className={INPUT}>
                {ASSET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Acquired on">
              <input type="date" name="acquiredOn" required max={today} defaultValue={today} className={INPUT} />
            </Field>
          </div>
        </section>

        {/* ⭐ T-346 S2 (DEF-427), §3.6 / Amendment R4.6. An asset depreciates from the day it is IN
            SERVICE, not from acquisition — a store not yet open means the physical thing sits on
            the books at cost, depreciating nothing, until it opens. The default sends NO source at
            all: migration 0163's own fill trigger decides, at insert time, between 'store_opening'
            (store has no opening date yet, or opens after this acquisition) and 'acquired' (store
            already trading) — exactly what the label says, in one sentence, without this form ever
            re-deriving that rule itself. The other two are deliberate overrides.
            ⛔ A `<select>`, not radios — same reason the delivery/receiving screens picked one:
            a native radio/checkbox box is unresolvable-by-construction for the touch-target sweep
            (Ian's ruling §6.1, T-262), while a `<select>` sizes from its own classes exactly like
            this file's other pickers. */}
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
            When it goes into service
          </h2>
          <Field label="Choice">
            <select name="inServiceMode" defaultValue="" className={INPUT}>
              <option value="">When the store opens (or on the acquisition date if it already has)</option>
              <option value="acquired">On the acquisition date — even if the store has not opened yet</option>
              <option value="set">A specific date —</option>
            </select>
          </Field>
          <Field label="Specific date" hint="Only used when 'A specific date' is chosen above">
            <input type="date" name="inServiceOn" className={`${INPUT} max-w-xs`} />
          </Field>
        </section>

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
            What it costs, and how long it lasts
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cost">
              <input name="cost" required inputMode="decimal" placeholder="0.00" className={INPUT} />
            </Field>
            <Field
              label="Salvage value"
              hint={`Blank uses the policy default (${
                policy ? formatMoney(money(policy.defaultSalvageValue)) : '₱0.00'
              }). Must be below cost.`}
            >
              <input name="salvageValue" inputMode="decimal" placeholder="0.00" className={INPUT} />
            </Field>
            {/* ⭐ MONTHS, and the field says so. v1 asked for months too, then divided by 12 to
                store years — so a 30-month life became 2.5 and carried a rounding nobody saw.
                Bible row 140 removed the conversion rather than refining it. */}
            <Field
              label="Useful life (months)"
              hint="Blank uses this category's default, then 24 months. How long until you would realistically REPLACE it — not how long it could last."
            >
              <input
                name="usefulLifeMonths"
                inputMode="numeric"
                placeholder="24"
                className={INPUT}
              />
            </Field>
            <Field label="Depreciation interval" hint="How often it charges. Set once, here.">
              <select name="interval" defaultValue="monthly" className={INPUT}>
                {(['monthly', 'quarterly', 'semiannual', 'annually'] as const).map((i) => (
                  <option key={i} value={i}>
                    {INTERVAL_LABEL[i]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes" hint="Why this life? A year from now this is what a reviewer wants.">
            <textarea name="notes" rows={2} className={INPUT} />
          </Field>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Add asset
          </button>
          <a
            href={`/fixed-assets?${sp.store ? `store=${sp.store}` : ''}`}
            className="text-sm underline hover:no-underline"
          >
            Cancel
          </a>
        </div>
      </form>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

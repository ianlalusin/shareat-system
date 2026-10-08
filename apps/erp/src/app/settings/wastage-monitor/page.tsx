import { requirePageAccess } from '../../../lib/page-access';
import { setWastageMonitorAction } from './actions';
import { listActivePersons, listStores, monitorView } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { EditableRecord } from '@/components/forms';
import { FormGrid, Field } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Wastage Monitor — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

/**
 * `/settings/wastage-monitor`. T-229 slice 3 — **DEF-206's remedy.**
 *
 * ⭐ **The screen exists because a column had no writer and the absence cost money silently.**
 * `stores.wastage_monitor_person_id` was assigned nowhere in the product — the only write anywhere
 * was a raw `UPDATE` inside T-178's own test file. With none set, `recordOrderWastage`'s
 * invariant-2 seed does nothing, every tracked wastage is created ownerless, and the 15-day
 * backstop falls to its third tier: *store absorbs, net zero*. Nothing is recovered and nothing
 * errors — the worst shape a defect can take.
 *
 * ⭐ **Why this is its own route rather than a panel on `/wastage`, which is where the person who
 * needs it is standing.** `record_order_wastage` is **staff: true** — `/wastage` is an operational
 * screen the people who record their own losses use. A `manage_store_settings` form there would
 * sit next to the button a staffer presses to log their own wastage, which is the wrong adjacency
 * for a control about who gets charged. `/wastage` links here instead, which is what the spec's
 * "a link from there matters more than a new route" actually asks for.
 *
 * ⭐ **The ownerless figure is the point of the page, not decoration.** A bare person-picker gives
 * a manager no reason to care. The count says what is unowned right now, and it is DERIVED on read
 * — bible §4.2 rule 7 (§13 row 173: a separately-accumulated counter is forbidden even when it is
 * called a cache).
 *
 * ⚠️ **Setting a Monitor does not retro-own what is already open, and the page says so.** An
 * allocation is an attribution; back-filling one would assert a decision nobody made. A number
 * that stubbornly does not drop needs its sentence, or it reads as a bug.
 */
export default async function WastageMonitorSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/wastage-monitor');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <Crumb />
        <h1 className="text-2xl font-semibold">Wastage Monitor</h1>
        <PageDescription>
          This organisation has no stores yet. A Monitor belongs to a branch.
        </PageDescription>
      </Page>
    );
  }

  const [{ monitor, ownerless }, people] = await Promise.all([
    monitorView(actor, storeId),
    listActivePersons(actor.orgId),
  ]);

  return (
    <Page density="table">
      <div>
        <Crumb />
        <h1 className="text-2xl font-semibold">Wastage Monitor</h1>
        <PageDescription>
          Who answers for a wasted or refunded order at this branch when nobody else is named. A
          reviewed wastage is created in this person&apos;s name, and{' '}
          <strong>if it is still unresolved after 15 days it is charged to them automatically</strong>
          .
        </PageDescription>
      </div>

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={`${FIELD} mt-1`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
      </FilterRow>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      {/* ⭐ The consequence, in money, before the form. */}
      {!monitor && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong>Nobody answers for a wasted order at this branch.</strong> Every reviewed wastage
          recorded here is created with no one named, and after 15 days the store absorbs it — no
          error, no warning, nothing recovered.
        </div>
      )}

      {monitor && !monitor.isActive && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong>{monitor.displayName} is no longer active.</strong> Losses are still being created
          in their name. Name somebody else.
        </div>
      )}

      <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p>
          <span className="text-neutral-600 dark:text-neutral-400">Currently:</span>{' '}
          {monitor ? <strong>{monitor.displayName}</strong> : <strong>nobody</strong>}
        </p>
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">
          {ownerless.count === 0 ? (
            <>Nothing open here is unowned.</>
          ) : (
            <>
              <strong className="text-amber-800 dark:text-amber-300">
                {ownerless.count} open {ownerless.count === 1 ? 'wastage' : 'wastages'} worth ₱
                {ownerless.amount}
              </strong>{' '}
              {ownerless.count === 1 ? 'has' : 'have'} nobody answering for {ownerless.count === 1 ? 'it' : 'them'}.
              {/* ⚠️ Said plainly, because the number will not drop when they save and a silent
                  non-change reads as a broken button. */}{' '}
              Naming someone now does <strong>not</strong> change {ownerless.count === 1 ? 'it' : 'them'} —
              an owner is an attribution, and one nobody made cannot be added afterwards. Resolve{' '}
              {ownerless.count === 1 ? 'it' : 'them'} by hand on{' '}
              <a href="/wastage" className="underline">
                Order wastage
              </a>
              .
            </>
          )}
        </p>
      </div>

      {/* Carried (hidden) so the confirmation can name them without a second read. */}
      {monitor ? (
      <EditableRecord
        action={setWastageMonitorAction}
        label="Wastage Monitor"
        hidden={{ storeId, personLabel: monitor?.displayName ?? '' }}
      >
        <FormGrid className="text-sm">
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Monitor</span>}>
            <select
              name="personId"
              defaultValue={monitor?.personId ?? ''}
              className={`${FIELD} mt-1 w-full`}
              aria-label="Wastage Monitor"
            >
              {/* ⭐ A real choice, not a placeholder: picking it CLEARS the assignment. The column is
                  nullable on purpose — a Monitor who leaves must be removable, and a screen that
                  could only ever set one would make a wrong assignment permanent. */}
              <option value="">— nobody (the store absorbs after 15 days) —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
        </FormGrid>
      </EditableRecord> ) : (
        /* No Monitor saved yet: an ADD, rendered open with a Save button (A6 rule 1). */
        <form action={setWastageMonitorAction} className="space-y-3">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="personLabel" value="" />
          <FormGrid className="text-sm">
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Monitor</span>}>
            <select
              name="personId"
              defaultValue=""
              className={`${FIELD} mt-1 w-full`}
              aria-label="Wastage Monitor"
            >
              {/* ⭐ A real choice, not a placeholder: picking it CLEARS the assignment. The column is
                  nullable on purpose — a Monitor who leaves must be removable, and a screen that
                  could only ever set one would make a wrong assignment permanent. */}
              <option value="">— nobody (the store absorbs after 15 days) —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
        </FormGrid>
          <button type="submit" className={BTN}>
            Save
          </button>
        </form>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ⚠️ The list is everyone active in the organisation, not only people who sign in here — a
        Monitor is someone a cost can be charged to, which is a wider pool than someone who uses
        the ERP. Whether a channel&apos;s wastages are reviewed at all is set on{' '}
        <a href="/settings/sales-channels" className="underline">
          Sales channels
        </a>
        .
      </p>
    </Page>
  );
}

function Crumb() {
  return (
    <p className="text-xs text-neutral-500 dark:text-neutral-400">
      <a href="/settings" className="underline">
        Settings
      </a>{' '}
      / Wastage Monitor
    </p>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

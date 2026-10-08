import { EMPLOYMENT_STATUSES, ENDED_STATUSES } from '@shareat/db/schema';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { hireAction } from '../actions';
import { listStores, positionsForStore, searchPersonsFor } from '../lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { Input } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Hire — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  q?: string;
  error?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';

/** ⭐ v1/T-154 name no canonical "just hired" default among the seven statuses. `probationary` is
 *  what T-154's own test fixture already hires with, and reads as "not yet regular" — chosen and
 *  named here, per the spec's own request, rather than silently picked. */
const HIRE_DEFAULT_STATUS = 'probationary';

/** Every status except the two that mean "has left" — hiring INTO an ended status is refused by
 *  the domain, so it is not offered here either. */
const HIRE_STATUSES = EMPLOYMENT_STATUSES.filter((s) => !(ENDED_STATUSES as readonly string[]).includes(s));

export default async function HireStaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/staff/hire');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Hire</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const query = sp.q ?? '';
  const [positions, results] = await Promise.all([
    positionsForStore(actor.orgId, storeId),
    searchPersonsFor(actor, query),
  ]);

  return (
    <Page density="table">
      <div>
        <a href="/staff" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Staff
        </a>
        <h1 className="mt-1 text-2xl font-semibold">Hire</h1>
        <PageDescription>
          Find the person first — a typo in an existing name must never mint a duplicate. Someone
          who already works another store shows up here too; hiring them again just opens a second
          employment for the same person (T-154 invariant 8).
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <FilterRow submitLabel="Search">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={INPUT}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Find a person</span>
          <Input name="q" defaultValue={query} placeholder="Maria" className="w-56" />
        </label>
      </FilterRow>

      {query && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {results.length === 0
            ? `Nobody matches "${query}" — pick "create new person" below.`
            : `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}".`}
        </p>
      )}

      <form action={hireAction} className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <input type="hidden" name="storeId" value={storeId} />

        <fieldset className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Who is this?
          </legend>
          {results.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="personChoice" value={`existing:${p.id}`} required className="h-4 w-4" />
              Use this person: <strong>{p.displayName}</strong>
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="personChoice" value="new" required className="h-4 w-4" />
            Create new person named:
            <Input name="newDisplayName" placeholder="Full name" className="w-56" />
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⚠️ Nothing is created until you submit, and only the option you pick is used — searching
            never creates a person by itself.
          </p>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Starting status</span>
            <select name="employmentStatus" defaultValue={HIRE_DEFAULT_STATUS} className={INPUT}>
              {HIRE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/-/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Start date</span>
            <Input type="date" name="startedOn" required defaultValue={toBusinessDate()} />
          </label>
        </div>

        <fieldset className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Positions — tick what they do, mark exactly one primary
          </legend>
          {positions.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              No positions defined for this store yet.
            </p>
          ) : (
            <div className="space-y-1">
              {positions.map((p) => (
                <div key={p.id} className="flex items-center gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="positionIds" value={p.id} className="h-4 w-4" />
                    {p.name}
                  </label>
                  <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <input type="radio" name="primaryPositionId" value={p.id} />
                    primary
                  </label>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Leaving all of this blank hires them as <strong>Server</strong> — v1&rsquo;s
            least-privileged default, chosen so an unspecified role never silently inherits
            someone else&rsquo;s permissions.
          </p>
        </fieldset>

        <button type="submit" className={BTN}>
          Hire
        </button>
      </form>
    </Page>
  );
}

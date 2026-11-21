import { EMPLOYMENT_STATUSES, ENDED_STATUSES } from '@shareat/db/schema';
import { toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess, StoreNotAvailable } from '../../../lib/page-access';
import { hireAction } from '../actions';
import { positionsForStore, searchPersonsFor, staffStoresFor } from '../lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { Button, FlashBanner, FormGrid, FormSection, Field, Input, SaveBar } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { STAFF_HIRE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
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

/** ⭐ v1/T-154 name no canonical "just hired" default among the seven statuses. `probationary` is
 *  what T-154's own test fixture already hires with, and reads as "not yet regular" — chosen and
 *  named here, per the spec's own request, rather than silently picked. */
const HIRE_DEFAULT_STATUS = 'probationary';

/** Every status except the two that mean "has left" — hiring INTO an ended status is refused by
 *  the domain, so it is not offered here either. */
/** The status as a sentence-case label; the option value stays the stored word. */
const statusWords = (s: string): string => { const t = s.replace(/-/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

const HIRE_STATUSES = EMPLOYMENT_STATUSES.filter((s) => !(ENDED_STATUSES as readonly string[]).includes(s));

export default async function HireStaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  // T-435 / bible row 353 - hiring needs enrol_staff, at the viewer's own stores only.
  const { actor, refusal } = await requirePageAccess('/staff/hire');
  if (refusal) return refusal;
  const stores = await staffStoresFor(actor, ['enrol_staff']);
  if (stores.length === 0) return <StoreNotAvailable />;
  if (sp.store && !stores.some((s) => s.id === sp.store)) return <StoreNotAvailable />;
  const storeId = sp.store || stores[0]?.id;

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
        <h1 className="mt-1 text-2xl font-semibold">Hire someone</h1>
        <PageDescription>Search first, so a typo does not make a duplicate.</PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow submitLabel="Search">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={`${INPUT} mt-1 w-full`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Find a person</span>
          <Input name="q" defaultValue={query} placeholder="Maria" className="w-full sm:w-auto sm:min-w-48 sm:flex-1" />
        </label>
      </FilterRow>

      {query && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {results.length === 0
            ? `Nobody matches "${query}" — type their name below.`
            : `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}".`}
        </p>
      )}

      <CheckedForm rules={STAFF_HIRE_RULES} action={hireAction} className="space-y-4">
        <input type="hidden" name="storeId" value={storeId} />

        <FormSection title="Who is this?" className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          {results.map((p) => (
            <label key={p.id} className="flex min-h-11 items-center gap-3 text-sm">
              <input type="radio" name="personChoice" value={`existing:${p.id}`} className="h-4 w-4" />
              <span>Use: <strong>{p.displayName}</strong>{'branches' in p && ` (works at ${p.branches.join(', ')})`}</span>
            </label>
          ))}
          <p className="pt-1 text-sm font-medium">Or a new person</p>
          <FormGrid>
            <Field label="Last name">
              <Input name="lastName" placeholder="Santos" className="mt-1 w-full" />
            </Field>
            <Field label="First name">
              <Input name="firstName" placeholder="Maria" className="mt-1 w-full" />
            </Field>
            <Field label="Middle name (optional)">
              <Input name="middleName" placeholder="Clara" className="mt-1 w-full" />
            </Field>
          </FormGrid>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="sameNameConfirmed" className="h-4 w-4" />
            This is a different person with the same name
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Nothing is created until you save. Pick a person above or type a name, not both. A typed
            name shows as &ldquo;Last, First M.&rdquo;.
          </p>
        </FormSection>

        <FormSection title="The job" className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <FormGrid>
            <Field label="Starting status">
              <select name="employmentStatus" defaultValue={HIRE_DEFAULT_STATUS} className={`${INPUT} mt-1 w-full`}>
                {HIRE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusWords(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start date" rule={STAFF_HIRE_RULES.startedOn}>
              <Input type="date" {...nativeAttrs(STAFF_HIRE_RULES.startedOn)} defaultValue={toBusinessDate()} className="mt-1 w-full" />
            </Field>
          </FormGrid>

          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Positions</legend>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Tick what they do. Mark one as their main job. Leave all blank to hire them as <strong>Server</strong>, the role with the fewest permissions.
            </p>
            {positions.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                No positions defined for this store yet.
              </p>
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {positions.map((p) => (
                  <div key={p.id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
                    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                      <input type="checkbox" name="positionIds" value={p.id} className="h-4 w-4" />
                      {p.name}
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                      <input type="radio" name="primaryPositionId" value={p.id} className="h-4 w-4" />
                      Main job
                    </label>
                  </div>
                ))}
              </div>
            )}
          </fieldset>
        </FormSection>

        <SaveBar>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </SaveBar>
      </CheckedForm>
    </Page>
  );
}

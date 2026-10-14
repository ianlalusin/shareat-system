import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { upsertStorePositionAction } from './actions';
import { listStores, positionsForStore, rosterForStore, withOrgPrincipal } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { Button, FlashBanner, Input } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { can } from '@shareat/auth';
import { employmentRepo, pinAttemptsRepo } from '@shareat/db';
import { todayStateFor } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { canViewPhoto } from '../../lib/photo-link';
import { CardWall, Roster, ViewSwitch, type LiveEntry, type StaffPerson } from './StaffViews';
import { PinSignInPanel } from './PinSignInPanel';

export const metadata = { title: 'Staff — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
  view?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export default async function StaffPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/staff');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Staff</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [roster, positions] = await Promise.all([
    rosterForStore(actor.orgId, storeId),
    positionsForStore(actor.orgId, storeId),
  ]);

  // T-387 S7 - photos (only where the viewer may open them) and the live state (only for manage_attendance here).
  const ids = roster.map((r) => r.id);
  const [photoIds, states] = await Promise.all([
    withOrgPrincipal(actor.orgId, (tx) => employmentRepo.photoFileIds(tx, ids)),
    withOrgPrincipal(actor.orgId, async (tx): Promise<Record<string, LiveEntry> | null> => {
      // A2: the non-logging check first (todayStateFor's own gate is manage_attendance at this store).
      if (!(await can(tx, actor, 'manage_attendance', { storeId }))) return null;
      return todayStateFor(tx, actor, storeId);
    }),
  ]);
  const people: StaffPerson[] = await Promise.all(
    roster.map(async (r) => {
      const fileId = photoIds.get(r.id) ?? null;
      const primary = r.positions.find((p) => p.isPrimary) ?? r.positions[0];
      return {
        id: r.id,
        displayName: r.displayName,
        employmentStatus: r.employmentStatus,
        startedOn: r.startedOn,
        primaryPosition: primary?.name ?? null,
        photoFileId: fileId && (await canViewPhoto(actor, fileId)) ? fileId : null,
      };
    }),
  );
  const now = new Date();
  const today = toBusinessDate(now);
  const storeName = stores.find((s) => s.id === storeId)?.name ?? '';
  const view: 'cards' | 'roster' = sp.view === 'roster' ? 'roster' : 'cards';

  // T-395 S2 - the PIN sign-in panel is for anyone holding enrol_staff at this store (R5).
  const pinStatus = await withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'enrol_staff', { storeId }))) return null;
    return pinAttemptsRepo.statusForStore(tx, storeId);
  });

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <PageDescription className="mt-1">
            Who is on the roster at this store right now. ⭐ Every attendance, payroll and
            credential screen in this app needs an employment to point at — this is where one gets
            created (DEF-131).
          </PageDescription>
        </div>
        <Link href={`/staff/hire?store=${storeId}`} className="inline-flex min-h-11 items-center rounded-[12px] border border-transparent bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover">
          Hire
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <FilterRow>
          <input type="hidden" name="view" value={view} />
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
        </FilterRow>
        <ViewSwitch view={view} storeId={storeId} />
      </div>

      <section className="space-y-3">
        {people.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nobody hired here yet. &ldquo;Hire&rdquo; above starts one.
          </p>
        ) : view === 'roster' ? (
          <Roster people={people} today={today} now={now} states={states} />
        ) : (
          <CardWall people={people} storeName={storeName} today={today} states={states} />
        )}
      </section>

      {pinStatus && <PinSignInPanel storeId={storeId} status={pinStatus} />}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">This store&rsquo;s positions</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The canonical six belong to the organisation and cannot be renamed here. A store may add
          its own beyond them.
        </p>
        <ul className="flex flex-wrap gap-2 text-sm">
          {positions.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
            >
              {p.name}
              {p.isCanonical && <span className="ml-1 text-xs text-neutral-400">(canonical)</span>}
            </li>
          ))}
        </ul>
        <form
          action={upsertStorePositionAction}
          className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800"
        >
          <input type="hidden" name="storeId" value={storeId} />
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Add a position</span>
            <Input name="name" required placeholder="Barista" />
          </label>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </form>
      </section>
    </Page>
  );
}

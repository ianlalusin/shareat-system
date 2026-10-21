import Link from 'next/link';
import { requirePageAccess, StoreNotAvailable } from '../../lib/page-access';
import { issueAdminPinAction, upsertStorePositionAction } from './actions';
import { positionsForStore, rosterForStore, staffStoresFor, withOrgPrincipal } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { Button, Field, FlashBanner, Input } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { STAFF_PIN_RULES, STAFF_POSITION_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { can } from '@shareat/auth';
import { accessRepo, employmentRepo, pinAttemptsRepo } from '@shareat/db';
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
  // T-435 / bible row 353 - enrol_staff OR manage_attendance (Ian Q2), for the viewer's own stores only.
  const { actor, refusal } = await requirePageAccess('/staff');
  if (refusal) return refusal;
  const stores = await staffStoresFor(actor);
  if (stores.length === 0) return <StoreNotAvailable />;
  // A requested store the viewer does not hold is one sentence - never a quiet fallback to another store.
  if (sp.store && !stores.some((s) => s.id === sp.store)) return <StoreNotAvailable />;
  const storeId = sp.store || stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Staff and positions</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [roster, positions] = await Promise.all([
    rosterForStore(actor, storeId),
    positionsForStore(actor.orgId, storeId),
  ]);

  // The Positions tab only uses names and ids - photos and live state are for the Cards and Roster views.
  const view: 'cards' | 'roster' | 'positions' =
    sp.view === 'roster' ? 'roster' : sp.view === 'positions' ? 'positions' : 'cards';

  // T-387 S7 - photos (only where the viewer may open them) and the live state (only for manage_attendance here).
  let people: StaffPerson[] = [];
  let states: Record<string, LiveEntry> | null = null;
  if (view !== 'positions') {
    const ids = roster.map((r) => r.id);
    const [photoIds, liveStates] = await Promise.all([
      withOrgPrincipal(actor.orgId, (tx) => employmentRepo.photoFileIds(tx, ids)),
      withOrgPrincipal(actor.orgId, async (tx): Promise<Record<string, LiveEntry> | null> => {
        // A2: the non-logging check first (todayStateFor's own gate is manage_attendance at this store).
        if (!(await can(tx, actor, 'manage_attendance', { storeId }))) return null;
        return todayStateFor(tx, actor, storeId);
      }),
    ]);
    states = liveStates;
    people = await Promise.all(
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
  }
  const now = new Date();
  const today = toBusinessDate(now);
  const storeName = stores.find((s) => s.id === storeId)?.name ?? '';

  // T-395 S2 - the PIN sign-in panel is for anyone holding enrol_staff at this store (R5).
  const pinStatus = await withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'enrol_staff', { storeId }))) return null;
    return pinAttemptsRepo.statusForStore(tx, storeId);
  });

  // T-412 (Ian Q1 "a"): an administrator approves destructive actions with their own PIN, and one who signs in by email only
  // has none - so whoever holds manage_users can issue one here, without an employment page.
  const adminPins = await withOrgPrincipal(actor.orgId, async (tx) => {
    if (!(await can(tx, actor, 'manage_users', {}))) return null;
    return accessRepo.listActiveAdminsWithPinState(tx, actor.orgId);
  });

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Staff and positions</h1>
          <PageDescription className="mt-1">
            Who is on the roster at this store right now, and the positions they hold. ⭐ Every attendance, payroll and
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

      {view === 'positions' ? (
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Positions</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The canonical six belong to the organisation and cannot be renamed here. A store may add
          its own beyond them.
        </p>
        <ul className="space-y-2 text-sm">
          {positions.map((p) => {
            const holders = roster.filter((r) => r.positions.some((a) => a.positionId === p.id));
            return (
              <li key={p.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
                <details>
                  <summary className="flex min-h-11 cursor-pointer items-center px-3 py-1.5">
                    {p.name}
                    {p.isCanonical && <span className="ml-1 text-xs text-neutral-400">(canonical)</span>}
                    <span className="ml-1">· {holders.length}</span>
                  </summary>
                  {holders.length === 0 ? (
                    <p className="px-3 pb-2 text-xs text-neutral-500 dark:text-neutral-400">Nobody holds this position here.</p>
                  ) : (
                    <ul className="space-y-1 px-3 pb-2">
                      {holders.map((h) => (
                        <li key={h.id}>
                          <Link href={`/staff/${h.id}`} className="inline-flex min-h-6 items-center underline">
                            {h.displayName}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
        <CheckedForm
          rules={STAFF_POSITION_RULES}
          action={upsertStorePositionAction}
          className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800"
        >
          <input type="hidden" name="storeId" value={storeId} />
          <Field label="Add a position" rule={STAFF_POSITION_RULES.name}>
            <Input {...nativeAttrs(STAFF_POSITION_RULES.name)} placeholder="Barista" />
          </Field>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </CheckedForm>
      </section>
      ) : (
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
      )}

      {pinStatus && <PinSignInPanel storeId={storeId} status={pinStatus} />}

      {adminPins && adminPins.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Administrator PINs</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            An administrator approves a void, a reversal, a delete or a cutover step by typing their own 6-digit PIN. One who
            signs in by email only has no PIN until one is issued here. Issuing a new PIN replaces the old one and ends that
            person&rsquo;s live sessions.
          </p>
          <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
            {adminPins.map((a) => (
              <li key={a.personId} className="flex flex-wrap items-end justify-between gap-3 py-2">
                <div>
                  <div className="font-medium">{a.displayName}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {a.role === 'super_admin' ? 'Super admin' : 'Admin'} · {a.hasPin ? 'PIN issued' : 'No PIN yet'}
                  </div>
                </div>
                <CheckedForm rules={STAFF_PIN_RULES} action={issueAdminPinAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="personId" value={a.personId} />
                  <input type="hidden" name="storeId" value={storeId} />
                  <Field label={`${a.hasPin ? 'New PIN' : 'PIN'} (6 digits)`} rule={STAFF_PIN_RULES.pin}>
                    <Input {...nativeAttrs(STAFF_PIN_RULES.pin)} type="password" autoComplete="off" />
                  </Field>
                  <Button type="submit" variant="secondary">
                    {a.hasPin ? 'Re-issue PIN' : 'Issue PIN'}
                  </Button>
                </CheckedForm>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

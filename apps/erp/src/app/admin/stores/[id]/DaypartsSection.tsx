import { Badge, Button, Checkbox, Field, FormGrid, FormModal, Input } from '@/components/ui';
import { daysText, WEEK_ORDER, dayShort, windowText } from '../../../menu/daypart-text';
import type { DaypartView } from '../../../menu/lib';
import { createDaypartAction, retireDaypartAction, updateDaypartAction } from '../actions';

const CARD = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';
const MUTED = 'text-neutral-600 dark:text-neutral-400';

/** The form body shared by Add and Edit. Hours are the store's own clock. */
function DaypartFields({ d }: { d?: DaypartView }) {
  const days = new Set(d ? d.days : [0, 1, 2, 3, 4, 5, 6]);
  return (
    <div className="space-y-3 text-sm">
      <FormGrid>
        <Field label="Name">
          <Input name="name" defaultValue={d?.name ?? ''} placeholder="Lunch, Dinner…" className="mt-1 w-full" />
        </Field>
        <Field label="Starts">
          <Input type="time" name="start" defaultValue={d?.start ?? ''} className="mt-1 w-full tabular-nums" />
        </Field>
        <Field label="Ends">
          <Input type="time" name="end" defaultValue={d?.end ?? ''} className="mt-1 w-full tabular-nums" />
        </Field>
      </FormGrid>
      <fieldset>
        <legend className="mb-1">Days</legend>
        <div className="flex flex-wrap gap-x-4">
          {WEEK_ORDER.map((n) => (
            <Checkbox key={n} name="days" value={String(n)} defaultChecked={days.has(n)} label={dayShort(n)} />
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-neutral-500">
        Use the store&apos;s clock. For hours that run past midnight, end earlier than you start: 17:00 to 08:00 means dinner ends at 08:00 the next morning.
      </p>
    </div>
  );
}

/**
 * T-510 S3 (R9): a store's lunch and dinner hours (menu dayparts). Everyone who can open the store page sees the list; the controls
 * are drawn only when `canManage` (`manage_store_settings` at this store), which is presentation: the domain gates every write again.
 */
export function DaypartsSection({ storeId, dayparts, canManage }: { storeId: string; dayparts: DaypartView[]; canManage: boolean }) {
  const active = dayparts.filter((d) => d.status === 'active');
  const retired = dayparts.filter((d) => d.status === 'retired');
  return (
    <section id="dayparts" className={CARD}>
      <h2 className="text-sm font-medium">Lunch and dinner hours</h2>
      <p className="text-xs text-neutral-500">
        Hours a price can follow, like Lunch from 08:00 to 17:00. A price tied to Lunch is only on sale in those hours; the cashier sees when it opens next.
        Choose which prices follow which hours under Menu prices.
      </p>
      {active.length === 0 ? (
        <p className={`text-sm ${MUTED}`}>No hours yet. Every price here applies all day.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {active.map((d) => (
            <li key={d.id} className="space-y-2 py-3 first:pt-0">
              <div>
                <span className="font-medium">{d.name}</span>
                <span className="ml-2 tabular-nums">{windowText(d.start, d.end)}</span>
                <span className={`block text-xs ${MUTED}`}>{daysText(d.days)}</span>
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <FormModal trigger="Edit" triggerVariant="secondary" triggerLabel={`Edit ${d.name} hours`} title={`Edit ${d.name}`} size="md">
                    <form action={updateDaypartAction} className="space-y-3">
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="daypartId" value={d.id} />
                      <DaypartFields d={d} />
                      <Button type="submit" variant="secondary">
                        Save
                      </Button>
                    </form>
                  </FormModal>
                  <form action={retireDaypartAction}>
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="daypartId" value={d.id} />
                    <Button type="submit" variant="ghost" aria-label={`Retire ${d.name}`}>
                      Retire
                    </Button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {retired.length > 0 && (
        <details className="text-sm">
          <summary className="inline-flex min-h-6 cursor-pointer items-center underline underline-offset-2">Retired hours ({retired.length})</summary>
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {retired.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={MUTED}>
                  {d.name} · {windowText(d.start, d.end)} · {daysText(d.days)}
                </span>
                <Badge tone="closed" label="Retired" />
              </li>
            ))}
          </ul>
        </details>
      )}
      {canManage ? (
        <FormModal trigger="Add hours" triggerVariant="secondary" title="Add lunch or dinner hours" size="md">
          <form action={createDaypartAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <DaypartFields />
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        </FormModal>
      ) : (
        <p className="text-xs text-neutral-500">Only an admin or this store&apos;s manager can change these hours.</p>
      )}
    </section>
  );
}

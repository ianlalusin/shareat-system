import type { BusinessRuleChange, BusinessRuleItem } from '@shareat/domain';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor } from '../../../lib/keep-typing';
import { setBusinessRuleAction } from './actions';
import { fromWords, inputValue, madeOn, rulesView, sharedDayWinners, showValue } from './lib';
import { BUSINESS_RULE_EDIT, ruleRecordId } from './typed-forms';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { EditableRecord } from '@/components/forms';
import { Badge, Field, FlashBanner, FormGrid, Input, Textarea } from '@/components/ui';
import { SETTINGS_BUSINESS_RULE_RULES, nativeAttrs } from '@shareat/domain/field-rules';

export const metadata = { title: 'Business rules — Shareat System' };
export const dynamic = 'force-dynamic';

/** How many past rows show before the rest fold under "earlier changes". */
const HISTORY_SHOWN = 3;

const HOUR_BOX = { type: 'number', inputMode: 'numeric', step: 1, min: 0, max: 23 } as const;
const MINUTES_BOX = { type: 'number', inputMode: 'numeric', step: 1, min: 1, max: 600 } as const;

const NEW_VALUE_LABEL: Record<BusinessRuleItem['unit'], string> = { money: 'New value (pesos)', percent: 'New value (percent)', hour: 'New value (hour, 0–23)', minutes: 'New value (minutes)' };

/**
 * `/settings/business-rules`. T-512 (T-511 S5c).
 *
 * The figures the system checks money against, each changed from a date the admin chooses. A change never rewrites the past: days before
 * the date keep the old value, and every change keeps who made it and why. Admin only (`manage_business_rules`).
 */
export default async function BusinessRulesPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/business-rules');
  if (refusal) return refusal;
  const view = await rulesView(actor);

  return (
    <Page density="table" className="space-y-8">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className={ACTION_LINK}>
            Settings
          </a>{' '}
          / Business rules
        </p>
        <h1 className="text-2xl font-semibold">Business rules</h1>
        <PageDescription>The figures the system checks money against. A new value starts on a day you choose; days before keep the old value.</PageDescription>
        <p className="mt-1 text-sm text-muted">
          A statement already read keeps the figure it was read with. Each change records who made it and why.
        </p>
      </div>

      <FlashBanner flash={sp} />

      {view.groups.map((group) => (
        <section key={group.heading} className="space-y-3">
          <h2 className="text-lg font-semibold">{group.heading}</h2>
          <div className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {group.items.map((item) => (
              <article key={item.key} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <h3 className="text-base font-medium">{item.label}</h3>
                    <p className="mt-1 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">{item.help}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <p>
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400">In force today</span>
                      <span className="text-xl font-semibold tabular-nums">{showValue(item.unit, item.current)}</span>
                    </p>
                    <EditableRecord
                      action={setBusinessRuleAction}
                      label={item.label}
                      hidden={{ key: item.key }}
                      editText="Change from a date"
                      rules={SETTINGS_BUSINESS_RULE_RULES}
                      typed={typedFor(sp, BUSINESS_RULE_EDIT, ruleRecordId(item.key), actor.personId)}
                    >
                      <FormGrid>
                        <Field label={NEW_VALUE_LABEL[item.unit]} rule={SETTINGS_BUSINESS_RULE_RULES.value}>
                          {/* An hour or a count of minutes is a whole-number box (step 1; 0 to 23 or 1 to 600): the field rule's pattern alone would let 4.5 through; the writer refuses a fraction too. */}
                          <Input {...nativeAttrs(SETTINGS_BUSINESS_RULE_RULES.value)} {...(item.unit === 'hour' ? HOUR_BOX : item.unit === 'minutes' ? MINUTES_BOX : { inputMode: 'decimal' as const })} defaultValue={inputValue(item.unit, item.current)} className="w-full text-right" />
                        </Field>
                        <Field label="Starts on" rule={SETTINGS_BUSINESS_RULE_RULES.effectiveFrom}>
                          <Input {...nativeAttrs(SETTINGS_BUSINESS_RULE_RULES.effectiveFrom)} type="date" min={view.today} defaultValue={view.tomorrow} className="w-full" />
                        </Field>
                        <Field label="Why is it changing?" span="full" rule={SETTINGS_BUSINESS_RULE_RULES.reason}>
                          <Textarea {...nativeAttrs(SETTINGS_BUSINESS_RULE_RULES.reason)} rows={3} className="w-full" />
                        </Field>
                      </FormGrid>
                    </EditableRecord>
                  </div>
                </div>

                <Scheduled item={item} winners={sharedDayWinners(item)} />
                <History item={item} today={view.today} winners={sharedDayWinners(item)} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </Page>
  );
}

function ChangeRow({ item, change, wins }: { item: BusinessRuleItem; change: BusinessRuleChange; wins: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="font-medium tabular-nums">{showValue(item.unit, change.value)}</span>
      <span>{fromWords(change)}</span>
      {wins ? <Badge tone="info" label="In force from that day" /> : null}
      <span className="basis-full min-w-0 break-words text-neutral-600 dark:text-neutral-400">
        {change.reason}
        {change.setByName ? ` · ${change.setByName}, ${madeOn(change)}` : null}
      </span>
    </li>
  );
}

/** Changes that start after today. Hidden when there are none. */
function Scheduled({ item, winners }: { item: BusinessRuleItem; winners: ReadonlySet<string> }) {
  if (item.scheduled.length === 0) return null;
  return (
    <div>
      <h4 className="text-sm font-medium">Scheduled changes</h4>
      <ul className="mt-1 space-y-1.5">
        {item.scheduled.map((c) => (
          <ChangeRow key={c.id} item={item} change={c} wins={winners.has(c.id)} />
        ))}
      </ul>
    </div>
  );
}

/** Rows already in force or past, newest first; the oldest fold under a line so a long history does not push the next rule down. */
function History({ item, today, winners }: { item: BusinessRuleItem; today: string; winners: ReadonlySet<string> }) {
  const past = item.history.filter((c) => c.effectiveFrom.localeCompare(today) <= 0);
  if (past.length === 0) return null;
  const shown = past.slice(0, HISTORY_SHOWN);
  const older = past.slice(HISTORY_SHOWN);
  return (
    <div>
      <h4 className="text-sm font-medium">History</h4>
      <ul className="mt-1 space-y-1.5">
        {shown.map((c) => (
          <ChangeRow key={c.id} item={item} change={c} wins={winners.has(c.id)} />
        ))}
      </ul>
      {older.length > 0 && (
        <details className="mt-1.5">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-sm text-neutral-600 dark:text-neutral-400">Show {older.length} earlier {older.length === 1 ? 'change' : 'changes'}</summary>
          <ul className="mt-1.5 space-y-1.5">
            {older.map((c) => (
              <ChangeRow key={c.id} item={item} change={c} wins={winners.has(c.id)} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

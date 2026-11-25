import { getAiHubView, type AiHubView, type AiModelView, type AiProviderView } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { AI_KEY_RULES, AI_SETTINGS_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor } from '../../../lib/keep-typing';
import { peso } from '../../../lib/format';
import { withOrgPrincipal } from '../../expenses/lib';
import { activateModelAction, deactivateModelAction, moveModelAction, removeKeyAction, saveKeyAction, saveSettingsAction, storeSwitchAction, testModelAction } from './actions';
import { AI_SETTINGS_EDIT } from './typed-forms';
import { Page } from '@/components/shell/Page';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Badge, Banner, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';

export const metadata = { title: 'AI hub — Shareat System' };
export const dynamic = 'force-dynamic';

/** US cents per million tokens as dollars, by string surgery (no float). */
const usd = (cents: number): string => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const when = (d: Date): string => formatBusinessDateTime(d, { dateStyle: 'medium' });

/**
 * `/settings/ai-hub`. T-640 (docs/tasks/640-ai-hub.md). Super admin only (`manage_ai_hub`).
 *
 * Provider keys (typed here, stored encrypted, never shown back: only the last 4 characters), the models each provider offers (a list in code: tested, then switched on), the order they
 * are tried in, the monthly cap and the daily limit, the AI switches, and what this month has cost. ⛔ This page never receives a key or its ciphertext: the read model has neither.
 */
export default async function AiHubPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/ai-hub');
  if (refusal) return refusal;
  const view = await withOrgPrincipal(actor.orgId, (tx) => getAiHubView(tx, actor));

  return (
    <Page
      density="table"
      className="space-y-8"
      title="AI hub"
      description="Where the company's AI providers are set up: their keys, which models may answer, in what order, and how much may be spent. Nothing here lets AI change a record."
    >
      <FlashBanner flash={sp} />
      {view.masterKey !== 'ok' && (
        <Banner tone="warning">
          <strong>The server has no usable encryption key for the AI hub yet</strong>, so provider keys cannot be saved or used. Ask whoever runs the server to set <code>AI_KEYS_MASTER_KEY</code> (the notes in <code>.env.example</code> say how), then reload this page.
        </Banner>
      )}

      <Usage view={view} />

      <section className="space-y-3" aria-labelledby="providers-h">
        <h2 id="providers-h" className="text-lg font-semibold">
          Providers and keys
        </h2>
        <p className="text-sm text-muted">
          Paste a key from the provider. It is encrypted before it is saved and is never shown again: only its last 4 characters. To change a key, paste a new one.
        </p>
        <div className="space-y-3">
          {view.providers.map((p) => (
            <ProviderCard key={p.provider} p={p} />
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="models-h">
        <h2 id="models-h" className="text-lg font-semibold">
          Models
        </h2>
        <p className="text-sm text-muted">
          A model can answer only after its Test passes (a tiny question with one tool). A failed test never switches off a model that is already working.
        </p>
        {view.providers.map((p) => (
          <ModelGroup key={p.provider} provider={p} models={view.models.filter((m) => m.provider === p.provider)} />
        ))}
      </section>

      <Order view={view} />

      <section className="space-y-3" aria-labelledby="limits-h">
        <h2 id="limits-h" className="text-lg font-semibold">
          Spending cap and limits
        </h2>
        <EditableRecord
          action={saveSettingsAction}
          label="AI limits"
          summary={[
            { label: 'AI features', value: view.settings.enabled ? 'On' : 'Off' },
            { label: 'Monthly cap', value: peso(String(view.settings.monthlyCapPesos)) },
            { label: 'Questions per person per day', value: `${view.settings.dailyLimitPerPerson} (administrators have no limit)` },
            { label: 'Pesos per US dollar', value: view.settings.pesosPerUsd },
            { label: 'Warn administrators at', value: `${view.settings.warnAtPercent}% of the cap` },
          ]}
          hidden={{}}
          typed={typedFor(sp, AI_SETTINGS_EDIT, '', actor.personId)}
          rules={AI_SETTINGS_RULES}
        >
          <FormGrid className="text-sm">
            <Field label="AI features">
              <Select name="enabled" defaultValue={view.settings.enabled ? '1' : '0'} className="w-full">
                <option value="1">On</option>
                <option value="0">Off</option>
              </Select>
            </Field>
            <Field label="Monthly cap (pesos)" rule={AI_SETTINGS_RULES.monthlyCapPesos}>
              <Input {...nativeAttrs(AI_SETTINGS_RULES.monthlyCapPesos)} defaultValue={String(view.settings.monthlyCapPesos)} className="w-full text-right" />
            </Field>
            <Field label="Questions per person per day" rule={AI_SETTINGS_RULES.dailyLimitPerPerson}>
              <Input {...nativeAttrs(AI_SETTINGS_RULES.dailyLimitPerPerson)} defaultValue={String(view.settings.dailyLimitPerPerson)} className="w-full text-right" />
            </Field>
            <Field label="Pesos per US dollar" rule={AI_SETTINGS_RULES.pesosPerUsd}>
              <Input {...nativeAttrs(AI_SETTINGS_RULES.pesosPerUsd)} inputMode="decimal" defaultValue={view.settings.pesosPerUsd} className="w-full text-right" />
            </Field>
            <Field label="Warn administrators at (% of the cap)" rule={AI_SETTINGS_RULES.warnAtPercent}>
              <Input {...nativeAttrs(AI_SETTINGS_RULES.warnAtPercent)} defaultValue={String(view.settings.warnAtPercent)} className="w-full text-right" />
            </Field>
          </FormGrid>
        </EditableRecord>
        <p className="text-sm text-muted">
          When the cap is reached every AI question is refused with a plain sentence until the 1st of next month (or until you raise it). The peso rate is what a call&apos;s cost is worked out at.
        </p>
      </section>

      <section className="space-y-3" aria-labelledby="stores-h">
        <h2 id="stores-h" className="text-lg font-semibold">
          Stores
        </h2>
        <p className="text-sm text-muted">Switch AI features off for one store. A store with no choice made is on.</p>
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {view.stores.map((s) => (
            <li key={s.storeId} className="flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-0 flex-1 font-medium">{s.name}</span>
              <Badge tone={s.enabled ? 'success' : 'closed'} label={s.enabled ? 'AI on' : 'AI off'} />
              <form action={storeSwitchAction}>
                <input type="hidden" name="storeId" value={s.storeId} />
                <input type="hidden" name="enabled" value={s.enabled ? '0' : '1'} />
                <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…">
                  {s.enabled ? 'Switch off' : 'Switch on'}
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}

function Usage({ view }: { view: AiHubView }) {
  const u = view.usage;
  return (
    <section className="space-y-3" aria-labelledby="usage-h">
      <h2 id="usage-h" className="text-lg font-semibold">
        This month
      </h2>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums">{peso(u.spentText)}</span>
        <span className="text-muted">
          of the {peso(u.capText)} cap ({u.percent}%)
        </span>
        {u.level === 'capped' ? <Badge tone="danger" label="Cap reached" /> : u.level === 'warn' ? <Badge tone="warning" label="Close to the cap" /> : <Badge tone="success" label="Within the cap" />}
      </p>
      {u.level === 'capped' && <Banner tone="error">The monthly cap is reached, so every AI question is being refused until the 1st of next month. Raise the cap below to open it again.</Banner>}
      {u.level === 'warn' && <Banner tone="warning">Spending has passed {view.settings.warnAtPercent}% of the monthly cap.</Banner>}
      {u.byFeature.length === 0 ? (
        <p className="text-sm text-muted">Nothing has been spent on AI this month.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <UsageList title="By feature" lines={u.byFeature} />
          <UsageList title="By person" lines={u.byPerson} />
        </div>
      )}
    </section>
  );
}

function UsageList({ title, lines }: { title: string; lines: AiHubView['usage']['byFeature'] }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="mt-1 divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {lines.map((l) => (
          <li key={l.label} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
            <span className="min-w-0 break-words">{l.label}</span>
            <span className="tabular-nums text-muted">
              {l.calls} {l.calls === 1 ? 'call' : 'calls'} · {peso(l.costText)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProviderCard({ p }: { p: AiProviderView }) {
  return (
    <article className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{p.label}</h3>
        {p.hasKey ? <Badge tone="success" label={`Key saved, ends in ${p.last4}`} /> : <Badge tone="closed" label="No key yet" />}
      </div>
      {p.hasKey && p.updatedAt && (
        <p className="text-sm text-muted">
          Saved by {p.setByName} on {when(p.updatedAt)}. The key itself is not shown again.
        </p>
      )}
      <CheckedForm rules={AI_KEY_RULES} action={saveKeyAction} className="flex flex-wrap items-end gap-2" autoComplete="off">
        <input type="hidden" name="provider" value={p.provider} />
        <Field label={p.hasKey ? 'Replace the key' : 'Paste the key'} rule={AI_KEY_RULES.key}>
          <Input {...nativeAttrs(AI_KEY_RULES.key)} type="password" autoComplete="off" spellCheck={false} className="w-full" />
        </Field>
        <SubmitButton variant="primary" pendingLabel="Saving…">
          {p.hasKey ? 'Replace key' : 'Save key'}
        </SubmitButton>
      </CheckedForm>
      {p.hasKey && (
        <details className="text-sm">
          <summary className="inline-flex min-h-8 cursor-pointer items-center text-neutral-600 dark:text-neutral-400">Remove this key</summary>
          <form action={removeKeyAction} className="mt-2 space-y-2">
            <input type="hidden" name="provider" value={p.provider} />
            <p>Removing the key also removes this provider&apos;s models from the list below, and they will need a new test if you add the key again.</p>
            <SubmitButton variant="secondary" icon={null} pendingLabel="Removing…">
              Remove key
            </SubmitButton>
          </form>
        </details>
      )}
    </article>
  );
}

function ModelGroup({ provider, models }: { provider: AiProviderView; models: AiModelView[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <h3 className="border-b border-neutral-200 px-4 py-3 text-base font-medium dark:border-neutral-800">{provider.label}</h3>
      {!provider.hasKey ? (
        <p className="p-4 text-sm text-muted">Add this provider&apos;s key above to test its models.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {models.map((m) => (
            <li key={m.model} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="font-medium">{m.label}</p>
                {m.centsPerMillionIn !== null && m.centsPerMillionOut !== null && (
                  <p className="text-sm text-muted">
                    {usd(m.centsPerMillionIn)} in and {usd(m.centsPerMillionOut)} out, per million tokens (small pieces of text)
                  </p>
                )}
                {m.testNote && (
                  <p className="text-sm">
                    {m.testNote}
                    {m.testedAt ? ` (${when(m.testedAt)})` : ''}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {m.test === 'passed' ? (
                  <Badge tone="success" label={m.toolCalling ? 'Test passed, can call tools' : 'Test passed, plain answers only'} />
                ) : m.test === 'failed' ? (
                  <Badge tone="danger" label="Last test failed" />
                ) : (
                  <Badge tone="closed" label="Not tested" />
                )}
                {m.active && <Badge tone="info" label={`On, number ${m.priority}`} />}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <form action={testModelAction}>
                  <input type="hidden" name="provider" value={m.provider} />
                  <input type="hidden" name="model" value={m.model} />
                  <SubmitButton variant="secondary" icon={null} pendingLabel="Testing…">
                    Test
                  </SubmitButton>
                </form>
                {m.canActivate && (
                  <form action={activateModelAction}>
                    <input type="hidden" name="provider" value={m.provider} />
                    <input type="hidden" name="model" value={m.model} />
                    <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…">
                      Switch on
                    </SubmitButton>
                  </form>
                )}
                {m.active && (
                  <form action={deactivateModelAction}>
                    <input type="hidden" name="provider" value={m.provider} />
                    <input type="hidden" name="model" value={m.model} />
                    <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…">
                      Switch off
                    </SubmitButton>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Order({ view }: { view: AiHubView }) {
  return (
    <section className="space-y-3" aria-labelledby="order-h">
      <h2 id="order-h" className="text-lg font-semibold">
        Order tried
      </h2>
      {view.order.length === 0 ? (
        <p className="text-sm text-muted">No model is switched on yet, so AI questions are refused. Test a model above, then switch it on.</p>
      ) : (
        <>
          <p className="text-sm text-muted">The first is tried first. If it times out, is rate-limited or is down, the next one answers. The log shows which one did.</p>
          <ol className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {view.order.map((o, i) => (
              <li key={`${o.provider}/${o.model}`} className="flex flex-wrap items-center gap-3 p-3">
                <span className="w-6 text-right font-semibold tabular-nums">{o.priority}</span>
                <span className="min-w-0 flex-1 font-medium">{o.label}</span>
                {i > 0 && <MoveForm o={o} direction="up" label="Move earlier" />}
                {i < view.order.length - 1 && <MoveForm o={o} direction="down" label="Move later" />}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function MoveForm({ o, direction, label }: { o: AiHubView['order'][number]; direction: 'up' | 'down'; label: string }) {
  return (
    <form action={moveModelAction}>
      <input type="hidden" name="provider" value={o.provider} />
      <input type="hidden" name="model" value={o.model} />
      <input type="hidden" name="direction" value={direction} />
      <SubmitButton variant="secondary" icon={null} pendingLabel="Saving…">
        {label}
      </SubmitButton>
    </form>
  );
}

import { getAiHubView, type AiHubView, type AiProviderView } from '@shareat/domain';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { AI_SETTINGS_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { typedFor } from '../../../lib/keep-typing';
import { peso } from '../../../lib/format';
import { withOrgPrincipal } from '../../expenses/lib';
import { activateModelAction, removeKeyAction, saveSettingsAction, storeSwitchAction, testModelAction } from './actions';
import { FallbackOrder } from './FallbackOrder';
import { KeyEditor } from './KeyEditor';
import { TestBadge } from './model-bits';
import { AI_SETTINGS_EDIT } from './typed-forms';
import { Page } from '@/components/shell/Page';
import { EditableRecord } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Badge, Banner, Card, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';

export const metadata = { title: 'AI hub — Shareat System' };
export const dynamic = 'force-dynamic';

/** US cents per million tokens as dollars, by string surgery (no float). */
const usd = (cents: number): string => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const when = (d: Date): string => formatBusinessDateTime(d, { dateStyle: 'medium' });

/**
 * `/settings/ai-hub`. T-640 (docs/tasks/640-ai-hub.md), laid out again in T-642 (docs/tasks/642-ai-hub-screen-redesign.md). Super admin only (`manage_ai_hub`).
 *
 * Provider keys (typed here, stored encrypted, never shown back: only the last 4 characters), the fallback order of the models that are switched on, the models still to test or switch on,
 * the monthly cap and the daily limit, the AI switches, and what this month has cost. ⛔ This page never receives a key or its ciphertext: the read model has neither.
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

      {/* T-642: below lg one column in the order spend, fallback order, providers, caps, stores. From lg two columns: providers and stores on the left, a sticky right column (fallback order, spend, caps).
          `contents` makes the two wrappers vanish below lg, so the `order-*` classes can reorder the sections inside one flex column. */}
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-8">
          <section className="order-3 space-y-3 lg:order-none" aria-labelledby="providers-h">
            <h2 id="providers-h" className="text-lg font-semibold">
              Providers and keys
            </h2>
            <p className="text-sm text-muted">Paste a key from the provider. It is encrypted before it is saved and never shown again: only its last 4 characters. To change a key, press Edit and paste a new one.</p>
            <div className="space-y-3">
              {view.providers.map((p) => (
                <ProviderCard key={`${p.provider}:${p.updatedAt?.getTime() ?? 0}`} p={p} />
              ))}
            </div>
          </section>

          <section className="order-5 space-y-3 lg:order-none" aria-labelledby="stores-h">
            <h2 id="stores-h" className="text-lg font-semibold">
              Stores
            </h2>
            <p className="text-sm text-muted">Switch AI features off for one store. A store with no choice made is on.</p>
            <ul className="divide-y divide-surface-border rounded-2xl border border-surface-border">
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
        </div>

        <div className="contents lg:sticky lg:top-20 lg:-m-1 lg:flex lg:max-h-[calc(100dvh-6rem)] lg:min-w-0 lg:flex-col lg:gap-8 lg:overflow-y-auto lg:p-1">
          <div className="order-2 lg:order-none">
            <Order view={view} sync={sp.ok ?? sp.error ?? ''} />
          </div>
          <div className="order-1 lg:order-none">
            <Usage view={view} />
          </div>
          <section className="order-4 space-y-3 lg:order-none" aria-labelledby="limits-h">
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
        </div>
      </div>
    </Page>
  );
}

function Usage({ view }: { view: AiHubView }) {
  const u = view.usage;
  const bar = Math.min(u.percent, 100);
  return (
    <section className="space-y-3" aria-labelledby="usage-h">
      <h2 id="usage-h" className="text-lg font-semibold">
        This month
      </h2>
      <Card className="space-y-3">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-semibold tabular-nums">{peso(u.spentText)}</span>
          <span className="text-muted">
            of the {peso(u.capText)} cap ({u.percent}%)
          </span>
          {u.level === 'capped' ? <Badge tone="danger" label="Cap reached" /> : u.level === 'warn' ? <Badge tone="warning" label="Close to the cap" /> : <Badge tone="success" label="Within the cap" />}
        </p>
        <div role="progressbar" aria-label="Share of the monthly cap spent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar} className="h-2 overflow-hidden rounded-full bg-canvas">
          <div className={`h-full rounded-full ${u.level === 'capped' ? 'bg-danger' : u.level === 'warn' ? 'bg-warning' : 'bg-success'}`} style={{ width: `${bar}%` }} />
        </div>
        {u.level === 'capped' && <Banner tone="error">The monthly cap is reached, so every AI question is being refused until the 1st of next month. Raise the cap below to open it again.</Banner>}
        {u.level === 'warn' && <Banner tone="warning">Spending has passed {view.settings.warnAtPercent}% of the monthly cap.</Banner>}
        {u.byFeature.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been spent on AI this month.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <UsageList title="By feature" lines={u.byFeature} />
            <UsageList title="By person" lines={u.byPerson} />
          </div>
        )}
      </Card>
    </section>
  );
}

function UsageList({ title, lines }: { title: string; lines: AiHubView['usage']['byFeature'] }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="mt-1 divide-y divide-surface-border text-sm">
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
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{p.label}</h3>
        {p.hasKey ? <Badge tone="success" label="Key saved" /> : <Badge tone="closed" label="No key yet" />}
      </div>
      {p.hasKey && p.updatedAt && (
        <p className="text-sm text-muted">
          Saved by {p.setByName} on {when(p.updatedAt)}.
        </p>
      )}
      <KeyEditor provider={p.provider} providerLabel={p.label} hasKey={p.hasKey} last4={p.last4} />
      {p.hasKey && (
        <details className="text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted">Remove this key</summary>
          <form action={removeKeyAction} className="mt-2 space-y-2">
            <input type="hidden" name="provider" value={p.provider} />
            <p>Removing the key also removes this provider&apos;s models from the order, and they will need a new test if you add the key again.</p>
            <SubmitButton variant="secondary" icon={null} pendingLabel="Removing…">
              Remove key
            </SubmitButton>
          </form>
        </details>
      )}
    </Card>
  );
}

function Order({ view, sync }: { view: AiHubView; sync: string }) {
  const byKey = new Map(view.models.map((m) => [`${m.provider}/${m.model}`, m]));
  const cards = view.order.map((o) => {
    const m = byKey.get(`${o.provider}/${o.model}`);
    return { provider: o.provider, model: o.model, label: o.label, providerLabel: m?.providerLabel ?? o.provider, test: m?.test ?? 'never', toolCalling: m?.toolCalling ?? null } as const;
  });
  const idle = view.models.filter((m) => !m.active && m.hasKey);
  const keyless = view.providers.filter((p) => !p.hasKey).map((p) => p.label);
  return (
    <section className="space-y-3" aria-labelledby="order-h">
      <h2 id="order-h" className="text-lg font-semibold">
        Fallback order
      </h2>
      <p className="text-sm text-muted">
        Number 1 is tried first. If it times out, is rate-limited or is down, number 2 answers, and so on. The log shows which one did. Drag a card by its grip, or press Move earlier or Move later. A model can be switched on only after its Test passes (a tiny question with one tool); a failed test never switches off a model that already works.
      </p>
      <Card className="space-y-4">
        {cards.length === 0 ? (
          <p className="text-sm text-muted">No model is switched on yet, so AI questions are refused. Test a model below, then switch it on.</p>
        ) : (
          // the key changes with the saved order and with every flash, so a refused drag snaps back to what the server holds
          <FallbackOrder key={`${cards.map((c) => `${c.provider}/${c.model}`).join('|')}#${sync}`} cards={cards.map((c) => ({ ...c }))} />
        )}
        <div className="space-y-2">
          <h3 className="text-base font-medium">Not in use</h3>
          {idle.length === 0 ? (
            <p className="text-sm text-muted">Every model that has a key is already in the order.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {idle.map((m) => (
                <li key={`${m.provider}/${m.model}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">{m.label}</p>
                    <p className="text-sm text-muted">
                      {m.providerLabel}
                      {m.centsPerMillionIn !== null && m.centsPerMillionOut !== null ? ` · ${usd(m.centsPerMillionIn)} in and ${usd(m.centsPerMillionOut)} out, per million tokens (small pieces of text)` : ''}
                    </p>
                    {m.testNote && (
                      <p className="text-sm">
                        {m.testNote}
                        {m.testedAt ? ` (${when(m.testedAt)})` : ''}
                      </p>
                    )}
                  </div>
                  <TestBadge test={m.test} toolCalling={m.toolCalling} />
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
                  </div>
                </li>
              ))}
            </ul>
          )}
          {keyless.length > 0 && <p className="text-sm text-muted">Models of a provider appear here once its key is saved: {keyless.join(', ')}.</p>}
        </div>
      </Card>
    </section>
  );
}

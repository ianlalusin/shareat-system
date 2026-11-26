'use client';
/**
 * The shared "Copy from another store" window (T-611: hours and prices in S1, kitchen in S2, discount presets in S3). docs/tasks/611-copy-settings-between-stores.md.
 *
 * Choose the store to copy FROM, tick the stores to copy TO, decide whether different values are replaced (off by default), press Preview
 * (the server counts what would happen, nothing is written), then confirm with an administrator PIN. The browser sends choices only: the plan,
 * the gate and the PIN check are all the server's.
 */
import { useState, useTransition } from 'react';
import { Banner, Button, Checkbox, ConfirmDestructive, Field, FormGrid, FormModal, Select } from '@/components/ui';
import { copyFromStoreAction, previewCopyAction, type CopyKindName, type CopyPreviewResult } from './actions';
import type { CopyStoreChoice } from './lib';

const WORDS = {
  hours: { title: 'Copy menu hours', noun: 'menu hours', what: 'the menu hours', note: '' },
  prices: {
    title: 'Copy prices',
    noun: 'prices',
    what: 'the store prices and option prices',
    note: ' Prices already in use are never edited: a changed price is a new price from now.',
  },
  kitchen: { title: 'Copy kitchen stations', noun: 'kitchen routes', what: 'the kitchen stations and which station cooks each item', note: ' A station that is missing is created.' },
  presets: { title: 'Copy discounts', noun: 'discounts', what: 'the named discounts the cashier can pick (not the senior and PWD discounts, which are the same everywhere)', note: '' },
} as const;
const MARK = { add: 'Add', same: 'Same', different: 'Different', skip: 'Skipped' } as const;

export function CopyFromStoreDialog({ kind, currentStoreId, stores }: { kind: CopyKindName; currentStoreId: string; stores: CopyStoreChoice[] }) {
  const w = WORDS[kind];
  const [source, setSource] = useState(currentStoreId);
  const [targets, setTargets] = useState<string[]>([]);
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<CopyPreviewResult[] | null>(null);
  const [pending, start] = useTransition();
  const others = stores.filter((s) => s.id !== source);
  const picked = targets.filter((t) => others.some((s) => s.id === t));
  const changed = (fn: () => void) => {
    fn();
    setPreview(null); // a preview belongs to the choices it was made for
  };
  const runPreview = () =>
    start(async () => {
      setPreview(await previewCopyAction({ kind, sourceStoreId: source, targetStoreIds: picked, replace }));
    });
  const writes = preview?.some((p) => p.ok && p.counts.added + p.counts.replaced > 0) ?? false;

  return (
    <FormModal trigger="Copy from another store" triggerIcon={null} triggerVariant="secondary" title={w.title} size="md">
      <form action={copyFromStoreAction} className="space-y-4 text-sm">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="storeId" value={currentStoreId} />
        <p>
          Copies {w.what} from one store to the stores you tick. Nothing is removed from them, and what they already have is kept unless you ask to
          replace it.
        </p>
        <FormGrid>
          <Field label="Copy from">
            <Select name="sourceStoreId" value={source} onChange={(e) => changed(() => setSource(e.target.value))} className="mt-1 w-full">
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
        </FormGrid>
        <fieldset>
          <legend className="text-muted">Copy to</legend>
          <div className="flex flex-col">
            {others.map((s) => (
              <Checkbox
                key={s.id}
                name="targetStoreId"
                value={s.id}
                checked={targets.includes(s.id)}
                onChange={(e) => changed(() => setTargets(e.target.checked ? [...targets, s.id] : targets.filter((t) => t !== s.id)))}
                label={`${s.name} (${s.code})`}
              />
            ))}
          </div>
        </fieldset>
        <Checkbox
          name="replace"
          checked={replace}
          onChange={(e) => changed(() => setReplace(e.target.checked))}
          label={`Replace what a store already has (${w.noun} that differ)`}
        />
        <Button type="button" variant="secondary" icon={null} disabled={pending || picked.length === 0} onClick={runPreview}>
          {pending ? 'Checking...' : 'Preview'}
        </Button>

        {preview && (
          <div className="space-y-3">
            {preview.map((p) =>
              p.ok ? (
                <div key={p.storeId} className="space-y-1 rounded-[14px] border border-surface-border p-3">
                  <p className="font-medium">{p.name}</p>
                  <p>
                    {p.counts.added} to add · {p.counts.same} already the same · {p.counts.kept + p.counts.replaced} different
                    {p.counts.replaced > 0 ? ' (will be replaced)' : p.counts.kept > 0 ? ' (kept)' : ''}
                    {p.counts.skipped - p.counts.same - p.counts.kept > 0 ? ` · ${p.counts.skipped - p.counts.same - p.counts.kept} skipped` : ''}
                  </p>
                  {p.lines.length > 0 && (
                    <details>
                      <summary className="inline-flex min-h-6 cursor-pointer items-center underline underline-offset-2">See the list</summary>
                      <ul className="mt-1 max-h-60 space-y-1 overflow-auto">
                        {p.lines.map((l, i) => (
                          <li key={i}>
                            <span className="font-medium">{MARK[l.status]}</span> {l.what}
                            {l.note ? <span className="block text-muted">{l.note}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ) : (
                <Banner key={p.storeId} tone="error">
                  {p.error}
                </Banner>
              ),
            )}
            {writes ? (
              <ConfirmDestructive
                tier="admin-pin"
                label="Copy to stores"
                quiet
                consequence={`This changes ${w.noun} at the stores you ticked, as listed above.${w.note} Nothing is removed. An administrator confirms with their own PIN.`}
              />
            ) : (
              <p className="text-muted">There is nothing to copy with these choices.</p>
            )}
          </div>
        )}
      </form>
    </FormModal>
  );
}

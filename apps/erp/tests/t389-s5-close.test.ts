/**
 * T-389 S5 (close): `typed` is required on EditableRecord, the old props are gone, and DEF-633 (a restored checkbox must
 * be seen by React). Node environment: the repo has no jsdom, so the applyTyped leg runs the real function source
 * against a recording fake DOM. React's checkbox onChange listens to `click`, never to `change`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { EditableRecord } from '../src/components/forms/EditableRecord';

const base = { action: async () => {}, label: 'x', hidden: {}, children: null as ReactNode };

describe('S5 prop types', () => {
  it('K4: typed is required (a record with no typed prop does not typecheck)', () => {
    // @ts-expect-error - `typed` is required at S5
    const noTyped = createElement(EditableRecord, base);
    const withNull = createElement(EditableRecord, { ...base, typed: null });
    expect(noTyped).toBeTruthy();
    expect(withNull).toBeTruthy();
  });

  it('initialMode and storedValues no longer exist on EditableRecord', () => {
    // @ts-expect-error - dropped at S5
    const a = createElement(EditableRecord, { ...base, typed: null, initialMode: 'editing' });
    // @ts-expect-error - dropped at S5
    const b = createElement(EditableRecord, { ...base, typed: null, storedValues: {} });
    expect(a && b).toBeTruthy();
  });
});

describe('DEF-633: applyTyped restores a checkbox the React way', () => {
  it('a checked checkbox gets a click (the event React onChange listens to), not only change', async () => {
    const src = readFileSync(resolve(__dirname, '../src/components/forms/EditableRecord.tsx'), 'utf8');
    const from = src.indexOf('type DomControl');
    const to = src.indexOf('/** `useLayoutEffect` warns');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const js = ts.transpileModule(src.slice(from, to) + '\nreturn applyTyped;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const { planApply } = await import('../src/components/forms/EditableRecord');

    const events: string[] = [];
    class FakeInput {
      name = 'adoptSuggestedCode';
      type = 'checkbox';
      value = 'on';
      checked = false;
      defaultChecked = false;
      labels = null;
      dispatchEvent(e: { type: string }) { events.push(e.type); return true; }
      click() { events.push('click'); this.checked = !this.checked; }
      getAttribute() { return null; }
    }
    class Noop {}
    const el = new FakeInput();
    const form = { elements: [el] };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const applyTyped = new Function('planApply', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', js)(
      planApply, FakeInput, Noop, Noop, class { constructor(public type: string) {} },
    ) as (f: unknown, fields: Record<string, string | string[]>) => string[];
    applyTyped(form, { adoptSuggestedCode: 'on' });
    expect(events).toContain('click');
  });

  it('a checkbox inside a disabled fieldset still ends up as typed (a click on a disabled control does nothing)', async () => {
    const src = readFileSync(resolve(__dirname, '../src/components/forms/EditableRecord.tsx'), 'utf8');
    const from = src.indexOf('type DomControl');
    const to = src.indexOf('/** `useLayoutEffect` warns');
    const js = ts.transpileModule(src.slice(from, to) + ' return applyTyped;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const { planApply } = await import('../src/components/forms/EditableRecord');
    class FakeInput {
      name = 'adoptSuggestedCode';
      type = 'checkbox';
      value = 'on';
      checked = false;
      defaultChecked = false;
      disabled = true;
      labels = null;
      dispatchEvent() { return true; }
      click() { if (!this.disabled) this.checked = !this.checked; }
      getAttribute() { return null; }
    }
    class Noop {}
    const el = new FakeInput();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const applyTyped = new Function('planApply', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', js)(
      planApply, FakeInput, Noop, Noop, class { constructor(public type: string) {} },
    ) as (f: unknown, fields: Record<string, string | string[]>) => string[];
    applyTyped({ elements: [el] }, { adoptSuggestedCode: 'on' });
    expect(el.checked).toBe(true);
  });
});

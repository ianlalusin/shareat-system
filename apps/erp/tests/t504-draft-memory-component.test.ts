// @vitest-environment happy-dom
/**
 * T-504 item 10 - the DraftMemory component in a real DOM (happy-dom): typing then remount restores EVERY box into the inputs,
 * mount never overwrites a stored draft, an untouched blank box never blanks a remembered figure, Discard clears.
 * happy-dom cannot reproduce Next's hydration ordering or the browser's own form restore; the delayed re-apply that answers
 * them is pinned by a source guard at the bottom.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DraftMemory } from '../src/app/sales-days/DraftMemory';
import { draftKey, loadDraft, mergeForSave } from '../src/app/sales-days/draft-memory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = draftKey('p1', 's1', '2026-11-01');
let host: HTMLElement;
let root: Root | null = null;

function Form() {
  return h('form', null,
    h(DraftMemory, { personId: 'p1', storeId: 's1', businessDate: '2026-11-01', dateFieldName: 'businessDate' }),
    h('input', { name: 'businessDate', defaultValue: '2026-11-01' }),
    h('input', { name: 'totalSales', defaultValue: '' }),
    h('input', { name: 'channel_a', defaultValue: '' }),
    h('input', { name: 'channel_b', defaultValue: '' }),
    h('input', { type: 'checkbox', name: 'nosales_a' }));
}
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(Form)); });
}
async function unmount() { await act(async () => { root?.unmount(); }); root = null; host.remove(); }
const box = (n: string) => host.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
async function type(n: string, v: string) {
  await act(async () => { box(n).value = v; box(n).dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => { localStorage.clear(); });
afterEach(async () => { if (root) await unmount(); vi.useRealTimers(); });

describe('DraftMemory (component)', () => {
  it('typing then remount restores every field, formatted money included, into the inputs', async () => {
    await mount();
    await type('totalSales', '16,980');
    await type('channel_a', '16,980');
    await type('channel_b', '0');
    await act(async () => { box('nosales_a').checked = true; box('nosales_a').dispatchEvent(new Event('change', { bubbles: true })); });
    expect(loadDraft(localStorage, KEY)!.fields).toMatchObject({ totalSales: '16,980', channel_a: '16,980', channel_b: '0', nosales_a: 'on' });
    await unmount();
    await mount();
    expect(box('totalSales').value).toBe('16,980');
    expect(box('channel_a').value).toBe('16,980');
    expect(box('channel_b').value).toBe('0');
    expect(box('nosales_a').checked).toBe(true);
    expect(host.textContent).toContain('Restored what you typed');
  });

  it('mount alone never writes or overwrites a stored draft', async () => {
    localStorage.setItem(KEY, JSON.stringify({ fields: { businessDate: '2026-11-01', totalSales: '500' }, savedAt: '2026-11-01T10:00:00.000Z' }));
    const before = localStorage.getItem(KEY);
    await mount();
    expect(localStorage.getItem(KEY)).toBe(before);
    expect(box('totalSales').value).toBe('500');
    await unmount();
    localStorage.clear();
    await mount();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a later edit of one box keeps the remembered figures in the boxes it did not touch', async () => {
    localStorage.setItem(KEY, JSON.stringify({ fields: { businessDate: '2026-11-01', totalSales: '500', channel_a: '9' }, savedAt: '2026-11-01T10:00:00.000Z' }));
    await mount();
    box('totalSales').value = ''; // a hydration reset blanking the box behind the person's back
    await type('channel_b', '7');
    expect(loadDraft(localStorage, KEY)!.fields).toMatchObject({ totalSales: '500', channel_a: '9', channel_b: '7' });
  });

  it('puts the draft back when something blanks the boxes right after mount (delayed re-apply)', async () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, JSON.stringify({ fields: { businessDate: '2026-11-01', totalSales: '500' }, savedAt: '2026-11-01T10:00:00.000Z' }));
    await mount();
    box('totalSales').value = '';
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(box('totalSales').value).toBe('500');
  });

  it('Discard clears the draft and the banner', async () => {
    localStorage.setItem(KEY, JSON.stringify({ fields: { businessDate: '2026-11-01', totalSales: '500' }, savedAt: '2026-11-01T10:00:00.000Z' }));
    await mount();
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(host.textContent).not.toContain('Restored');
    expect(box('totalSales').value).toBe('');
  });
});

describe('mergeForSave', () => {
  it('untouched boxes keep the stored figure; touched boxes are written as they are, even cleared', () => {
    expect(mergeForSave({ a: '1', b: '2' }, { a: '', b: '' }, new Set(['b']))).toEqual({ a: '1', b: '' });
    expect(mergeForSave(null, { a: 'x' }, new Set())).toEqual({ a: 'x' });
  });
});

describe('source guard (happy-dom has no hydration ordering)', () => {
  const src = readFileSync(join(process.cwd(), 'apps/erp/src/app/sales-days/DraftMemory.tsx'), 'utf8');
  it('restores by typing-like events, re-applies after the page settles, and never dispatches a synthetic reset', () => {
    expect(src).toContain("new Event('input', { bubbles: true })");
    expect(src).toMatch(/setTimeout\(again, 250\)/);
    expect(src).not.toContain("dispatchEvent(new Event('reset'))");
    expect(src).toContain('if (applying) return;');
  });
});

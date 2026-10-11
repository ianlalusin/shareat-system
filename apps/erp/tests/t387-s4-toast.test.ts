import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-387 S4 (TESTER) - the Toaster, its pure de-dupe module, and where it is mounted. Spec: S4, L6, L7, L13.
 *
 * API pinned (builder implements exactly this):
 *   components/feedback/toast-dedupe.ts
 *     export const TOAST_SEEN_KEY: string
 *     export const TOAST_MS = 4000; export const STAMP_MS = 1200
 *     export interface SeenStore { getItem(k: string): string | null; setItem(k: string, v: string): void }
 *     export function shouldShow(token: string | null | undefined, store: SeenStore): boolean
 *     export function markShown(token: string, store: SeenStore): void
 *     export function stampAnimation(reducedMotion: boolean): 'slam' | 'fade'
 *   components/feedback/Toaster.tsx: named export `Toaster({ token?, ok?, stamp? })`. SSR renders ONLY an empty
 *     live region (role="status", aria-live="polite", present even with no props so a screen reader has it before
 *     text arrives); the ok text and stamp word appear from a client effect, never in server HTML.
 *   lib/flash-toast.ts: export async function readToastFlash(): Promise<{ token: string; ok?: string; stamp?: string } | null>
 *     (the small server helper the root layout calls).
 *   app/layout.tsx mounts <Toaster/> once; AppShell does not (L13).
 */

const SRC = resolve(__dirname, '../src');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

type Dedupe = {
  TOAST_SEEN_KEY: string;
  TOAST_MS: number;
  STAMP_MS: number;
  shouldShow: (t: string | null | undefined, s: unknown) => boolean;
  markShown: (t: string, s: unknown) => void;
  stampAnimation: (r: boolean) => string;
};
const load = async () => (await import('../src/components/feedback/toast-dedupe')) as unknown as Dedupe;

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('toast-dedupe (L7: the flash cookie replays for 60s, so dedupe on the URL token)', () => {
  it('shows a token once', async () => {
    const d = await load();
    const s = memStore();
    expect(d.shouldShow('tok1', s)).toBe(true);
    d.markShown('tok1', s);
    expect(d.shouldShow('tok1', s)).toBe(false);
    expect(d.shouldShow('tok1', s)).toBe(false);
  });

  it('a different token shows again; the first stays suppressed', async () => {
    const d = await load();
    const s = memStore();
    d.markShown('tok1', s);
    expect(d.shouldShow('tok2', s)).toBe(true);
    d.markShown('tok2', s);
    expect(d.shouldShow('tok1', s)).toBe(false);
    expect(d.shouldShow('tok2', s)).toBe(false);
  });

  it.each([null, undefined, ''])('no token (%j) never shows', async (t) => {
    const d = await load();
    expect(d.shouldShow(t as never, memStore())).toBe(false);
  });

  it('is keyed in storage under TOAST_SEEN_KEY, so a second page load (same storage) still dedupes', async () => {
    const d = await load();
    const s = memStore();
    d.markShown('tok1', s);
    expect([...s.m.keys()]).toEqual([d.TOAST_SEEN_KEY]);
    expect(s.m.get(d.TOAST_SEEN_KEY)).toContain('tok1');
  });

  it('survives a corrupt stored value (treated as nothing seen) and a throwing store (never throws)', async () => {
    const d = await load();
    const bad = memStore();
    bad.m.set(d.TOAST_SEEN_KEY, '{not json');
    expect(() => d.shouldShow('tok1', bad)).not.toThrow();
    expect(d.shouldShow('tok1', bad)).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => d.shouldShow('tok1', throwing)).not.toThrow();
    expect(() => d.markShown('tok1', throwing)).not.toThrow();
  });

  it('the seen list is bounded (a long session cannot grow storage without limit)', async () => {
    const d = await load();
    const s = memStore();
    for (let i = 0; i < 500; i++) d.markShown(`t${i}`, s);
    expect((s.m.get(d.TOAST_SEEN_KEY) ?? '').length).toBeLessThan(8000);
    expect(d.shouldShow('t499', s)).toBe(false); // the newest is still remembered
  });

  it('timings come from the Feedback board: toast 4s, stamp 1.2s', async () => {
    const d = await load();
    expect(d.TOAST_MS).toBe(4000);
    expect(d.STAMP_MS).toBe(1200);
  });

  it('reduced motion skips the slam and fades instead', async () => {
    const d = await load();
    expect(d.stampAnimation(false)).toBe('slam');
    expect(d.stampAnimation(true)).toBe('fade');
  });
});

describe('Toaster SSR', () => {
  const render = async (props: Record<string, unknown>) => {
    const mod = (await import('../src/components/feedback/Toaster')) as unknown as { Toaster: unknown };
    return renderToStaticMarkup(createElement(mod.Toaster as never, props as never));
  };

  it('renders the polite status live region, with the ok text and stamp word NOT in server HTML', async () => {
    const html = await render({ token: 'tok1', ok: 'Expense posted to the books.', stamp: 'POSTED' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Expense posted');
    expect(html).not.toContain('POSTED');
  });

  it('with no props it still renders the (empty) live region', async () => {
    const html = await render({});
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it('is a client component', () => {
    expect(read('components/feedback/Toaster.tsx').trimStart().startsWith("'use client'")).toBe(true);
  });

  it('uses the pure module for its decisions (no inline dedupe logic of its own)', () => {
    const src = read('components/feedback/Toaster.tsx');
    expect(src).toMatch(/from '\.\/toast-dedupe'/);
    expect(src).toMatch(/shouldShow\(/);
    expect(src).toMatch(/markShown\(/);
    expect(src).toMatch(/stampAnimation\(/);
  });
});

describe('mounting (L13) and the server helper', () => {
  it('layout.tsx mounts <Toaster> once, fed by readToastFlash from lib/flash-toast, outside AppShell', () => {
    const src = read('app/layout.tsx');
    expect(src.match(/<Toaster\b/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/readToastFlash/);
    expect(src).toMatch(/lib\/flash-toast/);
    // inside <body>, and outside AppShell so sign-in and the kiosk (bare children) still get toasts
    const body = src.slice(src.indexOf('<body>'), src.indexOf('</body>'));
    const shell = body.slice(body.indexOf('<AppShell>'), body.indexOf('</AppShell>'));
    expect(body).toMatch(/<Toaster\b/);
    expect(shell).not.toMatch(/<Toaster\b/);
  });

  it('AppShell does not mount it', () => {
    expect(read('components/shell/AppShell.tsx')).not.toMatch(/Toaster/);
  });

  it('lib/flash-toast.ts exports readToastFlash and is server-side (no use client)', () => {
    const src = read('lib/flash-toast.ts');
    expect(src).toMatch(/export async function readToastFlash/);
    expect(src).not.toMatch(/'use client'/);
  });
});

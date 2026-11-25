/**
 * T-641 S3 - the Ask ERP button and panel (docs/tasks/641-ask-erp.md). Source-level and render guards, no browser (this was written without one; see the task's "As built").
 *
 *  1. The panel's two limits are the domain's two limits (500 characters, ten turns kept).
 *  2. The server action returns data, never a redirect (a chat reply is not a page change; nothing typed goes into an address), and reaches the model only through `askErp`.
 *  3. `AppShell` mounts the launcher only for a person who holds `use_ask_erp`, inside the authenticated branch that /pos, /clock and sign-in never reach.
 *  4. The closed panel is one named button, and the open one keeps the question box, the count and the links.
 * Named `.test.ts` (createElement, no JSX): the unit project's include glob is `apps/**\/*.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/ask-erp/actions', () => ({ askErpAction: vi.fn() }));

import { AskErpLauncher } from '../src/components/ask-erp/AskErpLauncher';
import { MAX_HISTORY_TURNS, MAX_QUESTION_CHARS } from '@shareat/domain';

const read = (rel: string) => readFileSync(join(import.meta.dirname, '..', 'src', rel), 'utf8');
const panel = read('components/ask-erp/AskErpLauncher.tsx');
const action = read('app/ask-erp/actions.ts').replace(/\/\*[\s\S]*?\*\//g, ''); // code only: the header comment talks about redirects
const shell = read('components/shell/AppShell.tsx');

describe('T-641 the panel and the domain agree on the limits', () => {
  it('the question limit and the turns kept are the domain\'s numbers [kills: a panel that allows a question the server refuses]', () => {
    expect(Number(/const MAX_QUESTION_CHARS = (\d+);/.exec(panel)?.[1])).toBe(MAX_QUESTION_CHARS);
    expect(Number(/const KEEP_TURNS = (\d+);/.exec(panel)?.[1])).toBe(MAX_HISTORY_TURNS);
    expect(MAX_QUESTION_CHARS).toBe(500);
    expect(MAX_HISTORY_TURNS).toBe(10);
  });
  it('the question box is limited and counted [kills: a box with no limit or no count]', () => {
    expect(panel).toContain('maxLength={MAX_QUESTION_CHARS}');
    expect(panel).toMatch(/\{text\.length\}\/\{MAX_QUESTION_CHARS\}/);
  });
});

describe('T-641 the action returns data and goes through askErp', () => {
  it('it is a server action, calls askErp, and never redirects or sets a flash [kills: a typed question in an address]', () => {
    expect(action.startsWith("'use server';")).toBe(true);
    expect(action).toMatch(/await askErp\(/);
    expect(action).not.toMatch(/redirect|redirectWithFlash|flash/i);
    expect(action).toMatch(/requireActor\(/);
  });
  it('the actor is the signed-in person, never a value from the browser [kills: a client-supplied actor]', () => {
    expect(action).not.toMatch(/orgId:\s*(question|history)|personId:/);
    expect(action).toMatch(/const actor = await requireActor/);
  });
  it('a failure comes back as one sentence, not an exception [kills: a stack trace in the panel]', () => {
    expect(action).toMatch(/catch \(err\)[\s\S]*errorMessage\(err\)/);
  });
});

describe('T-641 where the button is mounted', () => {
  it('AppShell mounts it only when use_ask_erp is held, after the early return that sign-in, /clock and /pos take [kills: a button for people who may not ask; a button on the kiosk]', () => {
    expect(shell).toMatch(/\.has\('use_ask_erp'\) \? <AskErpLauncher \/> : null/);
    const early = shell.indexOf('return <>{children}</>;');
    const mount = shell.indexOf('<AskErpLauncher />');
    expect(early).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(early);
  });
});

describe('T-641 what is rendered', () => {
  it('closed: one button named "Ask ERP", no panel [kills: a panel open on arrival]', () => {
    const html = renderToStaticMarkup(h(AskErpLauncher));
    expect(html).toContain('Ask ERP');
    expect(html).not.toContain('<aside');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it('the open panel keeps the house components, the limit, the count and the source links [kills: a hand-rolled panel that drops them]', () => {
    expect(panel).toMatch(/import \{ Banner, Button, Textarea \} from '@\/components\/ui'/);
    expect(panel).toContain('NAV_LINK');
    expect(panel).toContain('role="log"');
    expect(panel).toContain('aria-label="Ask ERP"');
    expect(panel).not.toMatch(/<button\b/);
  });
});

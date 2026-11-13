// @vitest-environment happy-dom
/**
 * T-568 S4 (audit UI-002): a long action label must not starve the message at 320 px. happy-dom has no layout engine, so this
 * asserts the structure that makes the browser do the right thing: the toast wraps, the message is shrinkable with a basis and
 * breaks long tokens, and the action pill may shrink and wrap while it keeps its arrow cell.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster } from '@/components/ui/toaster';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.replaceChildren();
});

describe('POS toast at a narrow width', () => {
  it('lets the message shrink and wrap, and the action pill shrink and wrap, without losing the arrow', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Fragment, null, h(Toaster))); });
    await act(async () => {
      toast({
        title: 'Settlement needs a look: ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        description: 'Check the days below.',
        action: h(ToastAction, { altText: 'Review every affected record' }, 'Review every affected record') as never,
      });
    });
    const li = document.querySelector<HTMLElement>('li[data-state]')!;
    expect(li.className).toContain('flex-wrap');
    const message = li.querySelector<HTMLElement>('.grid')!;
    for (const c of ['min-w-0', 'flex-1', 'basis-40', 'break-words']) expect(message.className, c).toContain(c);
    const action = [...li.querySelectorAll<HTMLElement>('button')].find((b) => /Review every/.test(b.textContent ?? ''))!;
    for (const c of ['min-w-0', 'max-w-full', 'shrink', 'whitespace-normal', 'min-h-9', "after:content-['→']", 'pr-11']) expect(action.className, c).toContain(c);
    expect(action.className).not.toContain('shrink-0');
    expect(action.className).not.toMatch(/(^|\s)h-9(\s|$)/);
  });
});

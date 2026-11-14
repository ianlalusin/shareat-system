// @vitest-environment happy-dom
/**
 * T-568 S4 (audit UI-003): a long reference in the ERP flash toast must wrap inside the toast, not run off a clipped box.
 * happy-dom cannot measure width, so this asserts the structure that lets the browser wrap it (shrinkable flex item that
 * breaks anywhere) on the real Toaster.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster } from '../src/components/feedback/Toaster';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = undefined; document.body.replaceChildren(); });

describe('ERP Toaster with a long token', () => {
  it('the text is a shrinkable, anywhere-breaking flex item inside a shrinkable toast', async () => {
    Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const token = 'Recorded settlement ' + 'GRAB-2026-11-09-SETTLEMENT-REFERENCE-'.repeat(8);
    await act(async () => { root!.render(h(Toaster, { token: 'tok-1', ok: token })); });
    const ticket = document.querySelector<HTMLElement>('[data-toast-variant="ticket"]')!;
    expect(ticket, 'the ticket toast did not render').not.toBeNull();
    expect(ticket.className).toContain('min-w-0');
    const text = [...ticket.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent?.includes('GRAB-2026'))!;
    for (const c of ['min-w-0', 'break-words', '[overflow-wrap:anywhere]']) expect(text.className, c).toContain(c);
  });
});

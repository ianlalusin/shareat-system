// @vitest-environment happy-dom
/**
 * T-568 S3 (audit UI-004, UI-005): the "Release terminal" question is a toast with one explicit action.
 * Real TerminalSection + real Toaster, data ports mocked. `.ts` on purpose (POS include is src/**\/*.test.ts), so createElement stands in for JSX.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({
  auth: { appUser: { uid: 'manager-a', role: 'manager', isPlatformAdmin: false } as Record<string, unknown> | null },
  store: { activeStore: { id: 'store-a', code: 'AAA', name: 'Alpha Lipa' } as Record<string, unknown> | null },
  release: vi.fn(async () => undefined),
}));
vi.mock('@/context/auth-context', () => ({ useAuthContext: () => m.auth }));
vi.mock('@/context/store-context', () => ({ useStoreContext: () => m.store }));
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }));
vi.mock('@/lib/offline/browserDevice', () => ({ getBrowserDeviceId: () => 'device-1' }));
vi.mock('@/lib/terminal/counter', () => ({ readTerminal: async () => null, formatTerminalReceiptNumber: () => 'X' }));
vi.mock('@/lib/terminal/port', () => ({ getFirestorePort: () => ({}) }));
vi.mock('@/lib/terminal/claim', () => ({ checkTerminalHolder: async () => 'mine', claimTerminal: async () => ({ terminalNo: 1 }), releaseTerminal: m.release }));

import { TerminalSection } from './TerminalSection';
import { Toaster } from '@/components/ui/toaster';

let root: Root;
let host: HTMLElement;
const tree = () => h(Fragment, null, h(TerminalSection), h(Toaster));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  m.release.mockClear();
  m.auth.appUser = { uid: 'manager-a', role: 'manager', isPlatformAdmin: false };
  m.store.activeStore = { id: 'store-a', code: 'AAA', name: 'Alpha Lipa' };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(tree()); });
  const input = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, '1'); input.dispatchEvent(new Event('input', { bubbles: true })); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

const askToRelease = async () => {
  const open = [...host.querySelectorAll('button')].find((b) => /Release this terminal number/.test(b.textContent ?? ''))!;
  await act(async () => { open.click(); });
  await flush();
};
const actionButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Release') ?? null;

describe('Release terminal question', () => {
  it('names the store in its label and does nothing until the action is pressed', async () => {
    await askToRelease();
    expect(document.body.textContent).toContain('Release terminal 01 at Alpha Lipa?');
    expect(actionButton()?.getAttribute('aria-label') ?? document.body.innerHTML).toContain('Release terminal 01 at Alpha Lipa');
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a double click on the action sends ONE release (UI-005)', async () => {
    await askToRelease();
    const action = actionButton()!;
    await act(async () => { action.click(); action.click(); });
    await flush();
    expect(m.release).toHaveBeenCalledTimes(1);
    expect(m.release).toHaveBeenCalledWith({}, { storeId: 'store-a', terminalNo: 1, uid: 'manager-a' });
  });

  it('switching store invalidates the open question (UI-004)', async () => {
    await askToRelease();
    const action = actionButton()!;
    m.store.activeStore = { id: 'store-b', code: 'BBB', name: 'Beta Tanauan' };
    await act(async () => { root.render(tree()); });
    await act(async () => { action.click(); });
    await flush();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a different signed-in person invalidates it too', async () => {
    await askToRelease();
    const action = actionButton()!;
    m.auth.appUser = { uid: 'cashier-z', role: 'manager', isPlatformAdmin: false };
    await act(async () => { root.render(tree()); });
    await act(async () => { action.click(); });
    await flush();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('leaving the screen invalidates it', async () => {
    await askToRelease();
    const action = actionButton()!;
    await act(async () => { root.render(h(Toaster)); });
    await act(async () => { action.click(); });
    await flush();
    expect(m.release).not.toHaveBeenCalled();
  });
});

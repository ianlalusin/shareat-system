// @vitest-environment happy-dom
/**
 * T-526b audit fix - the phone avatar panel in PosShell is a plain disclosure with managed focus. Rendered for real in happy-dom (this file only; the other
 * t526 tests are node-only): opening it puts focus on its first item, Escape or a tap outside closes it and returns focus to the avatar button.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/app/sign-in/actions', () => ({ signOutAction: vi.fn() }));
vi.mock('@/app/pos/_shell/use-pos-state', () => ({ usePosState: () => ({ body: null, failures: 0, online: true }) }));
vi.mock('@/app/pos/_shell/use-device-sync', () => ({
  useDeviceSync: () => ({ offlineActor: null, setOfflineActor: () => undefined, pending: 0, sending: false, conflicts: 0, clearConflicts: () => undefined, needsInternet: false, unpaired: false }),
}));
vi.mock('@/app/pos/_shell/SwitchCashierDialog', () => ({ SwitchCashierDialog: () => null }));

import { PosShell } from '@/app/pos/_shell/PosShell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(PosShell, {
        person: { personId: 'p1', displayName: 'Carla Cashier' },
        heldPos: ['record_sale'],
        stores: [{ id: 's1', name: 'Lipa' }],
        pairedStoreId: 's1',
        erpHref: '/cash-requests',
        children: createElement('p', null, 'body'),
      }),
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const avatar = () => host.querySelector<HTMLButtonElement>('button[aria-controls]')!;
const panel = () => host.querySelector<HTMLElement>('[aria-label="Account"]');

describe('T-526b - the phone avatar panel', () => {
  it('starts closed: a labelled button with aria-expanded=false pointing at the panel it will open', () => {
    expect(avatar()).toBeTruthy();
    expect(avatar().getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
  });

  it('opening it moves focus to the first item; it is a plain region, with no menu roles anywhere', async () => {
    await act(async () => avatar().click());
    expect(avatar().getAttribute('aria-expanded')).toBe('true');
    expect(panel()!.id).toBe(avatar().getAttribute('aria-controls'));
    const first = panel()!.querySelector<HTMLElement>('[data-menu-item]')!;
    expect(first.textContent).toBe('Switch cashier');
    expect(document.activeElement).toBe(first);
    expect(host.querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
    expect(panel()!.getAttribute('role')).toBe('region');
    expect(panel()!.querySelector('[data-menu-item][href="/cash-requests"]')).toBeTruthy(); // the ERP link is there too
  });

  it('Escape closes it and returns focus to the avatar button', async () => {
    await act(async () => avatar().click());
    expect(document.activeElement).not.toBe(avatar());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(avatar().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(avatar());
  });

  it('a tap outside closes it and returns focus to the avatar button; a tap inside does not close it', async () => {
    await act(async () => avatar().click());
    await act(async () => {
      panel()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(avatar());
  });
});

/**
 * T-526 R3 (planner ruling, 7 Nov) - what the state poll's HTTP answers mean: 401 is "signed out" (the server answered, so NOT offline), 403 keeps
 * the last state and says access was lost, network failures and 5xx stay "offline after 2 in a row". Pure reducer + injected fetch.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { initialPosState, pollPosState, reducePosState } from '@/app/pos/_shell/pos-state';
import { statusPillLabel } from '@/app/pos/_shell/status-pill';
import { POS_STORE_ACCESS_LOST } from '@/app/pos/_shell/messages';

const body = { stateVersion: 7, openStands: [], kitchenQueue: [], refillQueue: [] };
const STORE = '11111111-1111-4111-8111-111111111111';
const deps = (status: number) => ({
  fetch: vi.fn(async () => new Response(status === 200 ? JSON.stringify(body) : null, { status })) as unknown as typeof fetch,
  storeId: STORE,
  visibilityState: () => 'visible' as const,
});
const had = reducePosState(initialPosState, { type: 'ok', body });

describe('T-526 - 401: signed out, not offline', () => {
  it('a 401 marks signedOut, keeps the body, stays online, and never counts toward offline (even 3 in a row)', async () => {
    let s = had;
    for (let i = 0; i < 3; i++) s = await pollPosState(deps(401), s);
    expect(s).toMatchObject({ signedOut: true, online: true, failures: 0 });
    expect(s.body).toBe(had.body);
    expect(s.forbidden).toBeUndefined();
  });
  it('the pill says "Signed out", ahead of Online and Offline', () => {
    expect(statusPillLabel({ online: true, sending: false, pending: 0, offlineForMs: 0, signedOut: true })).toBe('Signed out');
    expect(statusPillLabel({ online: true, sending: false, pending: 0, offlineForMs: 0 })).toBe('Online');
  });
  it('control: a later 200 clears it', async () => {
    const s = await pollPosState(deps(200), await pollPosState(deps(401), had));
    expect(s.signedOut).toBeUndefined();
    expect(s).toMatchObject({ online: true, failures: 0 });
  });
  it('the shell has a Sign in again button that calls signOutAction, and the drain gate does not look at signedOut (the outbox keeps sending)', () => {
    const shell = readFileSync('apps/erp/src/app/pos/_shell/PosShell.tsx', 'utf8');
    expect(shell).toMatch(/Sign in again/);
    expect(shell).toMatch(/signedOut[\s\S]{0,400}signOutAction/);
    expect(readFileSync('apps/erp/src/app/pos/_shell/use-device-sync.ts', 'utf8')).not.toContain('signedOut');
  });
});

describe('T-526 - 403: access lost', () => {
  it('a 403 keeps the last state, stays online, and flags forbidden', async () => {
    const s = await pollPosState(deps(403), had);
    expect(s).toMatchObject({ forbidden: true, online: true, failures: 0 });
    expect(s.body).toBe(had.body);
    expect(s.signedOut).toBeUndefined();
  });
  it('the sentence is exact and the shell shows it in a Banner', () => {
    expect(POS_STORE_ACCESS_LOST).toBe("You no longer have access to this store's POS.");
    expect(readFileSync('apps/erp/src/app/pos/_shell/PosShell.tsx', 'utf8')).toMatch(/state\.forbidden[\s\S]{0,80}POS_STORE_ACCESS_LOST/);
  });
  it('control: a later 200 clears it', async () => {
    expect((await pollPosState(deps(200), await pollPosState(deps(403), had))).forbidden).toBeUndefined();
  });
});

describe('T-526 - 5xx and network failures stay "offline after 2 in a row"', () => {
  it('500 then 503: first still online, second offline; no signedOut or forbidden flag', async () => {
    const one = await pollPosState(deps(500), had);
    expect(one).toMatchObject({ failures: 1, online: true });
    const two = await pollPosState(deps(503), one);
    expect(two).toMatchObject({ failures: 2, online: false });
    expect(two.signedOut).toBeUndefined();
    expect(two.forbidden).toBeUndefined();
  });
  it('a 401 between two 5xx resets the streak (the server answered)', async () => {
    const s = await pollPosState(deps(500), await pollPosState(deps(401), await pollPosState(deps(500), had)));
    expect(s).toMatchObject({ failures: 1, online: true });
  });
});

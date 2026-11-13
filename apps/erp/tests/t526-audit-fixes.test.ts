/**
 * T-526 audit fixes (7 Nov 2026): promote only after a tablet-PIN sign-in, restore the offline actor only offline and with a verifier, validate the
 * snapshot body before it is saved, verifier iteration bounds, and the pure store rule. Written with the fixes.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dev } = vi.hoisted(() => ({
  dev: {
    putVerifier: vi.fn(async () => undefined),
    saveSnapshot: vi.fn(async () => undefined),
    touchSnapshot: vi.fn(async () => undefined),
    readSnapshot: vi.fn(async (): Promise<unknown> => null),
    resumeAbove: vi.fn(async () => undefined),
    bindPairing: vi.fn(async (_id: string) => undefined), // T-563
    listVerifiers: vi.fn(async (): Promise<unknown[]> => []),
    deleteVerifier: vi.fn(async (_personId: string): Promise<void> => undefined),
  },
}));
vi.mock('@/lib/pos-device', () => dev);

import { POS_PENDING_VERIFIER_KEY, promoteAfterTabletSignIn } from '@/app/pos/_shell/pending-verifier';
import { restoredOfflineActor } from '@/app/pos/_shell/offline-actor';
import { isSnapshotBody, refreshSnapshot } from '@/app/pos/_shell/snapshot-sync';
import { POS_VERIFIER_ITERATIONS, POS_VERIFIER_MAX_ITERATIONS, deriveVerifier, verifyPin } from '@/lib/pos-device/pin-verifier';
import { effectiveStore } from '@/app/pos/lib';

const NOW = 1_800_000_000_000;
const staff = [
  { personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale'] },
  { personId: 'p-ben', displayName: 'Ben Reyes', employeeId: '012', posCapabilities: ['serve_pos_ticket'] },
];
const src = (p: string) => readFileSync(`apps/erp/src/${p}`, 'utf8');

function storage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
function jar(present: boolean) {
  const j = { present, cleared: 0, has: () => j.present, clear: () => void ((j.present = false), j.cleared++) };
  return j;
}
const pending = (employeeId: string, v: { salt: string; hash: string; iterations: number }) => JSON.stringify({ employeeId, ...v, createdAtMs: NOW - 1000 });

beforeEach(() => Object.values(dev).forEach((f) => 'mockClear' in f && f.mockClear()));

describe('audit 1 - a verifier is promoted only after a tablet-PIN sign-in', () => {
  it('a mistyped PIN leaves a pending entry; a manager email sign-in sets no promote flag: nothing is promoted, the entry is deleted', async () => {
    const v = await deriveVerifier('111111');
    const s = storage();
    s.setItem(POS_PENDING_VERIFIER_KEY, pending('007', v));
    await promoteAfterTabletSignIn({ storage: s, jar: jar(false), staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).not.toHaveBeenCalled();
    expect(s.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  }, 30_000);

  it('control: with the flag the same pending entry IS promoted, and both the flag and the entry are deleted', async () => {
    const v = await deriveVerifier('222222');
    const s = storage();
    s.setItem(POS_PENDING_VERIFIER_KEY, pending('007', v));
    const j = jar(true);
    await promoteAfterTabletSignIn({ storage: s, jar: j, staff, personId: 'p-ana', nowMs: NOW });
    expect(dev.putVerifier).toHaveBeenCalledTimes(1);
    expect(j.cleared).toBe(1);
    expect(s.getItem(POS_PENDING_VERIFIER_KEY)).toBeNull();
  }, 30_000);

  it('the flag is set only by the tablet-PIN action, as a short, non-secret, /pos-scoped cookie', () => {
    const actions = src('app/sign-in/actions.ts');
    const body = (name: string) => {
      const at = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf('\nexport async function ', at + 10);
      return actions.slice(at, next === -1 ? undefined : next);
    };
    expect(body('signInWithTabletPinAction')).toContain('setPosPromoteCookie');
    for (const other of ['signInWithEmailAction', 'signInWithTerminalPinAction']) expect(body(other), other).not.toContain('setPosPromoteCookie');
    const session = src('lib/session.ts');
    const at = session.indexOf('export async function setPosPromoteCookie');
    const fn = session.slice(at, session.indexOf('\n}', at));
    expect(fn).toMatch(/httpOnly: false/);
    expect(fn).toMatch(/sameSite: 'lax'/);
    expect(fn).toMatch(/path: '\/pos'/);
    expect(fn).toMatch(/maxAge: 300/);
  });

  it('the sign-in form clears any pending verifier when it opens and when the manager form is chosen', () => {
    const form = src('app/sign-in/TabletSignInForm.tsx');
    expect(form).toMatch(/useEffect\(clearPending/);
    expect(form).toMatch(/clearPending\(\);\s*setManager\(true\)/);
  });
  it('clearPending also expires the promote cookie, with the same name and path the shell deletes it by', () => {
    const form = src('app/sign-in/TabletSignInForm.tsx');
    const at = form.indexOf('const clearPending');
    const fn = form.slice(at, form.indexOf('useEffect(clearPending', at));
    expect(fn).toContain("document.cookie = 'shareat_pos_promote=; path=/pos; max-age=0'");
  });
});

describe('audit 2 - the offline actor is restored only offline, on a usable snapshot, with the verifier still on the device', () => {
  const ok = { raw: JSON.stringify({ personId: 'p-ana' }), online: false, snapshotUsable: true, staff, verifierPersonIds: new Set(['p-ana']) };
  it('positive control: all conditions hold', () => {
    expect(restoredOfflineActor(ok)).toEqual({ personId: 'p-ana', displayName: 'Ana Cruz', posCapabilities: ['record_sale'] });
  });
  it('never while online', () => expect(restoredOfflineActor({ ...ok, online: true })).toBeNull());
  it('not when the verifier is gone (revoked or expired)', () => {
    expect(restoredOfflineActor({ ...ok, verifierPersonIds: new Set(['p-ben']) })).toBeNull();
    expect(restoredOfflineActor({ ...ok, verifierPersonIds: new Set() })).toBeNull();
  });
  it('not on an expired snapshot, not for someone off the staff list, not for junk', () => {
    expect(restoredOfflineActor({ ...ok, snapshotUsable: false })).toBeNull();
    expect(restoredOfflineActor({ ...ok, staff: [staff[1] as (typeof staff)[number]] })).toBeNull();
    for (const raw of [null, '', '{not json', 'null', '{"personId":5}']) expect(restoredOfflineActor({ ...ok, raw }), String(raw)).toBeNull();
  });
});

describe('audit 3 - a 200 with the wrong shape is a failed fetch: the cache is kept', () => {
  const good = { ok: true, staff, device: { pairingId: 'p', lastSeq: 4, lastTerminalSeq: 2 }, rules: { vatPercentBasisPoints: 1200 } };
  const run = (body: unknown) =>
    refreshSnapshot({ fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { etag: '"x"' } })) as unknown as typeof fetch, nowMs: NOW });

  it('positive control: the good shape is saved', async () => {
    expect((await run(good)).kind).toBe('updated');
    expect(dev.saveSnapshot).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['staff not an array', { ...good, staff: 'x' }],
    ['a staff member without a capability list', { ...good, staff: [{ personId: 'a', employeeId: '1', displayName: 'A' }] }],
    ['device missing', { ...good, device: undefined }],
    ['lastSeq a string', { ...good, device: { ...good.device, lastSeq: '4' } }],
    ['lastTerminalSeq missing', { ...good, device: { pairingId: 'p', lastSeq: 4 } }],
    ['rules absent', { ok: true, staff, device: good.device }],
    ['a bare string', 'oops'],
    ['null', null],
  ])('%s: failed, nothing saved, no counters moved, no verifier deleted', async (_n, body) => {
    expect((await run(body)).kind).toBe('failed');
    expect(isSnapshotBody(body)).toBe(false);
    expect(dev.saveSnapshot).not.toHaveBeenCalled();
    expect(dev.resumeAbove).not.toHaveBeenCalled();
    expect(dev.deleteVerifier).not.toHaveBeenCalled();
  });
});

describe('audit 7 - verifier iteration bounds', () => {
  it('a record claiming more than 2,000,000 iterations is refused unrun (false, fast)', async () => {
    expect(POS_VERIFIER_MAX_ITERATIONS).toBe(2_000_000);
    const t = Date.now();
    expect(await verifyPin('123456', { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'AAAA', iterations: POS_VERIFIER_MAX_ITERATIONS + 1 })).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('control: the floor itself still verifies', async () => {
    const v = await deriveVerifier('123456');
    expect(v.iterations).toBe(POS_VERIFIER_ITERATIONS);
    expect(await verifyPin('123456', v)).toBe(true);
  }, 30_000);
});

describe('audit 5 - effectiveStore: the pairing wins', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  it('paired at A: no request or the same store is fine; ?storeId=B is refused', () => {
    expect(effectiveStore({ storeId: A }, undefined)).toEqual({ storeId: A, refused: false });
    expect(effectiveStore({ storeId: A }, A.toUpperCase())).toEqual({ storeId: A, refused: false });
    expect(effectiveStore({ storeId: A }, B)).toEqual({ storeId: A, refused: true });
  });
  it('unpaired: the request is used as given; none means none', () => {
    expect(effectiveStore(null, B)).toEqual({ storeId: B, refused: false });
    expect(effectiveStore(null, undefined)).toEqual({ storeId: null, refused: false });
  });
});

describe('audit 6/7 - source promises', () => {
  it('no store at all renders the page (its own refusal), not a shell sentence', () => {
    const shell = src('app/pos/_shell/PosShell.tsx');
    expect(shell).toMatch(/storeId \|\| stores\.length === 0/);
    expect(shell).not.toContain('You do not work at any store');
  });
  it('the placeholder id is a slug', () => {
    expect(src('app/pos/_shell/SlicePlaceholder.tsx')).toMatch(/replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/);
  });
  it('no non-null assertion is left in the shell, the verifier or the pages', () => {
    for (const f of ['lib/pos-device/pin-verifier.ts', 'app/pos/_shell/PosShell.tsx', 'app/pos/_shell/offline-switch.ts', 'app/pos/lib.ts', 'app/pos/layout.tsx']) {
      expect(src(f).replace(/\/\/.*$/gm, '').match(/[\w\])]!(?![=])[.[)]/g), f).toBeNull();
    }
  });
});

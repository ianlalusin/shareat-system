import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeStoreReversal } from '@shareat/domain';
import { FLASH_COOKIE, captureRedirect, currentJar, resetJar } from './helpers/flash-jar';

/**
 * T-380 S2 - REV-6's size measurement (spec R8): the longest `confirm` + `plan` the domain can produce,
 * measured as the real signed cookie `redirectWithFlash` writes. Budget: 3,000 bytes with `keep`
 * dropped; a browser silently drops a cookie over 4 KB, which would make the confirm step vanish.
 *
 * The sentence shapes are the domain's own (copied, not imported, because `describeReversal` is not
 * exported from `@shareat/domain`):
 *  - `setStoreOpeningDate` (packages/domain/src/stores/service.ts:361-363):
 *      `${store} - moving the opening date reverses depreciation for ${n} asset(s): ${asset} - ${count}
 *       depreciation entries (${first}-${last}), ${total}; ...; confirm to proceed`
 *  - `setAssetInService` (fixed-assets/in-service.ts:210): ONE asset, so always the small case.
 * `plan` is `planToken()`: 16 hex characters (in-service.ts:121).
 *
 * Mutant: lower MAX_COOKIE_BYTES in flash.ts, or truncate `confirm` -> the fit test or the
 * byte-for-byte test goes red.
 *
 * Red on HEAD? No: this measures flash.ts alone (S1a, committed); it is green or it is a spec defect.
 */

vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

const BASE = {
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
};
type Flash = typeof import('../src/lib/flash');
let flash: Flash;

beforeAll(async () => {
  process.env = { ...process.env, ...BASE } as unknown as NodeJS.ProcessEnv;
  flash = (await import('@/lib/flash')) as Flash;
}, 60_000);
beforeEach(() => resetJar());

const PLAN = 'a1b2c3d4e5f60718';

/** The store opening-date confirm sentence for `n` affected assets, built by the DOMAIN's own function. */
function storeConfirm(n: number, nameLen: number, entries: number): string {
  const affected = Array.from({ length: n }, (_, i) => ({
    name: `Asset ${i} `.padEnd(nameLen, 'x'),
    toReverse: Array.from({ length: entries }, (_, k) => ({
      period: `${2026 + Math.floor((2 + k) / 12)}-${String(((2 + k) % 12) + 1).padStart(2, '0')}`,
      entryId: `00000000-0000-4000-8000-${String(i * 100 + k).padStart(12, '0')}`,
      amount: '34293.55',
    })),
  }));
  return (
    `Shareat Lipa Branch — moving the opening date reverses depreciation for ${n} asset(s): ` +
    `${describeStoreReversal(affected)}; confirm to proceed`
  );
}

async function cookieBytes(confirm: string, withKeep: boolean): Promise<{ bytes: number; stored: string | undefined }> {
  resetJar();
  await captureRedirect(() =>
    flash.redirectWithFlash(
      '/admin/stores/3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
      {},
      { confirm, plan: PLAN, ...(withKeep ? { keep: { openingDate: '2026-13-40' } } : {}) },
    ),
  );
  const raw = currentJar().get(FLASH_COOKIE)?.value;
  return { bytes: raw ? Buffer.byteLength(raw) : 0, stored: raw };
}

describe('REV-6 - the worst-case confirm + plan cookie (S2-R1: at most 10 assets are named)', () => {
  it('25 and 100 affected assets (30-char names, 36 entries each): the full cookie, keep included, stays under 3,000 bytes', async () => {
    for (const n of [25, 100]) {
      const confirm = storeConfirm(n, 30, 36);
      expect(confirm, `${n} assets`).toContain('and ' + (n - 10) + ' more asset(s). In all: ' + n * 36 + ' depreciation entries');
      const { bytes, stored } = await cookieBytes(confirm, true);
      expect(bytes, `${n} assets -> ${bytes} B`).toBeLessThanOrEqual(3000);
      // keep survived (not dropped for size): the refill is still there.
      expect(flash.decodeFlash(stored!)?.keep.openingDate, `${n} assets: keep must not have been dropped`).toBe('2026-13-40');
    }
  });

  it('confirm and plan come back byte for byte, never truncated, even when keep is dropped for size', async () => {
    const confirm = storeConfirm(100, 30, 36);
    const { stored } = await cookieBytes(confirm, true);
    const payload = flash.decodeFlash(stored!);
    expect(payload?.msg.confirm).toBe(confirm);
    expect(payload?.msg.plan).toBe(PLAN);
  });

  it('the fixed-asset in-service confirm (one asset) with the full refill set fits with room to spare', async () => {
    resetJar();
    const confirm = `${'Walk-in chiller, kitchen 2 '.padEnd(60, 'x')} — moving the in-service date reverses 36 depreciation entries (2026-03–2029-02), ₱1,234,567.89; confirm to proceed`;
    await captureRedirect(() =>
      flash.redirectWithFlash('/fixed-assets/3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', {}, {
        confirm,
        plan: PLAN,
        keep: { mode: 'set', inServiceOn: '2026-10-01', reason: 'r'.repeat(200) },
      }),
    );
    const raw = currentJar().get(FLASH_COOKIE)!.value;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(3000);
    expect(flash.decodeFlash(raw)?.keep.reason).toBe('r'.repeat(200));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-389 S1 - K2 (size). The typed slot beside the cookie budget (R1, R5). Spec: docs/tasks/389-refused-save-keeps-typing.md.
// Red on HEAD: redirectWithFlash ignores `typed`, so nothing is ever stored in `t`.
// Mutant: lower MAX_COOKIE_BYTES, or shorten typed values instead of dropping the slot -> a leg below goes red.
// ---------------------------------------------------------------------------------------------------------------
describe('T-389 K2 - typed fits the budget where it must, and yields to confirm/plan where it must', () => {
  const REC = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
  const payloadOf = (raw: string) => flash.decodeFlash(raw) as unknown as { msg: Record<string, string>; keep: Record<string, string>; t?: { fields: Record<string, unknown> }; td?: unknown } | null;

  it('the largest form (attendance, 37 fields) with every value realistic fits whole even with no __changed filter', async () => {
    resetJar();
    const fields: Record<string, string> = {};
    for (let i = 0; i < 37; i++) fields[`field${String(i).padStart(2, '0')}_hhmm`] = i % 3 === 0 ? '10:45' : `Opening note ${i}`;
    await captureRedirect(() => flash.redirectWithFlash('/settings/attendance', {}, { error: 'Refused.', typed: { form: 'attendance.policy', record: REC, fields } } as never));
    const raw = currentJar().get(FLASH_COOKIE)!.value;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(3000);
    expect(payloadOf(raw)?.t?.fields, 'kept whole, not dropped').toEqual(fields);
  });

  it('a long note (500 characters) with three other fields fits whole', async () => {
    resetJar();
    const fields = { name: 'Typed Co', notes: 'n'.repeat(500), address: 'Lot 7, Block 3, Somewhere Street, Lipa City', tin: '123-456-789-000' };
    await captureRedirect(() => flash.redirectWithFlash('/ap/suppliers/x', {}, { error: 'Refused.', typed: { form: 'supplier.edit', record: REC, fields } } as never));
    const raw = currentJar().get(FLASH_COOKIE)!.value;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(3000);
    expect(payloadOf(raw)?.t?.fields).toEqual(fields);
  });

  it('a typed slot never costs the confirm sentence or the plan token: with a worst-case confirm, typed yields whole and confirm/plan come back byte for byte', async () => {
    resetJar();
    const confirm = 'C'.repeat(1500);
    const plan = 'a1b2c3d4e5f60718';
    await captureRedirect(() =>
      flash.redirectWithFlash('/admin/stores/' + REC, {}, { confirm, plan, typed: { form: 'store.edit', record: REC, fields: { name: 'z'.repeat(900) } } } as never),
    );
    const raw = currentJar().get(FLASH_COOKIE)!.value;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(3000);
    const p = payloadOf(raw);
    expect(p?.msg.confirm).toBe(confirm);
    expect(p?.msg.plan).toBe(plan);
    expect(p?.t, 'typed yielded whole').toBeUndefined();
    expect(p?.td).toEqual({ form: 'store.edit', record: REC });
  });
});

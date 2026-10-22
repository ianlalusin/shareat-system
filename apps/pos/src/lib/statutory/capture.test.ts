/**
 * T-426 slice T - capturing the qualifying diners and blocking payment on bad data. Ruling 1, Ruling 2 (zero-share block), Ruling 10, Acceptance 5, 10.
 *
 * CONTRACT for the builder (S2) - NEW module `apps/pos/src/lib/statutory/capture.ts` (pure; no Firestore, no React):
 *   normalizeIdNo(raw: string): string          - trim, drop every character that is not a letter or digit, upper-case. 'osca-2024 001187' -> 'OSCA2024001187'.
 *   maskIdNo(idNo: string): string              - '****' + the last four characters of the normalised ID. 'OSCA-2024-001187' -> '****1187'.
 *   resolveHeads(session: { sessionMode?: string; guestCountFinal?: number | null; guestCountServerVerified?: number | null;
 *                           guestCountCashierInitial?: number | null; statutoryHeadCount?: number | null }): number | null
 *       - guestCountFinal when it is > 0; else max(guestCountCashierInitial, guestCountServerVerified) when that is > 0 (v1's MAX rule);
 *       else `statutoryHeadCount` (the number the cashier typed for an a la carte session) when > 0; else null.
 *   addStatutoryDiner({ diners, entry: { kind, name, idNo }, heads, actor: { uid }, nowMs }):
 *       | { ok: true; diners: StatutoryDiner[]; diner: StatutoryDiner; warnings: string[] }
 *       | { ok: false; code: 'kind-invalid' | 'name-required' | 'id-required' | 'duplicate-id' | 'head-count-required' | 'diners-exceed-heads'; message: string }
 *       - checks in this order: kind in {'senior','pwd'}, name (trimmed) non-empty, ID (normalised) non-empty, same normalised ID already on the list
 *         (any kind), `heads` null/0 -> head-count-required, diners + 1 > heads -> diners-exceed-heads.
 *       - on success: a NEW array (input not mutated); the new diner has a non-empty unique `id`, trimmed `name`, `idNo` as typed (trimmed),
 *         `idNoNormalized`, `addedByUid = actor.uid`, `addedAtClientMs = nowMs`, `dishLineIds = []`.
 *       - the same name (case and spacing ignored) already on the list still succeeds with warnings including 'same-name'.
 *   removeStatutoryDiner(diners, id): StatutoryDiner[]           - a new array without that diner (unknown id: an equal copy).
 *   assignDishToDiner(diners, dinerId, lineId): StatutoryDiner[] - a NEW array; the line ends up in that diner's `dishLineIds` ONLY (removed from any other
 *       diner first: a line belongs to one diner); assigning twice does not duplicate; unknown dinerId: an equal copy.
 *   statutoryPaymentBlockers({ lines, diners, heads, package?, loyaltyRedemptions? }): PaymentBlocker[]   - [] when payment may go ahead.
 *       PaymentBlocker = { code: 'zero-share' | 'diners-exceed-heads' | 'head-count-required' | 'loyalty-remainder-zero'; message: string;
 *                          dinerId?: string; releaseRedemptionIds?: string[] }
 *       - zero-share (one per diner with a 0 share, `dinerId` set) message EXACTLY: Mark at least one dish for each senior/PWD diner, or remove them.
 *       - diners-exceed-heads: diners.length > heads (heads known): checked AGAIN here because an approved guest-count change can lower heads later.
 *       - head-count-required: diners present but heads null/0.
 *       - loyalty-remainder-zero: loyaltyRedemptions is non-empty and the remainder (bill lines gross - sum of shares) is 0 or less; `message` contains
 *         "Points cannot be used when every diner gets the senior/PWD discount" and `releaseRedemptionIds` lists every redemption's `redemptionId`
 *         (the caller releases them).
 *       - no diners -> [] always.
 *   statutoryActivityEntry(action: 'add' | 'remove', diner, actor: { uid }, nowMs): { type: 'statutory_diner_added' | 'statutory_diner_removed';
 *       byUid: string; atClientMs: number; kind: 'senior'|'pwd'; idMasked: string }   (the activity log must never carry the full ID).
 *   maskDinersForClosedSession(diners): StatutoryDiner[]  - bill-out copy: `idNo` becomes the masked ID, `idNoNormalized` is removed; every other field kept.
 */
import { describe, expect, it } from 'vitest';
import { loadMod, mkDiner, mkLine, need, type Diner } from '@/test-helpers/statutoryOracle';

const C = '@/lib/statutory/capture';
const WHERE = 'apps/pos/src/lib/statutory/capture.ts';
const fn = async <T>(name: string) => need<T>(await loadMod(C), name, WHERE);

type AddOk = { ok: true; diners: Diner[]; diner: Diner; warnings: string[] };
type AddErr = { ok: false; code: string; message: string };
type Add = AddOk | AddErr;
const add = async (diners: Diner[], entry: { kind?: any; name?: string; idNo?: string }, heads: number | null, nowMs = 1_700_000_000_000): Promise<Add> =>
  (await fn<(i: any) => Add>('addStatutoryDiner'))({ diners, entry: { kind: 'senior', name: 'Lola Remedios Cruz', idNo: 'OSCA-2024-001187', ...entry }, heads, actor: { uid: 'staff1' }, nowMs });

const ZERO_SHARE = 'Mark at least one dish for each senior/PWD diner, or remove them.';

describe('normalising and masking the ID', () => {
  it('normaliseIdNo drops spaces, dashes and dots and upper-cases', async () => {
    const normalizeIdNo = await fn<(s: string) => string>('normalizeIdNo');
    expect(normalizeIdNo(' osca-2024 001187 ')).toBe('OSCA2024001187');
    expect(normalizeIdNo('12.34/56')).toBe('123456');
    expect(normalizeIdNo('---')).toBe('');
  });
  it('maskIdNo shows only the last four characters', async () => {
    const maskIdNo = await fn<(s: string) => string>('maskIdNo');
    expect(maskIdNo('OSCA-2024-001187')).toBe('****1187');
    expect(maskIdNo('pwd 55-0099')).toBe('****0099');
    expect(maskIdNo('OSCA-2024-001187')).not.toContain('OSCA');
  });
});

describe('adding a diner (Ruling 1, Acceptance 5)', () => {
  it('a complete entry is added to a NEW array with the recorded fields', async () => {
    const before: Diner[] = [];
    const r = await add(before, { name: '  Lola Remedios Cruz  ', idNo: ' OSCA-2024-001187 ' }, 4, 1_700_000_123_456);
    expect(r.ok).toBe(true);
    const ok = r as AddOk;
    expect(ok.diners).not.toBe(before);
    expect(before).toEqual([]);
    expect(ok.diners).toHaveLength(1);
    expect(ok.diner).toEqual(ok.diners[0]);
    expect(ok.diner).toMatchObject({ kind: 'senior', name: 'Lola Remedios Cruz', idNo: 'OSCA-2024-001187', idNoNormalized: 'OSCA2024001187', addedByUid: 'staff1', addedAtClientMs: 1_700_000_123_456, dishLineIds: [] });
    expect(typeof ok.diner.id).toBe('string');
    expect(ok.diner.id.length).toBeGreaterThan(0);
    expect(ok.warnings).toEqual([]);
  });

  it('two entries get different ids', async () => {
    const a = (await add([], { idNo: 'A-1111' }, 4)) as AddOk;
    const b = (await add(a.diners, { name: 'Mang Jose', idNo: 'B-2222', kind: 'pwd' }, 4)) as AddOk;
    expect(b.diners.map((d) => d.id)).toHaveLength(2);
    expect(new Set(b.diners.map((d) => d.id)).size).toBe(2);
    expect(b.diners[1]!.kind).toBe('pwd');
  });

  it.each([
    ['a blank name', { name: '   ' }, 'name-required'],
    ['an empty name', { name: '' }, 'name-required'],
    ['a blank ID', { idNo: '  ' }, 'id-required'],
    ['an ID of only punctuation', { idNo: '---' }, 'id-required'],
    ['an unknown kind', { kind: 'student' }, 'kind-invalid'],
  ])('%s is refused with code %s and a plain message', async (_label, entry, code) => {
    const r = await add([], entry as any, 4);
    expect(r.ok).toBe(false);
    expect((r as AddErr).code).toBe(code);
    expect((r as AddErr).message.length).toBeGreaterThan(5);
  });

  it('the same normalised ID twice is refused, whatever the spelling or kind (a person who is both claims ONE 20%)', async () => {
    const first = (await add([], { idNo: 'OSCA-2024-001187' }, 4)) as AddOk;
    for (const [idNo, kind] of [['osca 2024 001187', 'senior'], ['OSCA.2024.001187', 'pwd'], [' osca2024001187 ', 'pwd']] as const) {
      const r = await add(first.diners, { name: 'Someone Else', idNo, kind }, 4);
      expect(r.ok, `${idNo} / ${kind}`).toBe(false);
      expect((r as AddErr).code).toBe('duplicate-id');
    }
  });

  it('the same name twice only warns (still added)', async () => {
    const first = (await add([], { idNo: 'A-1111' }, 4)) as AddOk;
    const second = await add(first.diners, { name: ' LOLA   Remedios  Cruz ', idNo: 'B-2222' }, 4);
    expect(second.ok).toBe(true);
    expect((second as AddOk).warnings).toContain('same-name');
    expect((second as AddOk).diners).toHaveLength(2);
  });

  it('diners can never be more than heads: the 3rd diner of a 2-head table is refused', async () => {
    let list: Diner[] = [];
    for (const [i, id] of ['A-1111', 'B-2222'].entries()) list = ((await add(list, { name: `P${i}`, idNo: id }, 2)) as AddOk).diners;
    const r = await add(list, { name: 'P3', idNo: 'C-3333' }, 2);
    expect(r.ok).toBe(false);
    expect((r as AddErr).code).toBe('diners-exceed-heads');
  });

  it('a la carte with no head count: the cashier must enter the number of diners first', async () => {
    for (const heads of [null, 0]) {
      const r = await add([], {}, heads);
      expect(r.ok, String(heads)).toBe(false);
      expect((r as AddErr).code).toBe('head-count-required');
    }
  });
});

describe('removing a diner and assigning dishes', () => {
  it('remove returns a new array without that diner', async () => {
    const remove = await fn<(d: Diner[], id: string) => Diner[]>('removeStatutoryDiner');
    const input = [mkDiner(1), mkDiner(2)];
    const out = remove(input, 'd1');
    expect(out.map((d) => d.id)).toEqual(['d2']);
    expect(input).toHaveLength(2);
    expect(remove(input, 'nope').map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('a dish belongs to one diner only: assigning it to d2 takes it away from d1; assigning twice does not duplicate', async () => {
    const assign = await fn<(d: Diner[], dinerId: string, lineId: string) => Diner[]>('assignDishToDiner');
    const input = [mkDiner(1, { dishLineIds: ['a1', 'a2'] }), mkDiner(2)];
    const frozen = JSON.parse(JSON.stringify(input));
    const out = assign(input, 'd2', 'a1');
    expect(out[0]!.dishLineIds).toEqual(['a2']);
    expect(out[1]!.dishLineIds).toEqual(['a1']);
    expect(assign(out, 'd2', 'a1')[1]!.dishLineIds).toEqual(['a1']);
    expect(input).toEqual(frozen);
    expect(assign(input, 'zzz', 'a1').map((d) => d.dishLineIds)).toEqual([['a1', 'a2'], []]);
  });
});

describe('resolving the head count', () => {
  it('final count wins; else max(cashier initial, server verified); else the typed a la carte count; else null', async () => {
    const resolveHeads = await fn<(s: any) => number | null>('resolveHeads');
    expect(resolveHeads({ sessionMode: 'package_dinein', guestCountFinal: 4, guestCountCashierInitial: 2 })).toBe(4);
    expect(resolveHeads({ sessionMode: 'package_dinein', guestCountFinal: null, guestCountCashierInitial: 2, guestCountServerVerified: 3 })).toBe(3);
    expect(resolveHeads({ sessionMode: 'package_dinein', guestCountCashierInitial: 5, guestCountServerVerified: null })).toBe(5);
    expect(resolveHeads({ sessionMode: 'alacarte', guestCountCashierInitial: 0, guestCountServerVerified: null, guestCountFinal: null })).toBeNull();
    expect(resolveHeads({ sessionMode: 'alacarte', guestCountCashierInitial: 0, statutoryHeadCount: 3 })).toBe(3);
    expect(resolveHeads({})).toBeNull();
  });
});

describe('payment blockers (Acceptance 5, 10)', () => {
  const pkg = () => mkLine({ id: 'pkg', type: 'package', priceC: 44900, qty: 4 });
  const dish = (id = 'a1', priceC = 20000) => mkLine({ id, type: 'addon', priceC, qty: 1 });
  const blockers = async (input: Record<string, unknown>) => (await fn<(i: any) => any[]>('statutoryPaymentBlockers'))(input);

  it('no diners: never blocks (even with loyalty)', async () => {
    expect(await blockers({ lines: [pkg()], diners: [], heads: 4, loyaltyRedemptions: [{ redemptionId: 'r1' }] })).toEqual([]);
  });

  it('a clean package table with one senior: nothing blocks', async () => {
    expect(await blockers({ lines: [pkg(), dish()], diners: [mkDiner(1)], heads: 4 })).toEqual([]);
  });

  it('a la carte diner with no dish: blocks with the exact sentence, naming the diner', async () => {
    const out = await blockers({ lines: [dish()], diners: [mkDiner(1), mkDiner(2, { dishLineIds: ['a1'] })], heads: 2 });
    const zero = out.filter((b) => b.code === 'zero-share');
    expect(zero).toHaveLength(1);
    expect(zero[0].message).toBe(ZERO_SHARE);
    expect(zero[0].dinerId).toBe('d1');
  });

  it('voiding the diner\'s only assigned dish brings the block back (Acceptance 5)', async () => {
    const diners = [mkDiner(1, { dishLineIds: ['a1'] })];
    expect(await blockers({ lines: [dish()], diners, heads: 1 })).toEqual([]);
    const voided = mkLine({ id: 'a1', type: 'addon', priceC: 20000, qty: 1, voided: 1 });
    const out = await blockers({ lines: [voided], diners, heads: 1 });
    expect(out.map((b) => b.code)).toContain('zero-share');
    expect(out.find((b) => b.code === 'zero-share').message).toBe(ZERO_SHARE);
  });

  it('diners > heads at payment (a guest-count change lowered the heads after the diners were added)', async () => {
    const out = await blockers({ lines: [pkg()], diners: [mkDiner(1), mkDiner(2), mkDiner(3)], heads: 2 });
    expect(out.map((b) => b.code)).toContain('diners-exceed-heads');
    expect(out.find((b) => b.code === 'diners-exceed-heads').message.length).toBeGreaterThan(5);
  });

  it('diners with no head count at payment: blocked', async () => {
    const out = await blockers({ lines: [dish()], diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: null });
    expect(out.map((b) => b.code)).toContain('head-count-required');
  });

  it('loyalty with every diner qualifying (remainder 0) is refused and every redemption is listed for release', async () => {
    const out = await blockers({
      lines: [dish()], diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 1,
      loyaltyRedemptions: [{ redemptionId: 'r1', type: 'fixed', value: 50 }, { redemptionId: 'r2', type: 'percent', value: 10 }],
    });
    const b = out.find((x) => x.code === 'loyalty-remainder-zero');
    expect(b).toBeTruthy();
    expect(b.message).toContain('Points cannot be used when every diner gets the senior/PWD discount');
    expect(b.releaseRedemptionIds).toEqual(['r1', 'r2']);
  });

  it('loyalty is fine while something is left over (a shared dish stays in the remainder)', async () => {
    const out = await blockers({
      lines: [dish('a1'), dish('a2', 30000)], diners: [mkDiner(1, { dishLineIds: ['a1'] })], heads: 2,
      loyaltyRedemptions: [{ redemptionId: 'r1', type: 'fixed', value: 50 }],
    });
    expect(out.map((b) => b.code)).not.toContain('loyalty-remainder-zero');
  });
});

describe('privacy: the activity log and the closed session carry the masked ID only (Ruling 10)', () => {
  it('the activity entry for an add or a remove has who, when, kind and the masked ID, and never the full ID', async () => {
    const entry = await fn<(a: string, d: Diner, actor: any, ms: number) => any>('statutoryActivityEntry');
    const d = mkDiner(1, { kind: 'pwd', idNo: 'PWD-0099-1187', idNoNormalized: 'PWD00991187', name: 'Mang Jose' });
    const added = entry('add', d, { uid: 'staff1' }, 1_700_000_000_000);
    const removed = entry('remove', d, { uid: 'staff2' }, 1_700_000_000_500);
    expect(added).toMatchObject({ type: 'statutory_diner_added', byUid: 'staff1', atClientMs: 1_700_000_000_000, kind: 'pwd', idMasked: '****1187' });
    expect(removed).toMatchObject({ type: 'statutory_diner_removed', byUid: 'staff2', atClientMs: 1_700_000_000_500, kind: 'pwd', idMasked: '****1187' });
    for (const e of [added, removed]) {
      const text = JSON.stringify(e);
      expect(text).not.toContain('PWD-0099-1187');
      expect(text).not.toContain('PWD00991187');
    }
  });

  it('maskDinersForClosedSession keeps the masked ID only', async () => {
    const mask = await fn<(d: Diner[]) => any[]>('maskDinersForClosedSession');
    const input = [mkDiner(1, { idNo: 'OSCA-2024-001187', idNoNormalized: 'OSCA2024001187', dishLineIds: ['a1'] })];
    const out = mask(input);
    expect(out[0]).toMatchObject({ id: 'd1', kind: 'senior', name: 'Diner 1', idNo: '****1187', dishLineIds: ['a1'] });
    expect(out[0].idNoNormalized).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('001187');
    expect(input[0]!.idNo).toBe('OSCA-2024-001187');
  });
});

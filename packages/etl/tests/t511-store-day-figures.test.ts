/**
 * T-511 slice 1, exit criterion 5 - the pure half of the read-only store-day reader.
 * `scripts/t511-read-store-day-figures.ts` reads v1 Firestore on Ian's machine; this proves, with no credential and
 * no database, the three safety rules: only two collections can be read, a failure never prints the error's own
 * message, and the report copies out figures, ids and names only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client } from '../src/master-data/snapshot';
import {
  SafeRefusal,
  assertReadablePath,
  extractDayFigures,
  formatDayReport,
  formatStoreHeader,
  isIsoDate,
  makeGuardedReader,
  matchChannels,
  money,
  parseArgs,
  pickStore,
  safeFailureLine,
  toStoreRef,
} from '../../../scripts/lib/t511-store-day-figures';

const LIPA = 'b9DzsnPbr1BUnY88lyT4';
const GRAB_ID = 'chGRAB0001';
const FP_ID = 'chFOODPANDA1';
const ROOT = join(__dirname, '..', '..', '..');

const storeDoc = (id: string, name: string, channels: unknown) => ({ id, data: () => ({ name, salesChannels: channels, secretNote: 'SENTINEL-STORE-NOTE' }) });
const lipaDoc = storeDoc(LIPA, 'SharEat Lipa', [
  { channelId: 'chDINE0001', name: 'Dine-in', isActive: true, isRemittedDaily: true },
  { channelId: GRAB_ID, name: 'Grab', isActive: true, isRemittedDaily: false },
  { channelId: FP_ID, name: 'Food Panda', isActive: true, isRemittedDaily: false },
]);
const roster = [lipaDoc, storeDoc('dZUyvX4q824JBSVDAfE9', 'SharEat Malvar', [])].map(toStoreRef);

const dayDoc = (extra: Record<string, unknown> = {}) => ({
  id: '2026-10-12',
  data: () => ({
    status: 'verified',
    verifiedAt: Date.UTC(2026, 9, 13, 2, 0, 0),
    totalSales: 40000,
    salesChannelBreakdown: { [GRAB_ID]: 6807, [FP_ID]: 16042, chDINE0001: 17151 },
    noSalesChannelIds: [],
    totalDiscounts: 0,
    seniorDiscount: 120.5,
    submittedByName: 'SENTINEL-PERSON-NAME',
    voidReason: 'SENTINEL-VOID-REASON',
    flagReason: 'SENTINEL-FLAG-REASON',
    notes: 'SENTINEL-NOTES',
    ...extra,
  }),
});

describe('T-511 S1 exit 5 - the read guard', () => {
  it('allows exactly the store list and one store\'s salesDays', () => {
    expect(() => assertReadablePath('stores')).not.toThrow();
    expect(() => assertReadablePath(`stores/${LIPA}/salesDays`)).not.toThrow();
  });

  it.each([
    'stores/b9DzsnPbr1BUnY88lyT4',
    `stores/${LIPA}/salesDays/2026-10-12`,
    `stores/${LIPA}/salesDays/2026-10-12/adjustments`,
    `stores/${LIPA}/journal`,
    `stores/${LIPA}/salesDaysArchive`,
    'stores/../users',
    `other/stores/${LIPA}/salesDays`,
    `/stores/${LIPA}/salesDays`,
    'stores/ab/salesDays',
    'users',
    '',
    'stores/',
    'stores/b9DzsnPbr1BUnY88lyT4/salesDays/',
    `stores/${LIPA}/salesDays; stores`,
  ])('refuses %j', (path) => {
    expect(() => assertReadablePath(path)).toThrow(SafeRefusal);
  });

  it('reads nothing at all through a refused path', async () => {
    let calls = 0;
    const reader = makeGuardedReader({ collection: () => ({ get: async () => (calls++, { docs: [] }) }) });
    await expect(reader.readCollection('stores/xxxxxxxxxx/journal')).rejects.toThrow(SafeRefusal);
    expect(calls).toBe(0);
    await reader.readCollection('stores');
    expect(calls).toBe(1);
  });

  it('the client underneath exposes read methods only', () => {
    const client = makeReadOnlyV1Client({ collection: () => ({ get: async () => ({ docs: [] }) }) });
    expect(Object.keys(client)).toEqual(['collection']);
    expect(Object.keys(client.collection('stores'))).toEqual(['get']);
  });

  it('the script and its helper contain no write call and no database call', () => {
    for (const rel of ['scripts/t511-read-store-day-figures.ts', 'scripts/lib/t511-store-day-figures.ts']) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\/\/.*$/, ''))
        .join('\n');
      // `app.delete()` closes the SDK app (a lifecycle call, not a document delete) and is the one allowed exception.
      expect(code, rel).not.toMatch(/(?<!\bapp)\.(set|update|delete|add|create|batch|runTransaction|bulkWriter|recursiveDelete)\s*\(/);
      expect(code, rel).not.toMatch(/\b(writeFile|appendFile|unlink|mkdir|rmSync)\w*\s*\(/);
      expect(code, rel).not.toMatch(/systemTransaction|getSystemSql|DATABASE_URL|postgres/);
    }
  });
});

describe('T-511 S1 exit 5 - a failure never prints the error\'s own message', () => {
  it('prints a fixed sentence and a plain code, never the message or the stack', () => {
    const secret = 'postgres://user:SENTINEL-PASSWORD@db.example.com:25060/x ' + '-----BEGIN ' + 'PRIVATE KEY-----SENTINEL-KEY';
    const err = Object.assign(new Error(secret), { code: 'ECONNREFUSED', stack: `Error: ${secret}\n at somewhere` });
    const line = safeFailureLine(err);
    expect(line).toContain('ECONNREFUSED');
    for (const leak of ['SENTINEL-PASSWORD', 'SENTINEL-KEY', 'postgres://', 'db.example.com', 'PRIVATE KEY', 'somewhere']) expect(line).not.toContain(leak);
  });

  it('drops a code that is not plain, and survives non-error throws', () => {
    expect(safeFailureLine(Object.assign(new Error('x'), { code: 'bad code with SENTINEL-PASSWORD' }))).toContain('error code: unknown');
    expect(safeFailureLine(Object.assign(new Error('x'), { code: 7 }))).toContain('error code: 7');
    expect(safeFailureLine('SENTINEL-PASSWORD')).toContain('error code: unknown');
    expect(safeFailureLine(null)).not.toContain('null');
    expect(safeFailureLine(undefined)).toContain('error code: unknown');
    expect(safeFailureLine('SENTINEL-PASSWORD')).not.toContain('SENTINEL-PASSWORD');
  });

  it('prints this module\'s own refusal text as written', () => {
    expect(safeFailureLine(new SafeRefusal('Refused: example.'))).toBe('Refused: example.');
  });
});

describe('T-511 S1 exit 5 - arguments', () => {
  it('defaults to Lipa, Grab and Foodpanda, and the two chosen dates', () => {
    expect(parseArgs([])).toEqual({ store: 'Lipa', storeId: null, channels: ['Grab', 'Foodpanda'], dates: ['2026-10-12', '2026-10-20'] });
  });

  it('takes lists and refuses anything unknown, valueless or not a real date', () => {
    expect(parseArgs(['--channels', 'Grab', '--dates', '2026-10-14, 2026-10-15']).dates).toEqual(['2026-10-14', '2026-10-15']);
    expect(() => parseArgs(['--db', 'x'])).toThrow(SafeRefusal);
    expect(() => parseArgs(['--store'])).toThrow(SafeRefusal);
    expect(() => parseArgs(['--store', '--dates'])).toThrow(SafeRefusal);
    expect(() => parseArgs(['--dates', '2026-02-30'])).toThrow(SafeRefusal);
    expect(() => parseArgs(['--dates', '12 Oct'])).toThrow(SafeRefusal);
    expect(() => parseArgs(['--store-id', 'a/b'])).toThrow(SafeRefusal);
    expect(isIsoDate('2026-10-12')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});

describe('T-511 S1 exit 5 - store and channel selection', () => {
  it('finds one store by name, refuses none and many, and lists names when it refuses', () => {
    expect(pickStore(roster, { store: 'Lipa', storeId: null }).id).toBe(LIPA);
    expect(pickStore(roster, { store: 'x', storeId: LIPA }).id).toBe(LIPA);
    expect(() => pickStore(roster, { store: 'Nowhere', storeId: null })).toThrow(/SharEat Lipa/);
    expect(() => pickStore(roster, { store: 'SharEat', storeId: null })).toThrow(/More than one/);
    expect(() => pickStore(roster, { store: 'x', storeId: 'zzzzzzzzzz' })).toThrow(SafeRefusal);
  });

  it('matches channel names ignoring capitals and spaces, and says when nothing matches', () => {
    const store = pickStore(roster, { store: 'Lipa', storeId: null });
    const m = matchChannels(store, ['Grab', 'foodpanda', 'Shopee']);
    expect(m.map((x) => x.channels.map((c) => c.channelId))).toEqual([[GRAB_ID], [FP_ID], []]);
    const header = formatStoreHeader(store, m).join('\n');
    expect(header).toContain(`channelId ${GRAB_ID}`);
    expect(header).toContain('NO channel name matches');
    expect(header).not.toContain('SENTINEL-STORE-NOTE');
  });
});

describe('T-511 S1 exit 5 - reading and printing a day', () => {
  const store = pickStore(roster, { store: 'Lipa', storeId: null });
  const channels = matchChannels(store, ['Grab', 'Foodpanda']).flatMap((m) => m.channels);
  const pattern = new Map([[GRAB_ID, 'Grab'], [FP_ID, 'Foodpanda']]);

  it('picks the recorded figure per channel and prints figures, ids and names only', () => {
    const day = extractDayFigures('2026-10-12', dayDoc(), channels);
    expect(day.verified).toBe(true);
    expect(day.channels.map((c) => c.recorded)).toEqual([6807, 16042]);
    const text = formatDayReport(day, pattern).join('\n');
    expect(text).toContain(`salesChannelBreakdown[${GRAB_ID}] = 6807.00`);
    expect(text).toContain(`salesChannelBreakdown[${FP_ID}] = 16042.00`);
    expect(text).toContain('verified or later: yes');
    expect(text).toContain('seniorDiscount 120.50');
    for (const leak of ['SENTINEL-PERSON-NAME', 'SENTINEL-VOID-REASON', 'SENTINEL-FLAG-REASON', 'SENTINEL-NOTES', 'SENTINEL-STORE-NOTE']) expect(text).not.toContain(leak);
  });

  it('says NOT FOUND for a missing day and "absent" for a channel with no figure', () => {
    expect(formatDayReport(extractDayFigures('2026-10-13', undefined, channels), pattern).join('\n')).toContain('NOT FOUND');
    const day = extractDayFigures('2026-10-12', dayDoc({ salesChannelBreakdown: { [GRAB_ID]: 6807 }, noSalesChannelIds: [FP_ID] }), channels);
    const text = formatDayReport(day, pattern).join('\n');
    expect(text).toContain(`salesChannelBreakdown[${FP_ID}] = absent   (staff confirmed no sales)`);
  });

  it('an open day is not verified; an adjusted day also shows the figure before the first adjustment', () => {
    expect(extractDayFigures('2026-10-12', dayDoc({ status: 'open' }), channels).verified).toBe(false);
    const adjusted = extractDayFigures(
      '2026-10-12',
      dayDoc({ hasAdjustments: true, adjustmentCount: 1, preAdjustmentSnapshot: { salesChannelBreakdown: { [GRAB_ID]: 6753 } } }),
      channels,
    );
    const text = formatDayReport(adjusted, pattern).join('\n');
    expect(text).toContain('admin adjustments: yes (count 1)');
    expect(text).toContain('preAdjustmentSnapshot) = 6753.00');
  });

  it('shows a stored figure that is not whole centavos with its raw value, and never throws on odd data', () => {
    expect(money(6807)).toBe('6807.00');
    expect(money(0.1 + 0.2)).toBe('0.30');
    expect(money(10.004)).toContain('raw 10.004');
    expect(money(undefined)).toBe('absent');
    expect(() => extractDayFigures('2026-10-12', dayDoc({ salesChannelBreakdown: 'junk', totalSales: 'junk', status: 7, noSalesChannelIds: 'junk', preAdjustmentSnapshot: 5 }), channels)).not.toThrow();
  });
});

/**
 * T-426 slice T - the statutory-discount logbook export. Ruling 10, Acceptance 11.
 *
 * CONTRACT for the builder (S4):
 *   NEW pure module `apps/pos/scripts/lib/statutory-logbook.mjs` (plain ESM, no Firebase import):
 *     statutoryLogbookRows(storeId: string, receipts: { id: string; data: Record<string, any> }[], range: { fromMs: number; toMs: number }): LogRow[]
 *       - one row per diner in `data.statutoryDiners` of every SALE receipt (`data.isRefund` true receipts give no rows) whose `data.createdAtClientMs`
 *         is within [fromMs, toMs]; sorted by createdAtClientMs, then receipt number, then diner order.
 *       - LogRow = { store, date: 'YYYY-MM-DD' (Manila day), receipt: string (data.receiptNumber, or the id), kind, name, idNo (the FULL ID from the receipt),
 *                    share, discount, vatExempt, vatRemoved (pesos, numbers), refunded: boolean }
 *       - refunded is true when the sale receipt has `refundCount > 0` or `totalRefunded > 0`, OR any receipt in the list with `isRefund: true` has
 *         `parentReceiptId` equal to this receipt's id.
 *     renderStatutoryLogbook(rows: LogRow[], range: { from: string; to: string }): string     (from / to as YYYYMMDD)
 *       - line 1 EXACTLY: Contains personal data. Management record, not a BIR document (row 75).
 *       - line 2 EXACTLY: store,date,receipt,kind,name,idNo,share,discount,vatExempt,vatRemoved,refunded
 *       - then one CSV line per row (fields with a comma, quote or newline are double-quoted, quotes doubled); amounts with 2 decimals; refunded as yes / no.
 *       - last line EXACTLY: statutory-logbook: <N> diner(s) for <from> to <to>.
 *       - lines are joined with "\n" and the text ends with "\n".
 *   `node apps/pos/scripts/pos2-audit.mjs --statutory-logbook --from=YYYYMMDD --to=YYYYMMDD [--store=<id>]...` prints renderStatutoryLogbook to stdout and exits 0.
 *     Data source for tests: when the environment variable POS2_AUDIT_FIXTURE names a JSON file { "stores": { "<id>": { "receipts": [ { "id", "data" } ] } } },
 *     the script reads ONLY that file (no key file, no Firebase, no network); otherwise it reads Firestore exactly as it does today (read-only).
 *     Without `--statutory-logbook` the script behaves exactly as before (T-424).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { need } from '@/test-helpers/statutoryOracle';

const SCRIPT = fileURLToPath(new URL('../../../scripts/pos2-audit.mjs', import.meta.url));
const LIB = fileURLToPath(new URL('../../../scripts/lib/statutory-logbook.mjs', import.meta.url));
const HEADER = 'Contains personal data. Management record, not a BIR document (row 75).';
const CSV_HEAD = 'store,date,receipt,kind,name,idNo,share,discount,vatExempt,vatRemoved,refunded';
const ms = (iso: string) => Date.parse(iso);

type Row = { store: string; date: string; receipt: string; kind: string; name: string; idNo: string; share: number; discount: number; vatExempt: number; vatRemoved: number; refunded: boolean };
async function lib() {
  let m: any;
  try { m = await import(/* @vite-ignore */ pathToFileURL(LIB).href); } catch (e: any) { throw new Error(`T-426 module not written yet or broken: apps/pos/scripts/lib/statutory-logbook.mjs (${String(e?.message).slice(0, 100)})`); }
  return {
    rows: need<(s: string, r: any[], range: any) => Row[]>(m, 'statutoryLogbookRows', 'statutory-logbook.mjs'),
    render: need<(rows: Row[], range: any) => string>(m, 'renderStatutoryLogbook', 'statutory-logbook.mjs'),
  };
}

const diner = (kind: 'senior' | 'pwd', name: string, idNo: string, share = 449, discount = 80.18, vatRemoved = 48.11, vatExempt = 320.71) =>
  ({ kind, name, idNo, share, discount, vatRemoved, vatExempt, promoWasHigher: false });

const RECEIPTS = [
  { id: 'r1', data: { receiptNumber: 'SHT-01-000011', createdAtClientMs: ms('2026-10-02T10:00:00+08:00'), refundCount: 1, totalRefunded: 449,
    statutoryDiners: [diner('senior', 'Cruz, Lola "Remy"', 'OSCA-2024-001187'), diner('pwd', 'Mang Jose', 'PWD-55-0099')] } },
  { id: 'r2', data: { receiptNumber: 'SHT-01-000012', createdAtClientMs: ms('2026-10-04T06:00:00+08:00'), statutoryDiners: [diner('senior', 'Ana Reyes', 'OSCA-77', 100, 17.86, 10.71, 71.43)] } },
  { id: 'rf2', data: { receiptNumber: 'RF-01-000013', isRefund: true, parentReceiptId: 'r2', createdAtClientMs: ms('2026-10-04T09:00:00+08:00'), statutoryDiners: [diner('senior', 'Ana Reyes', 'OSCA-77')] } },
  { id: 'r3', data: { receiptNumber: 'SHT-01-000014', createdAtClientMs: ms('2026-10-04T12:00:00+08:00'), statutoryDiners: [diner('pwd', 'Pedro Santos', 'PWD-12', 200, 35.71, 21.43, 142.86)] } },
  { id: 'r4', data: { receiptNumber: 'SHT-01-000015', createdAtClientMs: ms('2026-10-04T13:00:00+08:00') } },
  { id: 'r5', data: { receiptNumber: 'SHT-01-000016', createdAtClientMs: ms('2026-11-15T13:00:00+08:00'), statutoryDiners: [diner('senior', 'Outside Range', 'OSCA-99')] } },
];
const RANGE = { fromMs: ms('2026-10-01T00:00:00+08:00'), toMs: ms('2026-10-31T23:59:59+08:00') };

describe('statutoryLogbookRows', () => {
  it('one row per diner of every sale receipt in range, sorted; refund receipts, receipts without diners and out-of-range ones give none', async () => {
    const { rows } = await lib();
    const out = rows('S1', RECEIPTS, RANGE);
    expect(out.map((r) => [r.receipt, r.name])).toEqual([
      ['SHT-01-000011', 'Cruz, Lola "Remy"'], ['SHT-01-000011', 'Mang Jose'], ['SHT-01-000012', 'Ana Reyes'], ['SHT-01-000014', 'Pedro Santos'],
    ]);
    expect(out[0]).toEqual({
      store: 'S1', date: '2026-10-02', receipt: 'SHT-01-000011', kind: 'senior', name: 'Cruz, Lola "Remy"', idNo: 'OSCA-2024-001187',
      share: 449, discount: 80.18, vatExempt: 320.71, vatRemoved: 48.11, refunded: true,
    });
  });

  it('the date is the Manila day: 06:00 on the 4th at +08:00 is 22:00 on the 3rd in UTC, but the row says the 4th', async () => {
    const { rows } = await lib();
    expect(rows('S1', RECEIPTS, RANGE).find((r) => r.receipt === 'SHT-01-000012')!.date).toBe('2026-10-04');
  });

  it('refunded flag: by the receipt\'s own refundCount, or by a refund receipt that points at it; otherwise false', async () => {
    const { rows } = await lib();
    const byReceipt = Object.fromEntries(rows('S1', RECEIPTS, RANGE).map((r) => [r.receipt, r.refunded]));
    expect(byReceipt['SHT-01-000011']).toBe(true); // refundCount
    expect(byReceipt['SHT-01-000012']).toBe(true); // refund receipt rf2 -> parentReceiptId r2
    expect(byReceipt['SHT-01-000014']).toBe(false);
  });

  it('a range that excludes everything returns no rows', async () => {
    const { rows } = await lib();
    expect(rows('S1', RECEIPTS, { fromMs: ms('2027-01-01T00:00:00+08:00'), toMs: ms('2027-01-02T00:00:00+08:00') })).toEqual([]);
  });
});

describe('renderStatutoryLogbook', () => {
  it('personal-data header, CSV header, quoted fields, 2-decimal amounts, yes/no, count footer, trailing newline', async () => {
    const { rows, render } = await lib();
    const text = render(rows('S1', RECEIPTS, RANGE), { from: '20261001', to: '20261031' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(CSV_HEAD);
    expect(lines[2]).toBe('S1,2026-10-02,SHT-01-000011,senior,"Cruz, Lola ""Remy""",OSCA-2024-001187,449.00,80.18,320.71,48.11,yes');
    expect(lines[3]).toBe('S1,2026-10-02,SHT-01-000011,pwd,Mang Jose,PWD-55-0099,449.00,80.18,320.71,48.11,yes');
    expect(lines[5]).toBe('S1,2026-10-04,SHT-01-000014,pwd,Pedro Santos,PWD-12,200.00,35.71,142.86,21.43,no');
    expect(lines[6]).toBe('statutory-logbook: 4 diner(s) for 20261001 to 20261031.');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toHaveLength(8); // 7 lines + the empty string after the final newline
  });

  it('with no rows it still prints the header, the CSV head and a zero count', async () => {
    const { render } = await lib();
    const lines = render([], { from: '20261001', to: '20261031' }).split('\n');
    expect(lines.slice(0, 3)).toEqual([HEADER, CSV_HEAD, 'statutory-logbook: 0 diner(s) for 20261001 to 20261031.']);
  });
});

describe('the CLI: node apps/pos/scripts/pos2-audit.mjs --statutory-logbook (injected data source)', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't426-logbook-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ stores: { S1: { receipts: RECEIPTS }, S2: { receipts: [{ id: 'x1', data: { receiptNumber: 'S2-01-000001', createdAtClientMs: ms('2026-10-05T10:00:00+08:00'), statutoryDiners: [diner('pwd', 'Other Store Diner', 'PWD-S2')] } }] } } }));
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    delete e.POS_FIREBASE_SA_KEY_FILE;
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: e as any, timeout: 60_000 });
  };

  it('prints the header, the CSV rows of every store and the footer; exit code 0; reads only the fixture', () => {
    const r = run(['--statutory-logbook', '--from=20261001', '--to=20261031'], { POS2_AUDIT_FIXTURE: fixture });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(CSV_HEAD);
    expect(r.stdout).toContain('S1,2026-10-02,SHT-01-000011,senior,"Cruz, Lola ""Remy""",OSCA-2024-001187,449.00,80.18,320.71,48.11,yes');
    expect(r.stdout).toContain('S2,2026-10-05,S2-01-000001,pwd,Other Store Diner,PWD-S2,449.00,80.18,320.71,48.11,no');
    expect(r.stdout).toContain('statutory-logbook: 5 diner(s) for 20261001 to 20261031.');
    expect(r.stdout).not.toContain('Outside Range');
  });

  it('--store limits it to that store', () => {
    const r = run(['--statutory-logbook', '--from=20261001', '--to=20261031', '--store=S2'], { POS2_AUDIT_FIXTURE: fixture });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Other Store Diner');
    expect(r.stdout).not.toContain('Lola');
    expect(r.stdout).toContain('statutory-logbook: 1 diner(s) for 20261001 to 20261031.');
  });

  it('without --statutory-logbook the script is unchanged: no key file means the usage line and exit code 1', () => {
    const r = run(['--from=20261001', '--to=20261031']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Usage:.*pos2-audit\.mjs/);
  });
});

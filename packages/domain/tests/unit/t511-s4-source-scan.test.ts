/**
 * T-511 S4 (TESTER, 2026-11-04) - source-scan guards for the new files, and the wiring that is not a behaviour. Comments are blanked before scanning so prose
 * that explains a rule does not trip it. These are TRIPWIRES: the integration tests are the authority on behaviour; a scan only catches the shape.
 *
 * RED today, for one reason: stage.ts, store-match.ts, ingest.ts and `packages/db/src/repo/settlement-intake.ts` do not exist.
 *
 * ## The seven reader exports and the production-caller ratchet (spec "Callers for all seven reader exports")
 * `tests/unit/production-caller-ratchet.test.ts` fails the build when a name JOINS the zero-caller set, and the baseline
 * (`docs/production-caller-baseline.txt`) may be shrunk ONLY by `node scripts/production-caller-census.mjs --names > docs/production-caller-baseline.txt`
 * (never by hand; this tester did not touch it). Today it lists exactly these seven slice-3 names: deductionFor, openSettlementZip, parseGrabDateTime,
 * readFoodpandaInvoice, readGrabTransactions, readGrabTransfers, tieGrabPayouts. When the builder gives each a real production caller (asserted below), the
 * census stops listing them and the regenerated baseline must be exactly 7 names shorter and have no name added. The census takes more than two minutes, so
 * it is NOT run here; the builder runs the script, reviews the diff (-7, +0) and commits the regenerated file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const DIR = join(REPO, 'packages', 'domain', 'src', 'settlement-intake');
const REPO_FILE = join(REPO, 'packages', 'db', 'src', 'repo', 'settlement-intake.ts');

function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, (_m, p1: string) => p1);
}
const read = (p: string): string => (existsSync(p) ? blankComments(readFileSync(p, 'utf8')) : '');
const src = (name: string): string => read(join(DIR, name));

describe('T-511 S4 new files exist', () => {
  it('stage.ts, store-match.ts, ingest.ts and the repo file are there', () => {
    for (const f of ['stage.ts', 'store-match.ts', 'ingest.ts']) expect(existsSync(join(DIR, f)), f).toBe(true);
    expect(existsSync(REPO_FILE)).toBe(true);
  });
});

describe('T-511 S4 stage.ts is pure and uses the one mapping table', () => {
  const s = src('stage.ts');
  it('imports no database package and opens no transaction; no SQL; nothing written to disk', () => {
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/from\s*['"]@shareat\/db/);
    expect(s).not.toMatch(/from\s*['"]drizzle-orm/);
    expect(s).not.toMatch(/(?<![.\w$])transaction\(/);
    expect(s).not.toMatch(/\bsql`|\.execute\(/);
    expect(s).not.toMatch(/\b(writeFile|writeFileSync|createWriteStream|appendFile|mkdtemp)\b/);
  });

  it('calls deductionFor for every column or category it maps, and keeps no second copy of the table (no quoted-column -> bucket literal)', () => {
    expect(s).toMatch(/from\s*['"]\.\/deduction-mapping['"]/);
    expect(s).toMatch(/\bdeductionFor\(/);
    expect(s).not.toMatch(/['"][^'"\n]{3,}['"]\s*:\s*['"](?:commission|marketing|platformFee)['"]/);
    expect(s).not.toMatch(/['"][^'"\n]{3,}['"]\s*:\s*(?:cost|credit)\(/);
    expect(s).not.toMatch(/\bGRAB\s*[:=]\s*\{|\bFOODPANDA\s*[:=]\s*\{/);
  });

  it('has no raw `throw new Error` (the T-343 ratchet ceiling stays 0) and no `Number(x) <op> 0` money comparison', () => {
    expect(s).not.toMatch(/throw new Error\(/);
    expect(s).not.toMatch(/\bNumber\([^()]*\)\s*(?:<=|>=|<|>|===|!==|==|!=)\s*0\b/);
  });

  it('exports stageGrabDays, stageFoodpandaDays and checkStagedDay', () => {
    for (const name of ['stageGrabDays', 'stageFoodpandaDays', 'checkStagedDay']) expect(s, name).toMatch(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`));
  });
});

describe('T-511 S4 store-match.ts and ingest.ts', () => {
  const m = src('store-match.ts');
  const i = src('ingest.ts');

  it('store-match looks the channel up through channelByPlatformCode and writes no SQL itself', () => {
    expect(m).toMatch(/\bchannelByPlatformCode\(/);
    expect(m).not.toMatch(/\bsql`|\.execute\(/);
    expect(m).not.toMatch(/throw new Error\(/);
    expect(m).toMatch(/export\s+(?:async\s+)?function\s+matchChannel\b/);
  });

  it('ingest has the signature `ingestSettlementFile(tx: Tx, actor, ...)`: the transaction is NOT nullable (t398 S2) and nothing is opened inside', () => {
    expect(i).toMatch(/export\s+async\s+function\s+ingestSettlementFile\s*\(\s*tx:\s*Tx\s*,/);
    expect(i).not.toMatch(/tx:\s*Tx\s*\|\s*null/);
    expect(i).not.toMatch(/(?<![.\w$])transaction\(/);
    expect(i).not.toMatch(/\bsql`|\.execute\(/);
    expect(i).not.toMatch(/throw new Error\(/);
    expect(i).not.toMatch(/\b(writeFile|writeFileSync|createWriteStream|appendFile|mkdtemp)\b/);
  });

  it('ingest exports detectSettlementKind and fingerprintOf', () => {
    for (const name of ['ingestSettlementFile', 'detectSettlementKind', 'fingerprintOf']) expect(i, name).toMatch(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`));
  });

  it('ORDER (BOSS 4 Nov a): read and match the store, authorize the MATCHED store, THEN look the fingerprint up, THEN store the file [kills: fingerprint check before the fine gate; evidence stored before the repeat check]', () => {
    const at = (needle: RegExp): number => i.search(needle);
    const match = at(/\bmatchChannel\(/);
    const fine = at(/\bauthorize\(/);
    const repeat = at(/\bfindUploadByFingerprint\(/);
    const store = at(/\buploadFile\(/);
    expect([match, fine, repeat, store].every((n) => n >= 0), `positions ${[match, fine, repeat, store]}`).toBe(true);
    expect(match).toBeLessThan(fine);
    expect(fine).toBeLessThan(repeat);
    expect(repeat).toBeLessThan(store);
    expect(i.indexOf("'upload_settlement_files'")).toBeGreaterThanOrEqual(0);
  });

  it('the stored file belongs to the MATCHED store: uploadFile is called with the matched channel\'s store, never an actor-derived one (BOSS 4 Nov b)', () => {
    const call = /\buploadFile\([^;]*?\)/s.exec(i)?.[0] ?? '';
    expect(call).not.toMatch(/\bactor\.storeId\b|\bactor\.homeStoreId\b|\bstoreIds?\[0\]/);
    expect(call).toMatch(/storeId/);
  });
});

describe('T-511 S4 the seven slice-3 reader exports each get a real production caller (the baseline shrinks by these names (6; parseGrabDateTime stays))', () => {
  const stage = src('stage.ts');
  const ingest = src('ingest.ts');
  const calls = (code: string, name: string): boolean => new RegExp(`(?<![.\\w$])${name}\\(`).test(code.replace(/^\s*import[^;]*;/gm, ''));

  it('ingest.ts calls openSettlementZip, readFoodpandaInvoice, readGrabTransactions, readGrabTransfers and tieGrabPayouts', () => {
    for (const name of ['openSettlementZip', 'readFoodpandaInvoice', 'readGrabTransactions', 'readGrabTransfers', 'tieGrabPayouts']) expect(calls(ingest, name), name).toBe(true);
  });

  // parseGrabDateTime stays in the production-caller baseline: readGrabTransactions already parses every date, so stage and ingest never see date text (Opus ruling, 4 Nov).
  it('stage.ts calls deductionFor', () => {
    expect(calls(stage, 'deductionFor')).toBe(true);
  });

  it('the seven names are still exported by the slice-3 modules (so there is something to call)', () => {
    const barrel = readFileSync(join(DIR, 'index.ts'), 'utf8');
    expect(barrel).toMatch(/export \* from '\.\/safe-zip'/);
    expect(barrel).toMatch(/export \* from '\.\/deduction-mapping'/);
  });
});

describe('T-511 S4 the repo file', () => {
  const r = read(REPO_FILE);
  const NAMES = [
    'insertUpload', 'findUploadByFingerprint', 'findCurrentUploads', 'markSuperseded', 'currentLine', 'insertDayLineVersion', 'retireCurrentLine',
    'insertLoanLines', 'insertOtherLines', 'salesDayFigure', 'daysWithRecordedSalesAndNoLine', 'channelByPlatformCode',
  ];

  it('exports every function of the contract (channelByPlatformCode may be a re-export of the sales-days one)', () => {
    for (const name of NAMES) expect(r, name).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('is reachable as `settlementIntakeRepo` from @shareat/db', () => {
    const index = readFileSync(join(REPO, 'packages', 'db', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/export \* as settlementIntakeRepo from '\.\/repo\/settlement-intake'/);
  });

  it('never deletes and never updates a money column (the app role has no DELETE and UPDATE only on state columns) [kills: DELETE; UPDATE of order_value, commission, ...]', () => {
    expect(r.length).toBeGreaterThan(0);
    expect(r).not.toMatch(/\.delete\(|delete\s+from|truncate/i);
    expect(r).not.toMatch(/\.set\(\{[^}]*\b(orderValue|grossInfo|commission|marketing|platformFee|vendorDiscount|loanDeduction|loanDisbursal|netPayout|unexplained|amount)\b/);
    expect(r).not.toMatch(/update\s+settlement_day_lines\s+set[^;`]*\b(order_value|gross_info|commission|marketing|platform_fee|vendor_discount|loan_deduction|loan_disbursal|net_payout|unexplained)\b/i);
    expect(r).not.toMatch(/update\s+settlement_(?:loan|other)_lines\s+set[^;`]*\b(amount|kind|booked_as)\b/i);
  });

  it('the domain package exports the ingest entry for the upload action', () => {
    const index = readFileSync(join(REPO, 'packages', 'domain', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/settlement-intake\/ingest|ingestSettlementFile/);
  });
});

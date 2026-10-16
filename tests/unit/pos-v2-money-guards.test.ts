/**
 * T-423 slice T - tree guards for the money and numbering work in `apps/pos`.
 * `docs/tasks/423-pos-v2-money-and-numbering.md` Acceptance 3, 4, 8 and the Rulings they police (1, 2, 4, 5, 8). Reads the tree with
 * fs; never imports app code. Every test names the mutant it kills. A guard that would pass on an empty tree first asserts that the
 * thing it polices exists, so it is red until the builder lands it.
 *
 * Exceptions are LISTED, each with a reason; the builder may shorten a list (migrating more code is welcome) but must not widen one
 * without telling the planner.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const POS = path.join(repoRoot, 'apps', 'pos');
const SRC = path.join(POS, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const isCode = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f);
const isTest = (f: string) => /\.test\.(ts|tsx)$/.test(f) || rel(f).startsWith('test-helpers/') || rel(f).includes('/__fixtures__/');
/** Shipping code only: no tests, no test helpers, no vendored fixtures. */
const appFiles = () => walk(SRC).filter((f) => isCode(f) && !isTest(f));

/** Source with comments blanked (line numbers kept) so a rule does not trip on prose. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
const codeLines = (f: string) => stripComments(read(f)).split('\n').map((text, i) => ({ text, n: i + 1 }));

const MONEY_DIR = path.join(SRC, 'lib', 'money');
const centavosFile = path.join(MONEY_DIR, 'centavos.ts');
const EXPORTS = ['storedPesosToCentavos', 'parsePesoInput', 'roundHalfUp', 'allocate', 'toWirePesos', 'getNonCentavoCount', 'resetNonCentavoCount'];

describe('the money module exists and is the only rounder (Acceptance 1, 3; Ruling 1; DEF-003)', () => {
  it('apps/pos/src/lib/money/centavos.ts exports the seven contract names. Mutant: logic left in tax.ts/money.ts', () => {
    expect(existsSync(centavosFile)).toBe(true);
    const src = read(centavosFile);
    for (const name of EXPORTS) expect(src, name).toMatch(new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${name}\\b`));
  });

  it('lib/money.ts only re-exports (no Math.round of its own). Mutant: a second rounding implementation kept for old imports', () => {
    const file = path.join(SRC, 'lib', 'money.ts');
    const src = stripComments(read(file));
    expect(hits(file, /Math\.round|toFixed|EPSILON/)).toEqual([]);
    expect(src).toMatch(/from\s+['"](@\/lib\/money\/centavos|\.\/money\/centavos)['"]/);
    expect(src).toMatch(/\broundMoney\b/);
  });

  it('tax.ts has no private round() and no Math.round, and gets its arithmetic from the money module. Mutant: the duplicate rounder surviving (DEF-003)', () => {
    const src = stripComments(read(path.join(SRC, 'lib', 'tax.ts')));
    expect(src).not.toMatch(/function\s+round\s*\(/);
    expect(src).not.toMatch(/\bconst\s+round\s*=/);
    expect(src).not.toMatch(/Math\.round|EPSILON/);
    expect(src).toMatch(/from\s+['"](@\/lib\/money\/centavos|\.\/money\/centavos)['"]/);
    expect(src).toMatch(/export\s+function\s+calculateBillTotalsCentavos\b/);
    expect(src).toMatch(/export\s+function\s+calculateBillTotals\b/);
  });

  // Each exception: why it is allowed to keep its own rounding for now.
  const ROUNDING_EXCEPTIONS: Record<string, string> = {
    'components/cashier/CashHandoverClient.tsx': 'cash-handover form, not a payment writer; lib/cash/handover.ts (the shared maths) moves to the module, this screen is PC-5/PC-6',
    'components/receipts/RefundReceiptDialog.tsx': 'refund proration; refunds are T-424',
    'components/reservations/ReservationPaymentModal.tsx': 'reservation deposit entry; reservations are out of T-423 scope',
  };
  it('across ALL of apps/pos/src no money rounding lives outside lib/money/ (Math.round on a *100 amount, toFixed(2) parsed back), except listed files. Mutant: ad-hoc rounding', () => {
    const files = appFiles();
    expect(files.length).toBeGreaterThan(200); // the walk really covered the tree
    const offenders: string[] = [];
    for (const f of files) {
      if (f.startsWith(MONEY_DIR + path.sep) || rel(f) in ROUNDING_EXCEPTIONS) continue;
      for (const { text, n } of codeLines(f)) {
        const mathRoundMoney = /Math\.round\(/.test(text) && /\*\s*100\b|\bEPSILON\b/.test(text);
        // `Number(x.toFixed(2))` / `parseFloat((a*b).toFixed(2))`: toFixed INSIDE the parse call. `Number(x).toFixed(2)` is display, allowed.
        const toFixedParsed = /\b(parseFloat|Number)\((?:[^()]|\([^()]*\))*\.toFixed\(\s*2\s*\)\s*\)/.test(text);
        if (mathRoundMoney || toFixedParsed) offenders.push(`${rel(f)}:${n}  ${text.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every listed rounding exception still names a real file with a reason (the list cannot rot)', () => {
    for (const [file, why] of Object.entries(ROUNDING_EXCEPTIONS)) {
      expect(existsSync(path.join(SRC, file)), file).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});

describe('payment writers convert pesos and centavos only through the module (Acceptance 4)', () => {
  const WRITERS = [
    'components/cashier/firestore.ts',
    'components/cashier/offlinePayment.ts',
    'components/cashier/payment-modal.tsx',
    'lib/offline/offlinePaymentSummary.ts',
    'lib/cash/handover.ts',
  ];
  /** A `/ 100` that turns a PERCENT into a fraction is not money conversion. */
  const PERCENTISH = /pct|percent|rate|\.value\b|discountValue|\bvalue\b\s*\|\||adj\./i;
  const LISTED: Record<string, string> = {}; // "file:line-text-fragment" -> reason; empty on purpose

  it('each writer imports the money module. Mutant: a writer that still does its own cents maths', () => {
    for (const w of WRITERS) {
      const f = path.join(SRC, w);
      expect(existsSync(f), w).toBe(true);
      expect(read(f), w).toMatch(/from\s+['"](@\/lib\/money\/centavos|(\.\.?\/)+money\/centavos|\.\/centavos)['"]/);
    }
  });

  it('no `* 100` and no non-percent `/ 100` in a payment writer. Mutant: an ad-hoc conversion bypassing the module', () => {
    const offenders: string[] = [];
    for (const w of WRITERS) {
      const f = path.join(SRC, w);
      if (!existsSync(f)) continue;
      for (const { text, n } of codeLines(f)) {
        const times = /\*\s*100\b/.test(text);
        const divides = /\/\s*100\b/.test(text) && !PERCENTISH.test(text);
        if ((times || divides) && !Object.keys(LISTED).some((k) => `${w}:${text}`.includes(k))) {
          offenders.push(`${w}:${n}  ${text.trim().slice(0, 110)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('one series per tablet, no localStorage counter (Acceptance 8; Rulings 4, 5, 8; row 276)', () => {
  const TERMINAL = path.join(SRC, 'lib', 'terminal');

  it('lib/terminal/ exists with counter.ts and claim.ts. Mutant: numbering logic scattered elsewhere', () => {
    expect(existsSync(path.join(TERMINAL, 'counter.ts'))).toBe(true);
    expect(existsSync(path.join(TERMINAL, 'claim.ts'))).toBe(true);
  });

  it('nothing under lib/terminal/ references localStorage or sessionStorage. Mutant: row 276 regression (counter in localStorage)', () => {
    const files = walk(TERMINAL).filter((f) => isCode(f) && !/\.test\./.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) expect(stripComments(read(f)), rel(f)).not.toMatch(/\b(localStorage|sessionStorage)\b/);
  });

  it('counter.ts uses native indexedDB, read lazily. Mutant: a dependency, or an IndexedDB handle captured at import time', () => {
    const src = stripComments(read(path.join(TERMINAL, 'counter.ts')));
    expect(src).toMatch(/indexedDB/);
    expect(src).not.toMatch(/from\s+['"](idb|idb-keyval|dexie|localforage|fake-indexeddb)['"]/);
    expect(src).not.toMatch(/^\s*(export\s+)?const\s+\w+\s*=\s*(globalThis\.|window\.)?indexedDB\b/m);
  });

  it('claim.ts reaches Firestore only through the injected port (type-only imports). Mutant: a hard dependency that makes it untestable', () => {
    const src = stripComments(read(path.join(TERMINAL, 'claim.ts')));
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+['"](firebase\/firestore|@\/lib\/firebase\/client)['"]/gm)) {
      throw new Error(`claim.ts has a runtime import: ${m[0].trim()}`);
    }
  });

  it('offlineReceiptNumber.ts and its test are deleted, and nothing refers to the daily counter. Mutant: DEF-587 daily reset surviving', () => {
    expect(existsSync(path.join(SRC, 'lib', 'offline', 'offlineReceiptNumber.ts'))).toBe(false);
    expect(existsSync(path.join(SRC, 'lib', 'offline', 'offlineReceiptNumber.test.ts'))).toBe(false);
    for (const f of walk(SRC).filter((x) => isCode(x) && !/receipt-number\.test|money-guards/.test(x))) {
      const text = stripComments(read(f));
      expect(text, rel(f)).not.toMatch(/offlineReceiptNumber|nextDailySeq|formatOfflineReceiptNumber|pos_offline_seq/);
    }
  });

  it('no shipping code touches counters/receipts or carries the SELIP default. Mutant: a second series (DEF-002) / v1\'s counter written by v2 (Ruling 8)', () => {
    for (const f of appFiles()) {
      const text = stripComments(read(f));
      expect(text, rel(f)).not.toMatch(/['"`/]counters['"`]|\/counters\b/);
      expect(text, rel(f)).not.toMatch(/SELIP-#|SELIP-0/);
    }
  });

  it('the Receipt type carries the three additive fields. Mutant: fields written but untyped', () => {
    const types = stripComments(read(path.join(SRC, 'lib', 'types.ts')));
    const receipt = types.slice(types.indexOf('export type Receipt '));
    for (const field of ['terminalNo', 'terminalSeq', 'deviceId']) expect(receipt.slice(0, 4000), field).toMatch(new RegExp(`\\b${field}\\??:`));
  });

  it('no new dependency was added for IndexedDB or tests (Ruling 5, task rules). Mutant: idb/dexie/fake-indexeddb in package.json', () => {
    const bad = /^(idb|idb-keyval|dexie|localforage|fake-indexeddb)$/;
    for (const pj of [path.join(POS, 'package.json'), path.join(repoRoot, 'package.json')]) {
      const j = JSON.parse(read(pj));
      for (const section of ['dependencies', 'devDependencies']) for (const dep of Object.keys(j[section] ?? {})) expect(dep, `${pj}`).not.toMatch(bad);
    }
  });
});

describe('the vendored v1 tax fixture (Ruling 3)', () => {
  const fixture = path.join(SRC, 'lib', '__fixtures__', 'tax-v1.ts');

  it('exists, is listed in V1-COPY.md under "Test fixtures", and no shipping code imports it. Mutant: the golden reference drifting or leaking into the app', () => {
    expect(existsSync(fixture)).toBe(true);
    const doc = read(path.join(POS, 'V1-COPY.md'));
    expect(doc).toMatch(/##\s+Test fixtures/);
    expect(doc).toMatch(/__fixtures__\/tax-v1\.ts/);
    for (const f of appFiles()) expect(read(f), rel(f)).not.toMatch(/__fixtures__\/tax-v1/);
  });

  const V1_REPO = 'C:/Users/ianla/webapps/POS';
  const V1_COMMIT = 'e26d0c1';
  let v1: string | null = null;
  try {
    v1 = execFileSync('git', ['-C', V1_REPO, 'show', `${V1_COMMIT}:src/lib/tax.ts`], { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    console.warn(`[T-423 fixture] ${V1_REPO} @ ${V1_COMMIT} not available - byte comparison skipped (expected in CI).`);
  }
  it.skipIf(v1 === null)('is byte-identical to v1 src/lib/tax.ts at e26d0c1 (line endings aside). Mutant: a "fixed" copy that makes the golden test pass by construction', () => {
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    expect(norm(read(fixture))).toBe(norm(v1!));
  });
});

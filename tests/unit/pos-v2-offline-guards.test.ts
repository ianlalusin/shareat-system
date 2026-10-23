/**
 * T-425 slice T - tree guards for POS v2 offline selling. `docs/tasks/425-pos-v2-offline.md` Acceptance 9 (no sales-critical state in localStorage;
 * no direct `navigator.onLine`), 14 (runbook text), and the wiring Rulings 1, 3, 4, 5, 7, 8 that unit tests cannot see (who calls whom). Reads the
 * tree with fs; never imports app code. Every test names the mutant it kills. A guard that would pass on an empty tree first asserts that the thing
 * it polices exists, so it is red until the builder lands it.
 *
 * Exceptions are LISTED, each with a reason; the builder may shorten a list but must not widen one without telling the planner.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const POS = path.join(repoRoot, 'apps', 'pos');
const SRC = path.join(POS, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const at = (r: string) => path.join(SRC, r);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const isCode = (f: string) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f);
const isTest = (f: string) => /\.test\.(ts|tsx)$/.test(f) || rel(f).startsWith('test-helpers/') || rel(f).includes('/__fixtures__/') || rel(f).includes('/__soak__/');
const appFiles = () => walk(SRC).filter((f) => isCode(f) && !isTest(f));

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
const code = (f: string) => stripComments(read(f));
const codeLines = (f: string) => code(f).split('\n').map((text, i) => ({ text, n: i + 1 }));
const hits = (f: string, re: RegExp) => codeLines(f).filter((l) => re.test(l.text)).map((l) => `${rel(f)}:${l.n}`);
/** Does the file (comments stripped) import from a module whose path matches `re`? */
const imports = (f: string, re: RegExp) => [...code(f).matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) => re.test(m[1]!));

const NEW_MODULES = [
  'lib/terminal/db.ts', 'lib/outbox/ledger.ts', 'lib/outbox/reconcile.ts', 'lib/outbox/linesHash.ts', 'lib/outbox/effects-store.ts',
  'lib/outbox/offlinePeriod.ts', 'lib/outbox/unsentBanner.ts', 'lib/outbox/updateGate.ts', 'lib/offline/offlineRules.ts',
  'lib/printing/xSlipFormatter.ts', 'hooks/useConnectivity.ts', 'app/api/pos2/health/route.ts',
];

describe('the offline modules exist (non-vacuous)', () => {
  it.each(NEW_MODULES)('%s exists. Mutant: a guard below passing on an empty tree', (m) => {
    expect(existsSync(at(m)), m).toBe(true);
  });
});

describe('no sales-critical state in localStorage (Acceptance 9, Ruling 1, 3, 7; bible row 276)', () => {
  const LS = /\b(localStorage|sessionStorage)\b/;
  const scope = () => [
    ...walk(at('lib/outbox')).filter((f) => isCode(f) && !isTest(f)),
    ...walk(at('lib/offline')).filter((f) => isCode(f) && !isTest(f)),
    ...walk(at('lib/terminal')).filter((f) => isCode(f) && !isTest(f)),
    at('hooks/useConnectivity.ts'),
  ].filter((f) => existsSync(f));
  const EXCEPTIONS: Record<string, string> = {
    'lib/offline/device.ts': 'the install\'s device id (KVStore injected); identity, not a sale, an effect, the offline period or an X-slip',
    'lib/offline/browserDevice.ts': 'binds the device id to window.localStorage; identity only',
    'lib/outbox/effects-store.ts': 'reads the LEGACY offline_payment_queue key ONCE to migrate it into IndexedDB, then removes it (Ruling 3)',
  };

  it('no ledger, effects, connectivity, offline-period or X-slip file touches localStorage/sessionStorage, except the listed ones. Mutant: a queue or timer kept in localStorage', () => {
    const files = scope();
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) => !(rel(f) in EXCEPTIONS)).flatMap((f) => hits(f, LS));
    expect(offenders).toEqual([]);
  });

  it('every listed exception is a real file and (for the migration) only names the legacy key. Mutant: the exception list rotting or widening', () => {
    for (const [f, why] of Object.entries(EXCEPTIONS)) {
      expect(why.length).toBeGreaterThan(10);
      if (f === 'lib/outbox/effects-store.ts') {
        expect(existsSync(at(f)), f).toBe(true);
        const uses = hits(at(f), LS);
        expect(uses.length).toBeGreaterThan(0); // it must really do the migration
        expect(code(at(f))).toMatch(/offline_payment_queue/);
        expect(code(at(f))).not.toMatch(/(set|get)Item\(\s*['"](?!offline_payment_queue)/);
      }
    }
  });

  it('the old localStorage queue module no longer owns the queue: payment-queue.ts has no localStorage (deleted, or a shim over the effects store). Mutant: a second, divergent queue', () => {
    const f = at('lib/offline/payment-queue.ts');
    if (existsSync(f)) expect(hits(f, LS)).toEqual([]);
  });

  it('the sync hook drains the IndexedDB effects store, not the old queue. Mutant: effects replayed from localStorage', () => {
    const f = at('hooks/use-payment-queue-sync.ts');
    expect(imports(f, /outbox\/effects-store/)).toBe(true);
    expect(hits(f, LS)).toEqual([]);
  });
});

describe('connectivity is one store; nobody reads navigator.onLine (Acceptance 9, 10; Ruling 4; DEF-017)', () => {
  const ONLINE = /navigator\.onLine|['"]onLine['"]\s+in\s+navigator/;
  const EXCEPTIONS: Record<string, string> = {
    'hooks/useConnectivity.ts': 'the store may seed its first guess from the browser flag; it is the ONE place',
    'lib/payments/proof/capture.ts': 'proof-photo outbox flush guard, not a sale or a connectivity decision; replace with the store when T-425 S3 touches it',
  };
  it('no direct navigator.onLine across apps/pos/src outside the hook (and the listed file). Mutant: a second, wrong source of truth for "online"', () => {
    const offenders = appFiles().filter((f) => !(rel(f) in EXCEPTIONS)).flatMap((f) => hits(f, ONLINE));
    expect(offenders).toEqual([]);
  });
  it('the exception list names real files with reasons', () => {
    for (const [f, why] of Object.entries(EXCEPTIONS)) { expect(existsSync(at(f)), f).toBe(true); expect(why.length).toBeGreaterThan(10); }
  });
  it('useOnlineStatus is a thin wrapper over the store; OfflineBanner and firestore.ts use it and register no browser online/offline listeners of their own', () => {
    expect(imports(at('hooks/use-online-status.ts'), /useConnectivity/)).toBe(true);
    expect(hits(at('hooks/use-online-status.ts'), /addEventListener/)).toEqual([]);
    const banner = at('components/shared/OfflineBanner.tsx');
    expect(imports(banner, /useConnectivity|use-online-status/)).toBe(true);
    expect(hits(banner, /addEventListener\(\s*['"](online|offline)['"]/)).toEqual([]);
    expect(imports(at('components/cashier/firestore.ts'), /useConnectivity/)).toBe(true);
  });
});

describe('one shared opener for shareat-pos-terminal (Ruling 1 ✎R2; Acceptance 5)', () => {
  it('only lib/terminal/db.ts names the database or calls indexedDB.open for it. Mutant: counter.ts keeps its hard-coded version 1 and throws VersionError after the upgrade', () => {
    const db = at('lib/terminal/db.ts');
    expect(existsSync(db)).toBe(true);
    expect(code(db)).toMatch(/shareat-pos-terminal/);
    const offenders = appFiles().filter((f) => f !== db).flatMap((f) => hits(f, /shareat-pos-terminal/));
    expect(offenders).toEqual([]);
  });
  it('counter.ts, the ledger, the effects store and the offline-period store all open through openTerminalDb and never call .open( themselves', () => {
    for (const f of ['lib/terminal/counter.ts', 'lib/outbox/ledger.ts', 'lib/outbox/effects-store.ts', 'lib/outbox/offlinePeriod.ts']) {
      expect(existsSync(at(f)), f).toBe(true);
      expect(imports(at(f), /(^|\/)db$/), `${f} imports the shared opener`).toBe(true);
      expect(hits(at(f), /\.open\(/), f).toEqual([]);
    }
  });
});

describe('the payment and void writers go through the ledger and the rules (Rulings 1, 3, 5)', () => {
  it('offlinePayment.ts reserves through the ledger (not reserveNext), builds its batch with applyOpsToBatch, uses the offline rules, and queues effects in IndexedDB. Mutant: a sale outside the ledger', () => {
    const f = at('components/cashier/offlinePayment.ts');
    const c = code(f);
    expect(c).toMatch(/await\s+reserveOfflineSaleIntent\s*\(/);
    expect(c).not.toMatch(/\breserveOfflineEvent\b/);
    expect(c).toMatch(/\bapplyOpsToBatch\b/);
    expect(c).not.toMatch(/\breserveNext\b/);
    expect(imports(f, /offline\/offlineRules/)).toBe(true);
    expect(c).toMatch(/buildOfflineTenders/);
    expect(c).toMatch(/assertOfflineSessionOwner/);
    expect(c).not.toMatch(/\baddToQueue\b/);
    expect(imports(f, /outbox\/effects-store/)).toBe(true);
  });
  it('offlineVoid.ts is manager/admin only, owner-checked, and ledger-first with voidedOffline. Mutant: any role voiding offline', () => {
    const f = at('components/cashier/offlineVoid.ts');
    const c = code(f);
    expect(c).toMatch(/assertOfflineVoidAllowed/);
    expect(c).toMatch(/assertOfflineSessionOwner/);
    expect(c).toMatch(/\breserveOfflineEvent\b/);
    expect(c).toMatch(/\bapplyOpsToBatch\b/);
    expect(c).toMatch(/voidedOffline/);
  });
  it('the online sale (firestore.ts) records reserved -> acknowledged / skipped in the ledger. Mutant: an unexplained number gap after a failed online sale', () => {
    const c = code(at('components/cashier/firestore.ts'));
    expect(c).toMatch(/\breserveOnlineEvent\b/);
    expect(c).toMatch(/\bmarkAcknowledged\b/);
    expect(c).toMatch(/\bmarkSkipped\b/);
  });
  it('the payment modal, the void dialog and the refund dialog use the offline rules (disabled card/QR Ph, manager-only void, refund blocked). Mutant: UI that offers what the rules forbid', () => {
    expect(imports(at('components/cashier/payment-modal.tsx'), /offline\/offlineRules/)).toBe(true);
    expect(imports(at('components/cashier/void-session-dialog.tsx'), /offline\/offlineRules/)).toBe(true);
    expect(imports(at('components/receipts/RefundReceiptDialog.tsx'), /offline\/offlineRules/)).toBe(true);
  });
  it('lib/offline/commit.ts is unchanged in spirit: commitLocalFirst still never awaits the commit', () => {
    const c = code(at('lib/offline/commit.ts'));
    expect(c).toMatch(/void\s+batch\.commit\(\)/);
    expect(c).not.toMatch(/await\s+batch\.commit/);
  });
});

describe('the banner and the X-slip are mounted (Rulings 6, 7)', () => {
  it('some shipped screen-level file imports the unsent banner and the X-slip formatter. Mutant: a pure function nobody calls', () => {
    const files = appFiles();
    expect(files.some((f) => imports(f, /outbox\/unsentBanner/) && !rel(f).startsWith('lib/outbox/'))).toBe(true);
    expect(files.some((f) => imports(f, /printing\/xSlipFormatter/) && !rel(f).startsWith('lib/printing/'))).toBe(true);
    expect(files.some((f) => imports(f, /outbox\/updateGate/) && !rel(f).startsWith('lib/outbox/'))).toBe(true);
  });
  it('the X-slip goes through printHub like every other print. Mutant: a private print path', () => {
    const users = appFiles().filter((f) => imports(f, /printing\/xSlipFormatter/) && !rel(f).startsWith('lib/printing/'));
    expect(users.length).toBeGreaterThan(0);
    expect(users.some((f) => imports(f, /printing\/printHub/) || imports(f, /hooks\/use-print/))).toBe(true);
  });
});

describe('no ad-hoc money maths in the new outbox code (T-423 money rules carry over)', () => {
  it('no Math.round, `* 100` or toFixed-then-parse in lib/outbox/** or offlineRules.ts. Mutant: a second rounder', () => {
    const files = [...walk(at('lib/outbox')).filter((f) => isCode(f) && !isTest(f)), at('lib/offline/offlineRules.ts')].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) => hits(f, /Math\.round\(|\*\s*100\b|\b(parseFloat|Number)\((?:[^()]|\([^()]*\))*\.toFixed\(/));
    expect(offenders).toEqual([]);
  });
});

describe('update and reinstall safety is APK-first (Ruling 8; Acceptance 14)', () => {
  it('the service worker is left as it is (still skipWaiting; the SW is web-only). Mutant: changing the SW to "protect" a tablet that never runs it', () => {
    const sw = read(path.join(POS, 'public', 'sw.js'));
    expect(sw).toMatch(/skipWaiting\(\)/);
    expect(sw).toMatch(/clients\.claim\(\)/);
  });
  const runbook = path.join(repoRoot, 'docs', 'ops', 'pos2-runbook.md');
  const soak = path.join(repoRoot, 'docs', 'ops', 'pos2-soak.md');
  it('the runbook says never to install a debug build on a store tablet and never to install an older APK over a newer one', () => {
    const t = read(runbook);
    expect(t).toMatch(/never install (a|any) debug build/i);
    expect(t).toMatch(/never install an? (older|previous) (APK|build)/i);
  });
  it('the runbook contains the in-place-update-during-an-outage test and the health-route ship precondition', () => {
    const t = read(runbook);
    expect(t).toMatch(/in-place[\s\S]{0,200}update[\s\S]{0,200}outage|update[\s\S]{0,120}in place[\s\S]{0,200}outage/i);
    expect(t).toMatch(/\/api\/pos2\/health/);
    expect(t).toMatch(/before any tablet runs a v2 APK|before (any|a) (tablet|v2 APK)/i);
  });
  it('docs/ops/pos2-soak.md lists the real-device checks: kill within 1 s of a payment, airplane-mode flapping, in-place APK update during an outage, Android Clear cache, health route first', () => {
    expect(existsSync(soak)).toBe(true);
    const t = read(soak);
    expect(t).toMatch(/within 1 s/i);
    expect(t).toMatch(/airplane/i);
    expect(t).toMatch(/in-place/i);
    expect(t).toMatch(/clear cache/i);
    expect(t).toMatch(/\/api\/pos2\/health/);
  });
});

describe('the soak verifier is read-only (Ruling 10)', () => {
  const f = path.join(POS, 'scripts', 'pos2-soak-verify.mjs');
  it('exists, exports classifyTerminalReceipts and performs no Firestore write. Mutant: a "verifier" that edits what it audits', () => {
    expect(existsSync(f)).toBe(true);
    const c = stripComments(read(f));
    expect(c).toMatch(/export\s+(async\s+)?function\s+classifyTerminalReceipts\b|export\s*\{[^}]*classifyTerminalReceipts/);
    expect(c).not.toMatch(/\.(set|update|delete|create|add)\(|\bbatch\(|\.commit\(|runTransaction|setDoc\(|updateDoc\(|deleteDoc\(|writeBatch\(/);
  });
});

describe('tests never require a specific lane database name (Acceptance 16)', () => {
  it('no POS or guard test pins a lane/test database name or URL. Mutant: a test that only passes on one lane\'s database', () => {
    const tests = [
      ...walk(SRC).filter((x) => /\.test\.(ts|tsx)$/.test(x)),
      ...walk(path.join(repoRoot, 'tests', 'unit')).filter((x) => /^pos-v2-.*\.test\.ts$/.test(path.basename(x)) && !x.endsWith('pos-v2-offline-guards.test.ts')),
    ];
    expect(tests.length).toBeGreaterThan(10);
    const offenders = tests.flatMap((t) => read(t).split('\n').map((l, i) => ({ l, i })).filter(({ l }) => /shareat_lane|\blane[_-]?db\b|shareat_t\d+\b|shareat_gate|postgres(ql)?:\/\/[^'"\s]*\/shareat\w*/i.test(l)).map(({ i }) => `${path.relative(repoRoot, t)}:${i + 1}`));
    expect(offenders).toEqual([]);
  });
});

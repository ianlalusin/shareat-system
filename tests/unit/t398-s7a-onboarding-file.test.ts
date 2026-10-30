/**
 * T-398 S7a (TESTER) - the onboarding data file: schema, parser, guards, MOCK fixture (O12, O13, O14).
 * docs/tasks/398-s7/S7-REFRESH.md s4 (file + guards), s11 (O12-O14), s12 (no real data in git).
 *
 * RED TODAY for one reason: packages/domain/src/organizations/onboarding-file.ts does not exist (each leg imports it dynamically, so each
 * fails on its own line with "Failed to resolve import"). The MOCK-file shape legs (M*) are GREEN-AS-GUARD today: the committed
 * scripts/fixtures/onboarding/MOCK-padre-garcia.onboarding.json is part of this tester round.
 *
 * ASSUMED NAMES the builder must match (the refresh pins the module path and the rules, not the exports):
 *   parseOnboardingFile(raw: unknown): OnboardingFile              pure; throws Error whose message NAMES an unknown key (O13)
 *   assertOnboardingFileAllowed(file, { path, repoRoot, env })      pure; throws (O12 mock-vs-production, s4 guard 2 non-mock-inside-repo)
 *       env: { NODE_ENV?, SYSTEM_DATABASE_URL?, PRODUCTION_DB_HOSTS? }  (production host = scripts/lib/rehearsal/guards.ts PINNED_PRODUCTION_HOSTS
 *       plus PRODUCTION_DB_HOSTS, matched on host only)
 *   assertFileMatchesStoreMap(file, rows: StoreMapRow[]): void      pure; throws (O14, K11) - rows are packages/etl store-map rows
 * Refusals carry no password and no connection string.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MOCK_PATH = join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json');
const mockRaw = (): Record<string, unknown> => JSON.parse(readFileSync(MOCK_PATH, 'utf8'));
const PROD_HOST = 'shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com';
const prodUrl = (p = 25060) => `postgres://u:pw-never-echo@${PROD_HOST}:${p}/shareat`;
const LOCAL_URL = 'postgres://postgres:pw@localhost:5435/shareat_test';

const mod = () => import('../../packages/domain/src/organizations/onboarding-file');
const parse = async (raw: unknown) => (await mod()).parseOnboardingFile(raw);
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return String((e as Error).message);
  }
  return '';
};

describe('M - the committed MOCK file (guard: green today)', () => {
  it('every name starts with Mock, every email ends @example.test, POS id and org code are mock, "mock": true', () => {
    const f = mockRaw() as any;
    expect(f.mock).toBe(true);
    expect(f.org.code).toBe('MOCK_PG');
    expect(f.store.posStoreId).toBe('MOCK-POS-STORE-0001');
    for (const p of [f.franchisorPerson, f.owner, ...f.staff]) expect(p.last).toMatch(/^Mock/);
    for (const p of [f.franchisorPerson, f.owner]) expect(p.email).toMatch(/@example\.test$/);
    expect(f.org.name).toMatch(/^Mock/);
    expect(f.store.name).toMatch(/^Mock/);
  });
  it('positions are among the six row-362 names (mutant: a staff row naming "Cook")', () => {
    const six = ['Cashier', 'Kitchen Staff', 'Server', 'Dishwasher', 'Slicer', 'Inventory Staff'];
    for (const s of (mockRaw() as any).staff) expect(six).toContain(s.position);
  });
  it('carries no PIN, password, bank, TIN, SSS/PhilHealth/Pag-IBIG or pay-rate key (mutant: real-looking data riding in the fixture)', () => {
    expect(readFileSync(MOCK_PATH, 'utf8')).not.toMatch(/"(pin|password|bank\w*|tin|sss|philhealth|pagibig|\w*rate|salary)"/i);
  });
});

describe('S7a - parseOnboardingFile', () => {
  it('accepts the MOCK file and returns its parts (mutant: schema stricter than the committed shape)', async () => {
    const f = await parse(mockRaw());
    expect(f.org.code).toBe('MOCK_PG');
    expect(f.staff).toHaveLength(2);
    expect(f.commissary.creditLimit).toBeNull();
  });

  // O13. Mutant: a deny-list that misses one name. Every key below must be refused AND named; plus an invented key no list could know.
  it.each(['pin', 'tin', 'bankAccount', 'password', 'sss', 'philhealth', 'pagibig', 'payRate', 'dailyRate', 'totallyNewKey'])(
    'O13: an extra top-level field "%s" is refused, naming it',
    async (key) => {
      const raw = { ...mockRaw(), [key]: 'x' };
      const { parseOnboardingFile } = await mod();
      expect(message(() => parseOnboardingFile(raw))).toContain(key);
    },
  );
  it('O13: an extra field nested in owner / staff / store / org / agreement / commissary / franchisorPerson is refused, naming it (mutant: strict at top level only)', async () => {
    const { parseOnboardingFile } = await mod();
    const base = mockRaw() as any;
    const variants: Array<[string, string, any]> = [
      ['owner', 'pin', { ...base, owner: { ...base.owner, pin: '1234' } }],
      ['staff', 'tin', { ...base, staff: [{ ...base.staff[0], tin: '123-456' }] }],
      ['store', 'bankAccount', { ...base, store: { ...base.store, bankAccount: '000' } }],
      ['org', 'tin', { ...base, org: { ...base.org, tin: '1' } }],
      ['agreement', 'payRate', { ...base, agreement: { ...base.agreement, payRate: 1 } }],
      ['commissary', 'password', { ...base, commissary: { ...base.commissary, password: 'x' } }],
      ['franchisorPerson', 'sss', { ...base, franchisorPerson: { ...base.franchisorPerson, sss: '1' } }],
    ];
    for (const [where, key, raw] of variants) {
      const m = message(() => parseOnboardingFile(raw));
      expect(m, `${where}: must refuse`).not.toBe('');
      expect(m, `${where}: must name the field ${key}`).toContain(key);
    }
  });
  it('refusal text never echoes the offending VALUE (mutant: dumping the whole file into the message)', async () => {
    const { parseOnboardingFile } = await mod();
    expect(message(() => parseOnboardingFile({ ...mockRaw(), tin: '987-654-321-000' }))).not.toContain('987-654-321-000');
  });
  it('refuses a missing required part, a position outside the six, a non-ISO salesVisibleFrom, a blank org code, a non-boolean mock (mutant: loose schema)', async () => {
    const { parseOnboardingFile } = await mod();
    const base = mockRaw() as any;
    const { owner: _o, ...noOwner } = base;
    expect(message(() => parseOnboardingFile(noOwner))).not.toBe('');
    expect(message(() => parseOnboardingFile({ ...base, staff: [{ ...base.staff[0], position: 'Cook' }] }))).not.toBe('');
    expect(message(() => parseOnboardingFile({ ...base, agreement: { salesVisibleFrom: '1 Jan 2027' } }))).not.toBe('');
    expect(message(() => parseOnboardingFile({ ...base, org: { ...base.org, code: '  ' } }))).not.toBe('');
    expect(message(() => parseOnboardingFile({ ...base, mock: 'yes' }))).not.toBe('');
  });
});

describe('S7a - assertOnboardingFileAllowed', () => {
  const OUTSIDE = join(tmpdir(), 'onboarding', 'padre-garcia.json');
  const INSIDE = join(repoRoot, 'scratch-onboarding', 'padre-garcia.json');
  const allow = async (file: unknown, path: string, env: Record<string, string | undefined>) => {
    const m = await mod();
    return message(() => m.assertOnboardingFileAllowed(m.parseOnboardingFile(file), { path, repoRoot, env }));
  };

  // O12. Mutant: guard on NODE_ENV only.
  it('O12: mock file + NODE_ENV=production is refused', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'production', SYSTEM_DATABASE_URL: LOCAL_URL })).not.toBe('');
  });
  it('O12: mock file + NODE_ENV UNSET + SYSTEM_DATABASE_URL on the production host is refused (mutant: NODE_ENV-only guard)', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: undefined, SYSTEM_DATABASE_URL: prodUrl() })).not.toBe('');
  });
  it('O12: the pooler port (25061) is the same host and is refused too (mutant: host+port compare)', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: prodUrl(25061) })).not.toBe('');
  });
  it('O12: a host added through PRODUCTION_DB_HOSTS counts (mutant: pinned host only)', async () => {
    expect(
      await allow(mockRaw(), MOCK_PATH, {
        NODE_ENV: 'development',
        SYSTEM_DATABASE_URL: 'postgres://u:p@db.other-prod.example.test:5432/x',
        PRODUCTION_DB_HOSTS: 'db.other-prod.example.test',
      }),
    ).not.toBe('');
  });
  it('O12: the refusal carries neither the password nor the connection string', async () => {
    const m = await allow(mockRaw(), MOCK_PATH, { NODE_ENV: undefined, SYSTEM_DATABASE_URL: prodUrl() });
    expect(m).not.toBe('');
    expect(m).not.toContain('pw-never-echo');
    expect(m).not.toContain('postgres://');
  });
  it('O12 control: mock file on a local test database is allowed (mutant: refuse every mock file)', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: LOCAL_URL })).toBe('');
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'test', DATABASE_URL: LOCAL_URL })).toBe('');
  });

  // The real connection is SYSTEM_DATABASE_URL ?? DATABASE_URL (packages/db/src/client.ts:98), so the guard must judge the same one.
  it('O12: SYSTEM_DATABASE_URL unset but DATABASE_URL on the production host is refused - Mutant: guard reads SYSTEM_DATABASE_URL only', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: undefined, DATABASE_URL: prodUrl() })).not.toBe('');
  });
  it('O12: SYSTEM_DATABASE_URL blank and DATABASE_URL on the production host is refused - Mutant: blank treated as set, so the fallback is never consulted', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: '  ', DATABASE_URL: prodUrl() })).not.toBe('');
  });
  it('O12: BOTH database URLs empty or unset is refused (no database to judge) - Mutant: an unset pair counts as not-production', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development' })).not.toBe('');
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: '', DATABASE_URL: ' ' })).not.toBe('');
  });
  it('O12 control: a local SYSTEM_DATABASE_URL wins over a production DATABASE_URL, as the connection would (not over-refusing)', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: LOCAL_URL, DATABASE_URL: prodUrl() })).toBe('');
  });
  it('guard 2: a NON-mock file inside the repo is refused, outside is allowed (mutant: path check dropped / inverted)', async () => {
    const real = { ...mockRaw(), mock: false };
    expect(await allow(real, INSIDE, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: LOCAL_URL })).not.toBe('');
    expect(await allow(real, OUTSIDE, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: LOCAL_URL })).toBe('');
  });
  it('guard 2 does not apply to the committed mock file (it lives in the repo by design)', async () => {
    expect(await allow(mockRaw(), MOCK_PATH, { NODE_ENV: 'development', SYSTEM_DATABASE_URL: LOCAL_URL })).toBe('');
  });
});

describe('S7a - O14 assertFileMatchesStoreMap (K11)', () => {
  const row = (over: Record<string, string> = {}) => ({
    v1StoreId: 'y1DMgfisuTHBF57cNL6i',
    name: 'Padre Garcia',
    role: 'franchise' as const,
    orgCode: 'MOCK_PG',
    storeCode: 'MPG',
    ...over,
  });
  const check = async (rows: any[]) => {
    const m = await mod();
    return message(() => m.assertFileMatchesStoreMap(m.parseOnboardingFile(mockRaw()), rows));
  };
  it('matching org_code, store_code and v1 store id passes', async () => {
    expect(await check([row()])).toBe('');
  });
  it('O14: a different org_code is refused (mutant: checked only at T-391 time = no check here)', async () => {
    expect(await check([row({ orgCode: 'PADRE_GARCIA' })])).not.toBe('');
  });
  it('O14: a different store_code is refused', async () => {
    expect(await check([row({ storeCode: 'PG' })])).not.toBe('');
  });
  it('O14: a different v1 store id is refused (the file names y1DM..., the map names another store)', async () => {
    expect(await check([row({ v1StoreId: 'someOtherV1StoreId000' })])).not.toBe('');
  });
  it('O14: no row for the file v1 store at all is refused (mutant: matching rows by org_code alone)', async () => {
    expect(await check([row({ v1StoreId: 'unrelated', orgCode: 'OWN', storeCode: 'LIPA', role: 'own' })])).not.toBe('');
  });
});

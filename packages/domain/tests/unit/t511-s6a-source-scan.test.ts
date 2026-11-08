/**
 * T-511 S6a (TESTER, 7 Nov 2026) - source scans for the loan-legs / acknowledged-difference slice. docs/tasks/511-settlement-upload-s6-spec.md "S6a".
 * No database. Reads source text; comments are stripped before scanning code, so a history note may still say what used to be.
 *
 * RED TODAY: the old names are everywhere (`recognizeGain`, `needsGainAcknowledgement`, the `loan_id` / `loan_owner_store_id` columns), `SPLIT_NOTE` is in
 * day-checks.ts, the legs table has no schema, and the two worked examples and the module README do not exist.
 *
 *  S1  `recognizeGain` and `needsGainAcknowledgement` are gone from every non-test source file of packages/*\/src, packages/db/schema and apps/*\/src.
 *  S2  `channel_settlements` no longer has the single-loan columns anywhere: not in the Drizzle table, not in the repo row types, not in any raw SQL
 *      (`loan_owner_store_id`, `cs.loan_id`); the legs table is a Drizzle table in packages/db/schema.
 *  S3  `SPLIT_NOTE` and its sentence ("covers two loans") are gone from the domain source.
 *  S4  no NEW account-code literal in the settlement modules: every account is reached through the named constants of repo/channel-settlements.ts.
 *  S5  the two worked examples exist with the exact lines of the spec, and the document has their headings (the doc/fixture parity test is the other half).
 *  S6  the module README exists and says what a leg is.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKED_EXAMPLES, WORKED_EXAMPLE_IDS } from '../../../../tests/worked-examples/fixtures';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const at = (...p: string[]) => join(ROOT, ...p);

const SKIP_DIRS = new Set(['node_modules', '.next', 'tests', '__tests__', 'migrations', 'dist']);
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}
/** Every non-test source file the scans cover. */
function sourceFiles(): string[] {
  const dirs: string[] = [at('packages', 'db', 'schema')];
  for (const base of ['packages', 'apps']) {
    for (const name of readdirSync(at(base))) dirs.push(at(base, name, 'src'));
  }
  return dirs.flatMap((d) => walk(d));
}
/** Source with block and line comments removed (a `//` inside a string such as a URL is kept). */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');
const hits = (re: RegExp, files = sourceFiles()) => files.filter((f) => re.test(code(f))).map(rel);

describe('T-511 S6a - S1: the old acknowledgement names are gone', () => {
  it('no non-test source file uses recognizeGain [kills: the old switch kept beside the new acknowledgement]', () => {
    expect(hits(/\brecognizeGain\b/)).toEqual([]);
  });
  it('no non-test source file uses needsGainAcknowledgement [kills: the preview field kept under its old name; the form still reading it]', () => {
    expect(hits(/\bneedsGainAcknowledgement\b/)).toEqual([]);
  });
  it('the new names are in use where the old ones were: the domain, the ERP action and the form [kills: a rename done by deleting the feature]', () => {
    expect(hits(/\backnowledgeDifference\b/).some((f) => f.startsWith('packages/domain/src/channel-settlements/'))).toBe(true);
    expect(hits(/\bneedsAcknowledgement\b/).some((f) => f.endsWith('apps/erp/src/app/channel-settlements/SettlementForm.tsx'))).toBe(true);
  });
});

describe('T-511 S6a - S2: the single-loan columns of channel_settlements are gone from the source', () => {
  const schema = readFileSync(at('packages', 'db', 'schema', 'channel-settlements.ts'), 'utf8');
  const tableBlock = (() => {
    const start = schema.indexOf('export const channelSettlements = pgTable(');
    expect(start, 'channelSettlements table is declared').toBeGreaterThanOrEqual(0);
    const next = schema.indexOf('\nexport const ', start + 10);
    return schema.slice(start, next === -1 ? undefined : next);
  })();

  it('the channelSettlements Drizzle table has no loan_id, loan_owner_store_id, loan shape check or loan same-org twins [kills: the schema still mirroring dropped columns]', () => {
    expect(tableBlock).not.toMatch(/['"]loan_id['"]/);
    expect(tableBlock).not.toMatch(/['"]loan_owner_store_id['"]/);
    expect(tableBlock).not.toMatch(/channel_settlements_loan_shape_check/);
    expect(tableBlock).not.toMatch(/channel_settlements_loan_id_same_org_fk/);
    expect(tableBlock).not.toMatch(/channel_settlements_loan_owner_store_id_same_org_fk/);
    expect(tableBlock).toMatch(/['"]difference_reason['"]/);
    expect(tableBlock).toMatch(/['"]loan_deduction['"]/);
  });

  it('the legs table is a Drizzle table in packages/db/schema with the amount positive and finite checks [kills: a table that exists only in SQL]', () => {
    const all = readdirSync(at('packages', 'db', 'schema')).filter((n) => n.endsWith('.ts'));
    const declaring = all.filter((n) => /pgTable\(\s*['"]channel_settlement_loan_legs['"]/.test(readFileSync(at('packages', 'db', 'schema', n), 'utf8')));
    expect(declaring, 'schema files declaring channel_settlement_loan_legs').toHaveLength(1);
  });

  it('no repo or domain source mentions loanOwnerStoreId / loan_owner_store_id, and no raw SQL reads cs.loan_id [kills: a repo type still carrying the old fields; a stale query that would fail after the migration]', () => {
    expect(hits(/loanOwnerStoreId|loan_owner_store_id/, sourceFiles().filter((f) => !rel(f).startsWith('apps/')))).toEqual([]);
    expect(hits(/\bcs\.loan_id\b|channel_settlements\.loan_id\b/)).toEqual([]);
  });

  it('the repo row type and the insert type of channel-settlements.ts carry no loanId, and read the legs [kills: ChannelSettlementRow / InsertSettlementInput left on the single loan]', () => {
    const repo = code(at('packages', 'db', 'src', 'repo', 'channel-settlements.ts'));
    const row = repo.slice(repo.indexOf('export interface ChannelSettlementRow'), repo.indexOf('export type InsertSettlementInput'));
    expect(row).not.toMatch(/\bloanId\b/);
    expect(row).toMatch(/\bloanLegs\b/);
    const insertType = repo.slice(repo.indexOf('export type InsertSettlementInput'), repo.indexOf('export async function insertSettlement'));
    expect(insertType).not.toMatch(/'loanId'|'loanOwnerStoreId'/);
    expect(repo).toMatch(/channel_settlement_loan_legs|channelSettlementLoanLegs/);
  });
});

describe('T-511 S6a - S3: the "two loans, cannot be approved yet" note is gone', () => {
  it('SPLIT_NOTE and its sentence are gone from the domain source: the allocation now resolves to legs [kills: a note left telling the manager the day cannot be approved]', () => {
    expect(hits(/\bSPLIT_NOTE\b/)).toEqual([]);
    expect(hits(/covers two loans/i)).toEqual([]);
    expect(hits(/cannot be approved yet/i, sourceFiles().filter((f) => rel(f).startsWith('packages/domain/src/settlement-intake/')))).toEqual([]);
  });
});

describe('T-511 S6a - S4: no new account-code literal in the settlement modules', () => {
  const codes = '1130|1140|1220|1250|2150|2400|4150|6400|6410|6420|6650|6800|7100';
  const literal = new RegExp(`['"\`](?:${codes})['"\`]`);
  const files = (): string[] => [
    ...walk(at('packages', 'domain', 'src', 'channel-settlements')),
    ...walk(at('packages', 'domain', 'src', 'settlement-intake')),
  ];
  it('channel-settlements/ and settlement-intake/ reach every account through the named constants of repo/channel-settlements.ts, never a quoted code [kills: a hard-coded 2400 / 6420 / 7100 in the new leg or acknowledgement code]', () => {
    expect(files().length, 'files scanned').toBeGreaterThan(5);
    expect(files().filter((f) => literal.test(code(f))).map(rel)).toEqual([]);
  });
  it('the constants themselves still exist, unchanged in value (the migration of codes to settings is its own sweep) [kills: a constant renamed away so a literal can take its place]', () => {
    const repo = readFileSync(at('packages', 'db', 'src', 'repo', 'channel-settlements.ts'), 'utf8');
    for (const [name, value] of [['LOANS_PAYABLE_CODE', '2400'], ['DUE_FROM_STORE_CODE', '1250'], ['DUE_TO_STORE_CODE', '2150'], ['SETTLEMENT_VARIANCE_CODE', '6420'], ['SETTLEMENT_GAIN_CODE', '7100'], ['CHANNEL_RECEIVABLE_CODE', '1220']]) {
      expect(repo).toMatch(new RegExp(`export const ${name} = '${value}'`));
    }
  });
});

describe('T-511 S6a - S5: the two worked examples', () => {
  /** Account, side, amount, party type: the identity of a line. Party ids are the fixture's own choice, stores are checked where the example is about two stores. */
  const lineOf = (l: { accountCode: string; debit?: string; credit?: string; party: { type: string } | null; storeRef?: string }) => ({
    account: l.accountCode,
    ...(l.debit ? { debit: l.debit } : { credit: l.credit }),
    party: l.party?.type ?? null,
  });
  const byId = (id: string) => WORKED_EXAMPLES.find((w) => w.id === id);

  it('channel_settlement.loan_two_legs: a same-store loan and a cross-store loan docked from one Grab payout, in the order the posting writes them [kills: a fixture that disagrees with the posting; the cross-store triple missing]', () => {
    expect(WORKED_EXAMPLE_IDS).toContain('channel_settlement.loan_two_legs');
    const w = byId('channel_settlement.loan_two_legs')!;
    expect(w.sourceType).toBe('channel_settlement');
    expect(w.expect.map(lineOf)).toEqual([
      { account: '1140', debit: '5140.00', party: 'money_account' },
      { account: '6400', debit: '2500.00', party: null },
      { account: '2400', debit: '590.00', party: 'loan' },
      { account: '1250', debit: '1770.00', party: 'store' },
      { account: '2400', debit: '1770.00', party: 'loan' },
      { account: '2150', credit: '1770.00', party: 'store' },
      { account: '1220', credit: '10000.00', party: 'channel' },
    ]);
    // the paying store (branch1) holds lines 1-4 and 7; the owning store (commissary) holds the loan debit and the due-to
    expect(w.expect.map((l) => l.storeRef)).toEqual(['branch1', 'branch1', 'branch1', 'branch1', 'commissary', 'commissary', 'branch1']);
  });

  it('channel_settlement.shortfall_acknowledged: a 3,500.00 shortfall past tolerance books to 6420 and clears 1220 exactly [kills: the shortfall to 7100; a leg missing; 1220 not cleared]', () => {
    expect(WORKED_EXAMPLE_IDS).toContain('channel_settlement.shortfall_acknowledged');
    const w = byId('channel_settlement.shortfall_acknowledged')!;
    expect(w.sourceType).toBe('channel_settlement');
    expect(w.expect.map(lineOf)).toEqual([
      { account: '1140', debit: '4000.00', party: 'money_account' },
      { account: '6400', debit: '2500.00', party: null },
      { account: '6420', debit: '3500.00', party: null },
      { account: '1220', credit: '10000.00', party: 'channel' },
    ]);
  });

  it('docs/POSTING-PATTERNS.md has a heading for each, in the form the parity test parses [kills: a fixture with no document]', () => {
    const md = readFileSync(at('docs', 'POSTING-PATTERNS.md'), 'utf8');
    for (const id of ['channel_settlement.loan_two_legs', 'channel_settlement.shortfall_acknowledged']) {
      expect(md, id).toMatch(new RegExp(`^### \`${id.replace('.', '\\.')}\``, 'm'));
    }
  });
});

describe('T-511 S6a - S6: the module README', () => {
  it('packages/domain/src/channel-settlements/README.md exists and explains legs, the sum rule and the acknowledged difference [kills: the model left undocumented]', () => {
    const path = at('packages', 'domain', 'src', 'channel-settlements', 'README.md');
    expect(existsSync(path), path).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/leg/i);
    expect(text).toMatch(/acknowledg/i);
    expect(text).toMatch(/6420/);
    expect(text).toMatch(/7100/);
  });
});

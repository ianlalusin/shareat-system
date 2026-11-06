import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-512 (T-511 S5c) TESTER - no business figure is left hard-coded where it is now a rule. docs/tasks/512-business-rules-s5c-spec.md "Wiring" and the Owner rule
 * ("no business setting in the ERP may be hard-coded"). Comments are stripped first, so a sentence that explains the old value is not a hit.
 *
 * Literals read from the code at the S5b commit (bef7113 / b401b74):
 *   stage.ts            `roundedDiv(R * 100n, 112n)`, `base * 5n, 1000n` (twice)        -> VAT divisor and withholding rate
 *   loan-check.ts       `const FINAL_TOLERANCE = 1n;` and its three uses                -> loan final tolerance
 *   channel-settlements `abs > 50_000n ? abs : 50_000n`                                 -> T-150 variance floor (mills)
 *   upload/actions.ts   `MAX_FILE_BYTES = 3 * 1024 * 1024` (a copy of files/limits.ts)  -> the 3 MB cap read from one place (spec Wiring 5)
 *
 * RED today for every literal still in the source; the three wiring checks (rules are passed in) are red until the builders wire them.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** drops block comments and line comments (a `//` inside a string is rare in these files and would only make the scan stricter on the comment side, never looser) */
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

const STAGE = 'packages/domain/src/settlement-intake/stage.ts';
const LOAN = 'packages/domain/src/settlement-intake/loan-check.ts';
const T150 = 'packages/domain/src/channel-settlements/index.ts';
const INGEST = 'packages/domain/src/settlement-intake/ingest.ts';
const REVIEW = 'packages/domain/src/settlement-intake/review.ts';
const DAY_CHECKS = 'packages/domain/src/settlement-intake/day-checks.ts';

describe('T-512 source scan - no leftover rule literals', () => {
  it('stage.ts: no 112n (the VAT divisor), no 1000n (the withholding rate denominator), no `* 5n` (the withholding rate) [kills: one of the three left behind]', () => {
    const s = code(STAGE);
    expect(s).not.toMatch(/\b112n\b/);
    expect(s).not.toMatch(/\b1000n\b/);
    expect(s).not.toMatch(/\*\s*5n\b/);
    expect(s).not.toMatch(/\b5n\s*\*/);
  });

  it('stage.ts: the withholding and VAT figures come in through a `rules` argument carrying withholdingBp and vatBp [kills: rules read but never used]', () => {
    const s = code(STAGE);
    expect(s).toMatch(/\bwithholdingBp\b/);
    expect(s).toMatch(/\bvatBp\b/);
    expect(s).toMatch(/export function stageFoodpandaDays\([^)]*rules/);
    // the registry defaults may sit in the signature (50n, 1200n); nowhere else in the file
    expect((s.match(/\b1200n\b/g) ?? []).length).toBeLessThanOrEqual(1);
    expect((s.match(/\b50n\b/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('loan-check.ts: no FINAL_TOLERANCE constant and no `+ 1n` tolerance written in place [kills: the old constant kept as a fallback in the logic]', () => {
    const s = code(LOAN);
    expect(s).not.toMatch(/\bFINAL_TOLERANCE\b/);
    expect(s).not.toMatch(/repayment\s*\+\s*1n\b/);
    expect(s).not.toMatch(/expected\s*-\s*1n\b/);
  });

  it('no file of the settlement-intake folder carries FINAL_TOLERANCE', () => {
    const dir = join(ROOT, 'packages/domain/src/settlement-intake');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      expect(code(`packages/domain/src/settlement-intake/${f}`), f).not.toMatch(/\bFINAL_TOLERANCE\b/);
    }
  });

  it('channel-settlements/index.ts: no 50_000 or 50000 (the floor in thousandths of a peso) [kills: the old floor kept in the tolerance helper]', () => {
    const s = code(T150);
    expect(s).not.toMatch(/\b50_000n?\b/);
    expect(s).not.toMatch(/\b50000n?\b/);
    expect(s).not.toMatch(/\b5_?0_?0_?0_?0n?\s*\?/);
  });

  it('the T-150 preview and record read the rule book; so does the intake (stage call sites resolve and pass the rules) [kills: a rule table nobody reads]', () => {
    expect(code(T150)).toMatch(/\b(loadRuleBook|ruleValue)\b/);
    expect(code(INGEST)).toMatch(/\b(loadRuleBook|ruleValue)\b/);
    expect(code(REVIEW)).toMatch(/\b(loadRuleBook|ruleValue)\b/);
    const intake = readdirSync(join(ROOT, 'packages/domain/src/settlement-intake'))
      .filter((n) => n.endsWith('.ts'))
      .map((n) => code(`packages/domain/src/settlement-intake/${n}`))
      .join('\n');
    expect(intake, 'the loan check asks for settlement.loan_final_tolerance somewhere in the intake').toMatch(/settlement\.loan_final_tolerance/);
    expect(code(DAY_CHECKS).length).toBeGreaterThan(0);
  });

  it('every call of stageFoodpandaDays outside stage.ts passes the rules (a bare two-argument call would stage with the defaults whatever the table says) [kills: one caller forgotten]', () => {
    for (const file of [INGEST, REVIEW]) {
      const s = code(file);
      const calls = [...s.matchAll(/stageFoodpandaDays\(([\s\S]*?)\);/g)];
      expect(calls.length, `${file} calls stageFoodpandaDays`).toBeGreaterThan(0);
      for (const c of calls) expect(c[1], `${file}: ${c[0].slice(0, 80)}`).toMatch(/\b(withholdingBp|rules)\b/);
    }
  });
});

describe('T-512 source scan - the 3 MB upload cap is read from one place', () => {
  function sources(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p).replaceAll('\\', '/'));
    }
    return out;
  }

  it('`3 * 1024 * 1024` is no longer written in the upload action or ingest.ts; files/limits.ts holds it; the Grab reader reads its cap from PURPOSE_LIMITS too [kills: the copy in upload/actions.ts left in place]', () => {
    const files = [
      ...sources(join(ROOT, 'packages/domain/src/settlement-intake')),
      ...sources(join(ROOT, 'apps/erp/src/app/channel-settlements')),
      'packages/domain/src/files/limits.ts',
    ];
    const hits = files.filter((f) => /\b3\s*\*\s*1024\s*\*\s*1024\b/.test(code(f)));
    expect(hits).toContain('packages/domain/src/files/limits.ts');
    expect(hits.filter((f) => f !== 'packages/domain/src/files/limits.ts')).toEqual([]);
  });

  it('the upload action no longer defines MAX_FILE_BYTES itself', () => {
    expect(code('apps/erp/src/app/channel-settlements/upload/actions.ts')).not.toMatch(/const\s+MAX_FILE_BYTES\s*=/);
  });
});

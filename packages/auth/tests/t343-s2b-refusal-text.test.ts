/**
 * T-343 S2b — J1-J6: `jobIsElsewhere` (`refusal-text.ts`), the DEF-430 sentence.
 * docs/tasks/343-def-417-human-readable-refusals.md §S2b Design 1.
 *
 * ⛔ Was red before the builder: `jobIsElsewhere`/`JobElsewhere` did not exist, so every call below
 * failed (`jobIsElsewhere is not a function`) until S2b landed (same posture as
 * `t343-refusal-text.test.ts`'s own header for S2, which stays unedited).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, type Capability } from '../src/capabilities';
import { jobIsElsewhere, type JobElsewhere } from '../src/refusal-text';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function isHumanSentence(s: unknown): s is string {
  return typeof s === 'string' && s.trim() === s && s.length > 0;
}

/** Copy of `t343-refusal-text.test.ts`'s `assertHumanSentence` (T1) — that file stays unedited (J4). */
function assertHumanSentence(sentence: string, label: string): void {
  expect(isHumanSentence(sentence), `${label}: must be a non-empty, untrimmed-safe string`).toBe(true);
  expect(sentence.includes('\n'), `${label}: must be a single line`).toBe(false);
  expect(/^[A-Z]/.test(sentence), `${label}: must start with an upper-case letter`).toBe(true);
  expect(sentence.endsWith('.'), `${label}: must end with a full stop`).toBe(true);
  expect(sentence.includes('_'), `${label}: must carry no raw snake_case key`).toBe(false);
  expect(/'[a-z_]+'/.test(sentence) === false || !/[a-z]_[a-z]/.test(sentence), `${label}: must carry no quoted key`).toBe(
    true,
  );
  expect(UUID_RE.test(sentence), `${label}: must carry no UUID`).toBe(false);
}

const SMK2 = { name: 'SmokeStore Two', code: 'SMK2' };
const J1_SENTENCE =
  "You can't submit a sales day at SmokeStore Two (SMK2) — the Cashier job that lets you is at SmokeStore (SMK). Ask an admin if you need to do it here too.";

describe('J1 — one store, one position: the DEF-430 sentence exactly', () => {
  it('matches Design 1’s worked example', () => {
    const jobs: JobElsewhere[] = [{ positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' }];
    expect(jobIsElsewhere('submit_sales_day', SMK2, jobs)).toBe(J1_SENTENCE);
  });
});

describe('J2 — one store, two positions: joined with "and"; duplicate rows collapse', () => {
  it('"the Cashier and Cook jobs that let you are at SmokeStore (SMK)"', () => {
    const jobs: JobElsewhere[] = [
      { positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' },
      { positionName: 'Cook', storeName: 'SmokeStore', storeCode: 'SMK' },
      { positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' }, // duplicate — collapses
    ];
    const sentence = jobIsElsewhere('submit_sales_day', { name: 'Other Store', code: 'OS' }, jobs);
    expect(sentence).toContain('the Cashier and Cook jobs that let you are at SmokeStore (SMK)');
  });
});

describe('J3 — 2-3 stores: "other stores:" form, input order, "; " separator; 4/5 stores: "N more store(s)"', () => {
  it('2 stores, input order preserved (not alphabetical)', () => {
    const jobs: JobElsewhere[] = [
      { positionName: 'Cook', storeName: 'Zeta Branch', storeCode: 'ZB' },
      { positionName: 'Cashier', storeName: 'Alpha Branch', storeCode: 'AB' },
    ];
    const sentence = jobIsElsewhere('submit_sales_day', SMK2, jobs);
    expect(sentence).toContain(
      'the jobs that let you are at other stores: Cook at Zeta Branch (ZB); Cashier at Alpha Branch (AB).',
    );
  });

  it('4 stores → first 3 groups, then "; and 1 more store"', () => {
    const jobs: JobElsewhere[] = ['A', 'B', 'C', 'D'].map((n) => ({
      positionName: 'Cashier',
      storeName: `Store ${n}`,
      storeCode: n,
    }));
    const sentence = jobIsElsewhere('submit_sales_day', SMK2, jobs);
    expect(sentence).toContain(
      'Cashier at Store A (A); Cashier at Store B (B); Cashier at Store C (C); and 1 more store.',
    );
  });

  it('5 stores → first 3 groups, then "; and 2 more stores"', () => {
    const jobs: JobElsewhere[] = ['A', 'B', 'C', 'D', 'E'].map((n) => ({
      positionName: 'Cashier',
      storeName: `Store ${n}`,
      storeCode: n,
    }));
    const sentence = jobIsElsewhere('submit_sales_day', SMK2, jobs);
    expect(sentence).toContain(
      'Cashier at Store A (A); Cashier at Store B (B); Cashier at Store C (C); and 2 more stores.',
    );
  });
});

describe('J4 (⛔) — here undefined; whitespace collapse; every Capability holds S2’s T1 rules', () => {
  it('here undefined → "at that store"', () => {
    const jobs: JobElsewhere[] = [{ positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' }];
    const sentence = jobIsElsewhere('submit_sales_day', undefined, jobs);
    expect(sentence).toContain('at that store');
  });

  it('a position name carrying a newline collapses to one space, single line', () => {
    const jobs: JobElsewhere[] = [{ positionName: 'Head\n  Cook', storeName: 'SmokeStore', storeCode: 'SMK' }];
    const sentence = jobIsElsewhere('submit_sales_day', SMK2, jobs);
    expect(sentence).toContain('Head Cook');
    expect(sentence.includes('\n')).toBe(false);
  });

  it('every Capability produces a T1-valid human sentence', () => {
    const jobs: JobElsewhere[] = [{ positionName: 'Cashier', storeName: 'SmokeStore', storeCode: 'SMK' }];
    for (const capability of CAPABILITIES as readonly Capability[]) {
      assertHumanSentence(jobIsElsewhere(capability, SMK2, jobs), `jobIsElsewhere(${capability})`);
    }
  });
});

describe('J5 (⛔) — refusal-text.ts has exactly one import, from ./capabilities (R1.5)', () => {
  it('green before and after', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'refusal-text.ts'), 'utf8');
    const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const imports = withoutBlocks.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("from './capabilities'");
  });
});

describe('J6 — jobIsElsewhere([]) never prints an empty jobs clause', () => {
  it('falls back to the plain "You can\'t … here too." sentence, no ": ." and no "are at other stores"', () => {
    const sentence = jobIsElsewhere('submit_sales_day', SMK2, []);
    expect(sentence).toBe("You can't submit a sales day at SmokeStore Two (SMK2). Ask an admin if you need to do it here too.");
    expect(sentence).not.toContain(': .');
    expect(sentence).not.toContain('are at other stores');
  });
});

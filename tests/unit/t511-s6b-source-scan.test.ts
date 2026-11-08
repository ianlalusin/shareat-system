/**
 * T-511 S6b (TESTER, 7 Nov 2026) - the shape of `packages/domain/src/channel-settlements/correction.ts` that no behaviour test can see: the gate, the named accounts
 * (Ian's no-hard-coded-business-values rule: reuse the existing constants, add no new literal account), no float arithmetic on money, the dual-run hand-off.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6b". Source scans, no database.
 *
 * RED TODAY: correction.ts does not exist. Read from the file (not `git ls-files`), so an unstaged new file is seen.
 *
 * `domain-actions-have-callers` needs an EXEMPT row for `correctPlatformSales` ("S7 approve calls it"): ADDED to that guard's plain EXEMPT record by this tester
 * (tests/unit/domain-actions-have-callers.test.ts), reason opens "UNWIRED". It is red ("no longer an action-shaped domain export") until the function exists.
 * Also bumped by this tester: the ALWAYS-trigger pin 40 -> 41 (t354-trigger-registry.test.ts, plus the trigger in its list), the registry-size pin 53 -> 54
 * (t398-s4-derived-same-org.test.ts), and both audit ceilings 232 -> 233 (t402-s1b-catalogue.test.ts, t453-item-audit-catalogue.test.ts).
 * The BUILDER still bumps (not tests): the production-caller ratchet if it counts the new zero-caller name, `npm run toc` after the doc heading.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './lib/document-facts';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const FILE = 'packages/domain/src/channel-settlements/correction.ts';

describe('T-511 S6b - correction.ts', () => {
  it('exists and exports correctPlatformSales(tx, actor, input) [kills: a function under another name; a module nobody can find]', () => {
    expect(existsSync(path.join(repoRoot, FILE)), FILE).toBe(true);
    expect(codeOnly(read(FILE))).toMatch(/export\s+async\s+function\s+correctPlatformSales\s*\(\s*tx\s*:\s*Tx\s*,\s*actor\s*:\s*Actor/);
  });

  it('authorizes record_ar_collection with the line\'s store scope BEFORE it posts (authorize( precedes postEntry( and the audit write) [kills: no gate; a gate after the write; a gate without storeId]', () => {
    const src = codeOnly(read(FILE));
    const gate = src.search(/authorize\(\s*tx\s*,\s*actor\s*,\s*'record_ar_collection'\s*,\s*\{\s*storeId/);
    expect(gate, "authorize(tx, actor, 'record_ar_collection', { storeId ... })").toBeGreaterThan(-1);
    const post = src.search(/postEntry\(/);
    expect(post, 'postEntry( call').toBeGreaterThan(-1);
    expect(gate, 'the gate precedes the posting').toBeLessThan(post);
  });

  it('names no account code as a literal: 4150 comes from SALES_DAY_ACCOUNTS and 1220 from CHANNEL_RECEIVABLE_CODE / the channel\'s own receivable code [kills: a new hard-coded account (Ian\'s rule)]', () => {
    const src = codeOnly(read(FILE));
    expect(src, 'no \'1220\' / "1220" literal').not.toMatch(/['"`]1220['"`]/);
    expect(src, 'no \'4150\' / "4150" literal').not.toMatch(/['"`]4150['"`]/);
    expect(src).toMatch(/SALES_DAY_ACCOUNTS/);
    expect(src).toMatch(/CHANNEL_RECEIVABLE_CODE/);
  });

  it('dates through firstOpenDateOnOrAfter and keys idempotency on sales_day:{day}:platform_correction:{line} [kills: dating on the clock; a different key]', () => {
    const src = codeOnly(read(FILE));
    expect(src).toMatch(/firstOpenDateOnOrAfter/);
    expect(src).toMatch(/sales_day:\$\{[^}]+\}:platform_correction:\$\{[^}]+\}/);
  });

  it('does money with the Money brand, never float arithmetic: no parseFloat, toFixed or Math.round [kills: 0.1300000000001]', () => {
    const src = codeOnly(read(FILE));
    expect(src).not.toMatch(/parseFloat|\.toFixed\(|Math\.round\(/);
  });
});

describe('T-511 S6b - the dual-run hand-off', () => {
  it('the domain run passes the v2 document\'s platformCorrection flag on to the comparator [kills: a flag the comparator never receives, so the class can never be assigned]', () => {
    expect(codeOnly(read('packages/domain/src/dual-run/index.ts'))).toMatch(/platformCorrection/);
  });

  it('the class is in the catalogue AND the comparator names it [kills: a code with no rule]', () => {
    expect(codeOnly(read('packages/etl/src/dual-run/classes.ts'))).toMatch(/PLATFORM_FILE_CORRECTION/);
    expect(codeOnly(read('packages/etl/src/dual-run/compare.ts'))).toMatch(/PLATFORM_FILE_CORRECTION/);
  });
});

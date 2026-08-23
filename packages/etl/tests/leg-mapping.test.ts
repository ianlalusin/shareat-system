import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  ALL_SPEC_SOURCE_TYPE_NAMES,
  AMBIGUOUS_CATEGORY_FINDINGS,
  BALANCE_SHEET_ONLY_SPEC_NAMES,
  COGS_CATEGORY_ACCOUNTS,
  COGS_INVENTORY_ACCOUNTS,
  NOMINAL_SPEC_NAME_ACCOUNTS,
  OPEX_CATEGORY_ACCOUNTS,
  SOURCE_TYPE_MAPPINGS,
  SYNTHESIZE_SPEC_NAMES,
  classifySourceType,
  realSourceTypesForSpecName,
} from '../src/leg-mapping';

// Unit test, no database (task Files list) — CHART_OF_ACCOUNTS is imported as static seed
// DATA (a plain TS array), never a live Postgres connection. packages/db is read, not
// modified, and no export is added to packages/db/package.json — a plain relative import
// crossing the package boundary, same as any other file inside this single TS program
// (root tsconfig.json's `include` already covers both packages/etl and packages/db).
import { CHART_OF_ACCOUNTS } from '../../db/seed/chart-of-accounts';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const COA_ALIGNMENT_PATH = join(REPO_ROOT, 'docs', 'decisions', 'COA-ALIGNMENT.md');

/**
 * Extracts every account code named in a markdown TABLE ROW as `**NNNN**` within
 * COA-ALIGNMENT §4 — the exact restricted algorithm `packages/db/tests/integration/
 * chart-of-accounts.test.ts` (T-102b invariant 7) uses, reused here per T-113's explicit
 * instruction ("reuse that approach rather than re-deriving it and re-hitting the trap").
 * Duplicated rather than imported because the two test files sit in different vitest
 * "unit"-project packages with no shared test-utility module today; the two copies are
 * intentionally byte-identical in behaviour (both scope to "## 4." .. "## 5.", both require
 * an exact `**\d{4}**` span) so they can never disagree about what §4 requires.
 *
 * Why the double restriction matters here too: §4.3's CAPEX paragraph contains
 * "**1510–1530** Property and equipment" — a bold span describing a RANGE, not a table row.
 * COA-ALIGNMENT §2 documents 1520/1530 as an intentional gap; a naive "every 4-digit
 * substring" parser would wrongly demand they exist. Table-row-only (1) plus exact-4-digit
 * bold span (2) both exclude that phrase, same reasoning as T-102b's.
 */
function parseSection4RequiredCodes(markdown: string): Set<string> {
  const lines = markdown.split(/\r?\n/);
  let inSection4 = false;
  const codes = new Set<string>();

  for (const line of lines) {
    if (/^## 4\. Expense categories/.test(line)) {
      inSection4 = true;
      continue;
    }
    if (inSection4 && /^## 5\./.test(line)) {
      break;
    }
    if (!inSection4) continue;
    if (!line.trim().startsWith('|')) continue;

    for (const m of line.matchAll(/\*\*(\d{4})\*\*/g)) {
      if (m[1]) codes.add(m[1]);
    }
  }

  return codes;
}

const markdown = readFileSync(COA_ALIGNMENT_PATH, 'utf8');
const requiredCodes = parseSection4RequiredCodes(markdown);
const chartCodes = new Set(CHART_OF_ACCOUNTS.map((a) => a.code));

// ===========================================================================================
// Sanity — the table itself is internally consistent before anything else is asserted
// against it.
// ===========================================================================================

describe('SOURCE_TYPE_MAPPINGS sanity', () => {
  it('has exactly 35 entries — every real v1 sourceType found in ERP-rebuild/.../builders', () => {
    expect(SOURCE_TYPE_MAPPINGS.length).toBe(35);
  });

  it('has no duplicate sourceType keys', () => {
    const keys = SOURCE_TYPE_MAPPINGS.map((m) => m.sourceType);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a non-empty evidence citation and notes', () => {
    for (const m of SOURCE_TYPE_MAPPINGS) {
      expect(m.evidence.length, `${m.sourceType} evidence`).toBeGreaterThan(0);
      expect(m.notes.length, `${m.sourceType} notes`).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================================
// Test 1 / invariant 14 — the 11 balance-sheet-only sourceTypes synthesise ZERO lines.
// Tested here as "never classified 'synthesize'" — the static fact that makes zero
// synthesis possible at all; convert.ts (which is the thing that could actually synthesise)
// has no code path that even accepts these sourceTypes as input, which is itself the proof
// for the runtime half of this control (see convert.test.ts's UNSUPPORTED_CLASSES coverage).
// ===========================================================================================

describe('Test 1 / invariant 14 — balance-sheet-only spec names never classify as synthesize', () => {
  it.each(BALANCE_SHEET_ONLY_SPEC_NAMES)('%s resolves to at least one real sourceType, all class=complete', (specName) => {
    const real = realSourceTypesForSpecName(specName);
    expect(real.length, `${specName} resolved to zero real sourceTypes`).toBeGreaterThan(0);
    for (const sourceType of real) {
      const mapping = classifySourceType(sourceType);
      expect(mapping, `${sourceType} (${specName}) is unclassified`).toBeDefined();
      expect(mapping!.class, `${sourceType} (${specName}) must be 'complete', never 'synthesize'`).toBe('complete');
    }
  });

  it('control: no sourceType classified as synthesize belongs to any balance-sheet-only spec name', () => {
    const balanceSheetReal = new Set(BALANCE_SHEET_ONLY_SPEC_NAMES.flatMap((n) => realSourceTypesForSpecName(n)));
    for (const m of SOURCE_TYPE_MAPPINGS) {
      if (m.class === 'synthesize') {
        expect(balanceSheetReal.has(m.sourceType), `${m.sourceType} is synthesize AND balance-sheet-only`).toBe(false);
      }
    }
  });
});

// ===========================================================================================
// Test 2 — Class A nominal sourceTypes map to the COA code named in §1.
// ===========================================================================================

describe('Test 2 — Class A nominal spec names map to their §1 account code(s)', () => {
  it.each(Object.entries(NOMINAL_SPEC_NAME_ACCOUNTS))('%s resolves to class=complete and touches every named code', (specName, expectedCodes) => {
    const real = realSourceTypesForSpecName(specName);
    expect(real.length, `${specName} resolved to zero real sourceTypes`).toBeGreaterThan(0);

    const touchedCodes = new Set<string>();
    for (const sourceType of real) {
      const mapping = classifySourceType(sourceType)!;
      expect(mapping.class, `${sourceType} (${specName})`).toBe('complete');
      for (const code of mapping.alwaysNominalAccounts) touchedCodes.add(code);
      for (const code of mapping.conditionalNominalAccounts) touchedCodes.add(code);
    }

    for (const code of expectedCodes) {
      expect(touchedCodes.has(code), `${specName} never touches §1's ${code} (touches: ${[...touchedCodes].join(', ')})`).toBe(true);
    }
  });
});

// ===========================================================================================
// Class B — expense_payment and sale (which also covers ar-charge) classify 'synthesize'.
// ===========================================================================================

describe('Class B — synthesize spec names', () => {
  it("'expense' (real: expense_payment) classifies synthesize", () => {
    const mapping = classifySourceType('expense_payment');
    expect(mapping?.class).toBe('synthesize');
    expect(mapping?.specNames).toContain('expense');
  });

  it("'sale' and 'ar-charge' collide on the same real sourceType 'sale', both synthesize", () => {
    const mapping = classifySourceType('sale');
    expect(mapping?.class).toBe('synthesize');
    expect(mapping?.specNames).toEqual(expect.arrayContaining(['sale', 'ar-charge']));
  });

  it('every SYNTHESIZE_SPEC_NAMES entry resolves to a real, synthesize-classified sourceType', () => {
    for (const specName of SYNTHESIZE_SPEC_NAMES) {
      const real = realSourceTypesForSpecName(specName);
      expect(real.length, `${specName}`).toBeGreaterThan(0);
      for (const sourceType of real) {
        expect(classifySourceType(sourceType)?.class, sourceType).toBe('synthesize');
      }
    }
  });
});

// ===========================================================================================
// Invariant 10 — every sourceType named in T-113 §1 and §2 resolves to a class; none is
// unclassified.
// ===========================================================================================

describe('invariant 10 — every §1/§2 spec name resolves to a class', () => {
  it('is exactly the 25 names T-113 §1/§2 name (11 balance-sheet + 11 nominal + 3 synthesize)', () => {
    expect(ALL_SPEC_SOURCE_TYPE_NAMES.length).toBe(25);
    expect(new Set(ALL_SPEC_SOURCE_TYPE_NAMES).size).toBe(25);
  });

  it.each(ALL_SPEC_SOURCE_TYPE_NAMES)('%s resolves to ≥1 real sourceType, every one classified', (specName) => {
    const real = realSourceTypesForSpecName(specName);
    expect(real.length, `${specName} unclassified — resolves to zero real sourceTypes`).toBeGreaterThan(0);
    for (const sourceType of real) {
      expect(classifySourceType(sourceType), `${sourceType} (${specName})`).toBeDefined();
    }
  });

  it('no SOURCE_TYPE_MAPPINGS entry is class=quarantine — the spec never left a sourceType undecidable', () => {
    for (const m of SOURCE_TYPE_MAPPINGS) {
      expect(m.class, m.sourceType).not.toBe('quarantine');
    }
  });
});

// ===========================================================================================
// FINDING — real sourceTypes T-113 §1/§2 never names at all.
// ===========================================================================================

describe('FINDING — real v1 sourceTypes not named anywhere in T-113 §1/§2', () => {
  const expectedUnnamed = ['prepaid_refund', 'prepaid_legacy_import', 'prepaid_writeoff', 'online_remittance'];

  it('is exactly these 4, each present and classified complete', () => {
    const unnamed = SOURCE_TYPE_MAPPINGS.filter((m) => m.specNames.length === 0).map((m) => m.sourceType);
    expect(new Set(unnamed)).toEqual(new Set(expectedUnnamed));
    for (const sourceType of expectedUnnamed) {
      expect(classifySourceType(sourceType)?.class, sourceType).toBe('complete');
    }
  });
});

// ===========================================================================================
// Invariant 11 — every COGS and OPEX category named in COA-ALIGNMENT §4 resolves to an
// account, and every account it resolves to exists in the seeded chart. Parsed from §4
// itself, not hand-maintained (the DEF-035 blind spot).
// ===========================================================================================

describe('invariant 11 — COGS + OPEX category maps cover exactly what §4 names, and every code exists in the seeded chart', () => {
  it('parser sanity — found the doc and parsed a non-trivial §4', () => {
    expect(markdown.length).toBeGreaterThan(1000);
    expect(requiredCodes.size).toBeGreaterThanOrEqual(30);
  });

  it('parser sanity — does NOT require 1520 or 1530 (the intentional, documented number gap)', () => {
    expect(requiredCodes.has('1520')).toBe(false);
    expect(requiredCodes.has('1530')).toBe(false);
  });

  it('every code used by COGS_CATEGORY_ACCOUNTS + OPEX_CATEGORY_ACCOUNTS is named in §4 — no invented codes', () => {
    const usedCodes = new Set([...Object.values(COGS_CATEGORY_ACCOUNTS), ...Object.values(OPEX_CATEGORY_ACCOUNTS)]);
    const invented = [...usedCodes].filter((c) => !requiredCodes.has(c)).sort();
    expect(invented, `codes used but not named in §4: ${invented.join(', ')}`).toEqual([]);
  });

  it('every code §4 names (COGS/OPEX ranges) is covered by COGS_CATEGORY_ACCOUNTS + OPEX_CATEGORY_ACCOUNTS — nothing named was missed', () => {
    const usedCodes = new Set([...Object.values(COGS_CATEGORY_ACCOUNTS), ...Object.values(OPEX_CATEGORY_ACCOUNTS)]);
    const missing = [...requiredCodes].filter((c) => !usedCodes.has(c)).sort();
    expect(missing, `§4 names these codes but no category map covers them: ${missing.join(', ')}`).toEqual([]);
  });

  it('every code used by COGS_CATEGORY_ACCOUNTS + OPEX_CATEGORY_ACCOUNTS exists in the real seeded chart', () => {
    const usedCodes = new Set([...Object.values(COGS_CATEGORY_ACCOUNTS), ...Object.values(OPEX_CATEGORY_ACCOUNTS)]);
    const missingFromChart = [...usedCodes].filter((c) => !chartCodes.has(c)).sort();
    expect(missingFromChart, `mapped to a code that does not exist in CHART_OF_ACCOUNTS: ${missingFromChart.join(', ')}`).toEqual([]);
  });

  it('the 1310/1320/1330 inventory-side accounts (documentation-only, not §4-bold-coded) also exist in the seeded chart', () => {
    for (const code of Object.values(COGS_INVENTORY_ACCOUNTS)) {
      expect(chartCodes.has(code), `${code} missing from CHART_OF_ACCOUNTS`).toBe(true);
    }
  });

  it('COGS_CATEGORY_ACCOUNTS and OPEX_CATEGORY_ACCOUNTS never collide on the same code', () => {
    const cogsCodes = new Set(Object.values(COGS_CATEGORY_ACCOUNTS));
    const opexCodes = new Set(Object.values(OPEX_CATEGORY_ACCOUNTS));
    const overlap = [...cogsCodes].filter((c) => opexCodes.has(c));
    expect(overlap).toEqual([]);
  });

  it('records the one documented ambiguous category (Pest Control second variant) rather than guessing it', () => {
    expect(AMBIGUOUS_CATEGORY_FINDINGS.length).toBeGreaterThan(0);
    expect(OPEX_CATEGORY_ACCOUNTS['Pest Control']).toBeUndefined();
  });
});

// ===========================================================================================
// Invariant 12 (data half) — the fixed CAPEX / PERSONAL account constants exist and are the
// right codes. The behavioural half (an actual expense doc never produces a 6xxx line for
// these groups) is convert.test.ts's job.
// ===========================================================================================

describe('invariant 12 (data) — CAPEX and PERSONAL fixed account constants', () => {
  it('PROPERTY_AND_EQUIPMENT is 1510 and exists in the seeded chart', () => {
    expect(ACCOUNTS.PROPERTY_AND_EQUIPMENT).toBe('1510');
    expect(chartCodes.has(ACCOUNTS.PROPERTY_AND_EQUIPMENT)).toBe(true);
  });

  it("OWNERS_DRAWINGS is 3200 and exists in the seeded chart", () => {
    expect(ACCOUNTS.OWNERS_DRAWINGS).toBe('3200');
    expect(chartCodes.has(ACCOUNTS.OWNERS_DRAWINGS)).toBe(true);
  });
});

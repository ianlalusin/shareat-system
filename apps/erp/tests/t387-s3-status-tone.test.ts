/**
 * T-387 S3 — `statusTone` / `statusLabel` (docs/tasks/387-warm-theme-and-grill-night-dark.md, S3, L8).
 *
 * API pinned (components/ui/status-tone.ts):
 *   type Tone = 'info' | 'warning' | 'success' | 'progress' | 'danger' | 'closed'
 *   STATUS_TONE: Readonly<Record<string, Tone>>        keyed by the raw status value, lower case
 *   statusTone(status: string): Tone                    returns 'closed' for an unmapped value (never throws)
 *   statusLabel(status: string): string                 sentence case: first letter up, `_` -> space, humanises any value, mapped or not
 *   unmappedStatuses(values, table = STATUS_TONE): string[]   the helper the complete-map guard runs through
 *
 * The guard reads the schema SOURCE (regex, comments stripped), not the modules: importing packages/db/schema
 * drags drizzle and the db client into a node unit test. It finds every `export const X_STATUSES|_STATUS|_STAGES
 * = [...]` and every `text('<col with status|stage>', { enum: [...] })`, plus the keys of the derived
 * BranchOrderStage (packages/domain/src/commissary/orders.ts). A new status value anywhere fails this test
 * until it has a tone: that is the point.
 *
 * `.ts`, not `.tsx` (L6): the unit project runs only `.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATUS_TONE, statusLabel, statusTone, unmappedStatuses } from '../src/components/ui/status-tone';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(here, '..', '..', '..', 'packages', 'db', 'schema');
const ORDERS_TS = path.join(here, '..', '..', '..', 'packages', 'domain', 'src', 'commissary', 'orders.ts');
const TONES = ['info', 'warning', 'success', 'progress', 'danger', 'closed'];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

interface Found {
  source: string;
  values: string[];
}

function schemaStatusValues(): Found[] {
  const out: Found[] = [];
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.ts'))) {
    const src = stripComments(readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
    for (const m of src.matchAll(/export const ([A-Z0-9_]*_(?:STATUSES|STATUS|STAGES))\s*=\s*\[([^\]]*)\]/g)) {
      out.push({ source: `${f}:${m[1]}`, values: quoted(m[2] as string) });
    }
    for (const m of src.matchAll(/text\('([a-z_]*(?:status|stage)[a-z_]*)',\s*\{\s*enum:\s*\[([^\]]*)\]/g)) {
      out.push({ source: `${f}:col:${m[1]}`, values: quoted(m[2] as string) });
    }
  }
  return out;
}

function branchOrderStages(): string[] {
  const src = stripComments(readFileSync(ORDERS_TS, 'utf8'));
  const body = /BRANCH_ORDER_STAGE_LABEL[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1] as string);
}

const found = schemaStatusValues();
const stages = branchOrderStages();
// NOT lifecycle statuses (lead ruling 2026-10-10): the scan picks them up from columns named *status, but they are
// classifications, not states, so they have no tone.
const NOT_STATUSES = new Set([
  'regular', 'probationary', 'contractual', 'part-time', // employment types (employees.employment_status)
  'vat_registered', 'non_vat', // SUPPLIER_VAT_STATUSES: a tax classification of the supplier
]);
const ALL = [...new Set([...found.flatMap((f) => f.values), ...stages])].filter((v) => !NOT_STATUSES.has(v)).sort();
const cap = (v: string) => {
  const t = v.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

describe('status scan is not vacuous', () => {
  it('finds the schema enums, including the inline column enums and both void spellings', () => {
    expect(found.length).toBeGreaterThanOrEqual(40);
    for (const v of ['void', 'voided', 'needs_review', 'in_transit', 'pending_valuation', 'fully_amortised', 'posted', 'draft']) {
      expect(ALL, v).toContain(v);
    }
    expect(found.some((f) => f.source === 'sales-days.ts:col:status')).toBe(true);
    expect(found.some((f) => f.source === 'expenses.ts:col:status')).toBe(true);
    expect(found.some((f) => f.source === 'cash-requests.ts:CASH_REQUEST_STATUSES')).toBe(true);
  });
  it('finds the eight branch-order stages', () => {
    expect([...stages].sort()).toEqual(['accepted', 'cancelled', 'dispatched', 'draft', 'ready', 'received', 'rejected', 'submitted']);
  });
});

describe('statusTone: the complete-map guard', () => {
  it('every status value in packages/db/schema and every branch-order stage has a tone', () => {
    expect(unmappedStatuses(ALL)).toEqual([]);
  });
  it('every mapped tone is one of the six, and every key is lower case', () => {
    for (const [k, t] of Object.entries(STATUS_TONE)) {
      expect(TONES, k).toContain(t);
      expect(k, k).toBe(k.toLowerCase());
    }
    for (const v of ALL) expect(TONES, v).toContain(statusTone(v));
  });
  it('every value has a sentence-case label: first letter up, underscores to spaces, nothing else changed', () => {
    for (const v of ALL) {
      const label = statusLabel(v);
      expect(label, v).toBe(cap(v));
      expect(label, v).toMatch(/^[A-Z][a-z]*(?:[ -][a-z]+)*$/);
    }
  });
  it('NEGATIVE: a value not in the map fails the guard (synthetic value, same helper)', () => {
    expect(unmappedStatuses([...ALL, 'zz_not_a_status'])).toEqual(['zz_not_a_status']);
  });
  it('NEGATIVE: deleting one entry from the table fails the guard (same helper, table minus `posted`)', () => {
    const { posted: _gone, ...without } = STATUS_TONE;
    expect(unmappedStatuses(ALL, without)).toContain('posted');
    expect(unmappedStatuses(ALL, without).length).toBeGreaterThan(0);
  });
  it('an unknown status does NOT throw: statusTone falls back to closed and statusLabel still humanises it (lead ruling)', () => {
    expect(statusTone('zz_not_a_status')).toBe('closed');
    expect(statusLabel('zz_not_a_status')).toBe('Zz not a status');
    expect(unmappedStatuses(['zz_not_a_status'])).toEqual(['zz_not_a_status']); // the guard still sees it as unmapped
  });
});

describe('statusTone: the ADR-013 Amendment 7 colour code, pinned', () => {
  it.each([
    ['draft', 'info'],
    ['submitted', 'warning'],
    ['approved', 'success'],
    ['posted', 'success'],
    ['voided', 'danger'],
    ['void', 'danger'],
    ['closed', 'closed'],
    ['overdue', 'danger'],
  ])('%s -> %s', (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });
  it('void and voided are BOTH mapped, to the same tone (GLOSSARY :154-155, L8)', () => {
    expect(statusTone('void')).toBe(statusTone('voided'));
    expect(statusLabel('void')).toBe('Void');
    expect(statusLabel('voided')).toBe('Voided');
  });
  it('labels are one short sentence-case phrase, never the stage sentence', () => {
    expect(statusLabel('in_transit')).toBe('In transit');
    expect(statusLabel('needs_review')).toBe('Needs review');
    expect(statusLabel('part-time')).toBe('Part-time');
  });
});

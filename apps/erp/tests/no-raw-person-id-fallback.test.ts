import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-405 invariant I4 — the raw person-id fallback cannot come back.
 *
 * Bible row 229: a person is shown by name, never by a UUID. Before T-405 three ERP pages wrote
 * `?? personId` (or `?? pid`, or `?? a.personId`) after a person lookup, so a miss printed the id.
 * The fix is the shared `personName` helper in apps/erp/src/lib/person-name.ts.
 *
 * This guard walks every .ts/.tsx file under apps/erp/src and fails on any line that still falls
 * back to a raw person id, printing file:line so the fix is obvious. Mutant M4 restores
 * `?? a.personId` in wastage/[id]/page.tsx; this test must go red on it.
 *
 * Self-check: the pattern is exercised against the three removed original lines (inline below)
 * and must NOT match the sanctioned `?? '—'` or `?? UNKNOWN_PERSON` forms.
 */

const PATTERN = /\?\?\s*\(?[\w.]*(personId|PersonId|\bpid)\b/;

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const SRC = join(appRoot, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function findRawPersonIdFallbacks(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) {
        const rel = relative(appRoot, file).split(sep).join('/');
        hits.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe('no raw person-id fallback in apps/erp/src (I4, bible row 229)', () => {
  it('finds no line that renders a person id when the lookup misses', () => {
    const hits = findRawPersonIdFallbacks();
    expect(
      hits,
      `Raw person-id fallback found. Use personName(lookup, id) from src/lib/person-name.ts instead:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});

describe('the guard pattern itself (self-check)', () => {
  it.each([
    // the three original lines removed by T-405
    "personId ? (persons.find((p) => p.id === personId)?.displayName ?? personId) : '—';",
    "pid ? (persons.find((p) => p.id === pid)?.displayName ?? pid) : '—';",
    '${nameById.get(a.personId) ?? a.personId} ${a.percent}%',
  ])('matches the original raw-id fallback: %s', (line) => {
    expect(PATTERN.test(line)).toBe(true);
  });

  it.each([
    "return personId ? (persons.find((p) => p.id === personId)?.displayName ?? '—') : '—';",
    "const label = name ?? UNKNOWN_PERSON;",
    "return personName(persons, personId) ?? '—';",
  ])('does not match a sanctioned fallback: %s', (line) => {
    expect(PATTERN.test(line)).toBe(false);
  });
});

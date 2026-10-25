import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-472 S2 - structural guards on the nightly POS receipt bridge. `docs/tasks/472-pos-nightly-receipt-bridge.md`
 * Rulings 1 (read-only by structure) and 7 (no personal data).
 *
 * MUTANTS: the job/port/adapter naming a Firestore write -> R1; `firebase-admin` or `@shareat/etl-firestore` imported by
 * domain -> R2; the adapter reaching the POS v2 server key -> R3; a personal-data column in the repo -> R4.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const DOMAIN_FILES = ['packages/domain/src/pos/receipt-bridge-job.ts', 'packages/domain/src/pos/receipt-bridge-port.ts'];
const ADAPTER = 'packages/etl-firestore/src/pos-receipt-bridge-adapter.ts';
const REPO = 'packages/db/src/repo/pos-bridge.ts';

const FIRESTORE_WRITES = [
  /\.\s*set\s*\(/,
  /\.\s*update\s*\(/,
  /\.\s*delete\s*\(/,
  /\.\s*add\s*\(\s*\{/,
  /\.\s*create\s*\(/,
  /\bbatch\s*\(/,
  /\bbulkWriter\b/,
  /\brunTransaction\b/,
  /\bWriteBatch\b/,
  /\brecursiveDelete\b/,
  /\bFieldValue\b/,
];

describe('T-472 S2 structural guards', () => {
  it('R1: the job, the port and the adapter name no Firestore write call', () => {
    for (const f of [...DOMAIN_FILES, ADAPTER]) {
      const src = read(f);
      for (const re of FIRESTORE_WRITES) expect(src, `${f} matches ${re}`).not.toMatch(re);
    }
  });

  it('R2: packages/domain imports neither firebase-admin nor etl-firestore in the bridge files', () => {
    for (const f of DOMAIN_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/firebase-admin/);
      expect(src, f).not.toMatch(/@shareat\/etl-firestore/);
    }
  });

  it('R3: the adapter builds its Firestore only from the bridge credential, never the POS v2 server key', () => {
    const src = read(ADAPTER);
    expect(src).toMatch(/createPosReceiptFirestore/);
    expect(src).not.toMatch(/POS_FIREBASE_SA_KEY_FILE/);
    expect(src).not.toMatch(/pos2-firebase-key/);
  });

  it('R4: the repo has no personal-data column or field name (Ruling 7)', () => {
    const src = read(REPO);
    for (const word of ['customerName', 'customerTin', 'customerAddress', 'idNo', 'tin_number', 'senior_name', 'pwd_name']) {
      expect(src, word).not.toContain(word);
    }
  });

  it('the files exist (a scan of nothing must not pass)', () => {
    for (const f of [...DOMAIN_FILES, ADAPTER, REPO]) expect(read(f).length, f).toBeGreaterThan(200);
  });
});

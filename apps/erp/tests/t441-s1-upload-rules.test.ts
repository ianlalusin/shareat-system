import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-441 S1 TESTER - upload-rules (pure) + the db-free leaf `files/limits.ts`. Mutants M5, M6, M7 (+ audit A7).
 *
 * ASSUMED CONTRACT:
 *   packages/domain/src/files/limits.ts exports PURPOSE_LIMITS and MAX_IMAGE_BYTES (db-free: no @shareat/db import, A7);
 *     files/index.ts re-exports the SAME objects. PURPOSE_LIMITS must stay a plain (non-frozen) object: M5 mutates it.
 *   upload-rules.ts exports acceptFor(purpose) -> comma-separated MIME list, allowsPdf(purpose) -> boolean,
 *     shapeFor(purpose) -> 'circle' | 'square', GUARDED_PURPOSES -> readonly string[]
 *     (acceptFor / allowsPdf read PURPOSE_LIMITS at call time).
 * RED reason before the build: neither module exists.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

async function loadRules() {
  try {
    return await import('../src/components/upload/upload-rules');
  } catch (err) {
    throw new Error(`apps/erp/src/components/upload/upload-rules.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
async function loadLimits() {
  try {
    return await import('../../../packages/domain/src/files/limits');
  } catch (err) {
    throw new Error(`packages/domain/src/files/limits.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
const types = (accept: string) => accept.split(',').map((s) => s.trim()).filter(Boolean).sort();
const CONTROL = ['receipt_photo', 'staff_photo', 'leave_document'] as const;

describe('the leaf (audit A7)', () => {
  it('limits.ts exists, carries PURPOSE_LIMITS and MAX_IMAGE_BYTES, and imports nothing from @shareat/db', async () => {
    const { PURPOSE_LIMITS, MAX_IMAGE_BYTES } = await loadLimits();
    expect(MAX_IMAGE_BYTES).toBe(1024 * 1024);
    expect(Object.keys(PURPOSE_LIMITS).sort()).toEqual(
      ['ar_collection_proof', 'leave_document', 'memo_document', 'onboarding_document', 'receipt_photo', 'staff_photo', 'staff_signature', 'wastage_dispute'],
    );
    const src = read('packages/domain/src/files/limits.ts');
    expect(src).not.toMatch(/@shareat\/db/); // type-only imports count: client-bundle-boundary walks them too
  });

  it('files/index.ts re-exports the very same objects (one source with the server)', async () => {
    const leaf = await loadLimits();
    const idx = await import('../../../packages/domain/src/files/index');
    expect(idx.PURPOSE_LIMITS).toBe(leaf.PURPOSE_LIMITS);
    expect(idx.MAX_IMAGE_BYTES).toBe(leaf.MAX_IMAGE_BYTES);
  });

  it('packages/domain/package.json exports "./files/limits"', () => {
    const pkg = JSON.parse(read('packages/domain/package.json')) as { exports?: Record<string, unknown> };
    expect(Object.keys(pkg.exports ?? {})).toContain('./files/limits');
  });
});

describe('M5 - acceptFor / allowsPdf are derived from PURPOSE_LIMITS, never hard-coded', () => {
  it("equals the purpose's allowed types, for every purpose the control serves", async () => {
    const { acceptFor } = await loadRules();
    const { PURPOSE_LIMITS } = await loadLimits();
    for (const p of CONTROL) expect(types(acceptFor(p as never))).toEqual([...PURPOSE_LIMITS[p].types].sort());
  });

  it('a type added to PURPOSE_LIMITS shows up (and a pdf makes allowsPdf true) without touching upload-rules', async () => {
    const { acceptFor, allowsPdf } = await loadRules();
    const { PURPOSE_LIMITS } = await loadLimits();
    const lim = PURPOSE_LIMITS as unknown as Record<string, { types: readonly string[]; maxBytes: number }>;
    const saved = lim['leave_document']!;
    try {
      expect(allowsPdf('leave_document' as never)).toBe(false);
      lim['leave_document'] = { ...saved, types: [...saved.types, 'image/gif', 'application/pdf'] };
      expect(types(acceptFor('leave_document' as never))).toContain('image/gif');
      expect(allowsPdf('leave_document' as never)).toBe(true);
    } finally {
      lim['leave_document'] = saved;
    }
  });

  it('allowsPdf: receipts yes; staff photo and leave certificate no', async () => {
    const { allowsPdf } = await loadRules();
    expect(allowsPdf('receipt_photo' as never)).toBe(true);
    expect(allowsPdf('staff_photo' as never)).toBe(false);
    expect(allowsPdf('leave_document' as never)).toBe(false);
  });

  it('the rules file holds no MIME literal of its own and no db import', () => {
    const src = read('apps/erp/src/components/upload/upload-rules.ts');
    expect(src).not.toMatch(/image\/(jpeg|png|webp)|application\/pdf/);
    expect(src).not.toMatch(/@shareat\/db/);
  });
});

describe('M6 - the shape', () => {
  it('staff_photo is a circle; every other purpose is a square', async () => {
    const { shapeFor } = await loadRules();
    const { PURPOSE_LIMITS } = await loadLimits();
    expect(shapeFor('staff_photo' as never)).toBe('circle');
    for (const p of Object.keys(PURPOSE_LIMITS).filter((k) => k !== 'staff_photo')) expect(shapeFor(p as never)).toBe('square');
  });
});

describe('M7 - GUARDED_PURPOSES', () => {
  it('is exactly leave_document and staff_signature (row 353)', async () => {
    const { GUARDED_PURPOSES } = await loadRules();
    expect([...GUARDED_PURPOSES].sort()).toEqual(['leave_document', 'staff_signature']);
  });
});

describe('the browser boundary for the control folder', () => {
  it('no file in components/upload/ imports @shareat/db or the bare @shareat/domain (only the ./files/limits leaf)', () => {
    const dir = join(root, 'apps/erp/src/components/upload');
    expect(existsSync(dir), 'apps/erp/src/components/upload/ does not exist yet').toBe(true);
    const files = readdirSync(dir).filter((n) => /\.tsx?$/.test(n));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const n of files) {
      const src = readFileSync(join(dir, n), 'utf8');
      expect(src, `${n} imports the db package`).not.toMatch(/from\s+['"]@shareat\/db/);
      expect(src, `${n} imports the bare domain barrel`).not.toMatch(/from\s+['"]@shareat\/domain['"]/);
    }
  });
});

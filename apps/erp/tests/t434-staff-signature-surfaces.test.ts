import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CAPABILITY_MATRIX, CAPABILITY_SCOPE, CAPABILITIES } from '../../../packages/auth/src/capabilities';
import { PURPOSE_LIMITS } from '../../../packages/domain/src/files';

/**
 * T-434 TESTER - code-shape and matrix guards (cases 14, 20, 5, 4 input). No database. Written against the
 * names the spec fixes (capability, purposes, column, components), not against staff page markup T-435 may change.
 * RED reasons before the build: the capability, purposes and components do not exist yet.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(root, p).split(sep).join('/');

describe('20. view_staff_signature in the matrix', () => {
  it('exists, is store-scoped, and only super_admin and admin hold it by role', () => {
    expect(CAPABILITIES as readonly string[]).toContain('view_staff_signature');
    const row = (CAPABILITY_MATRIX as Record<string, Record<string, boolean>>)['view_staff_signature'];
    expect(row).toEqual({ super_admin: true, admin: true, manager: false, staff: false });
    expect((CAPABILITY_SCOPE as Record<string, string>)['view_staff_signature']).toBe('store');
  });
  it('is documented in CAPABILITY-MATRIX.md and does not imply run_payroll', () => {
    const doc = read('docs/decisions/CAPABILITY-MATRIX.md');
    expect(doc).toMatch(/view_staff_signature/);
    const rp = (CAPABILITY_MATRIX as Record<string, Record<string, boolean>>)['run_payroll'];
    expect(rp).toBeDefined();
  });
});

describe('4/5. purposes and limits', () => {
  it('staff_signature accepts png only, staff_photo jpeg/png/webp', () => {
    const lim = PURPOSE_LIMITS as Record<string, { types: readonly string[]; maxBytes: number } | undefined>;
    expect(lim['staff_signature']?.types).toEqual(['image/png']);
    expect([...(lim['staff_photo']?.types ?? [])].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('14. the signature file id appears in no list, wall, card or export', () => {
  // Only these files may name the signature column / purpose / domain calls.
  const ALLOWED = [
    'apps/erp/src/app/staff/[employmentId]/page.tsx',
    'apps/erp/src/app/staff/actions.ts',
    'apps/erp/src/components/SignaturePad.tsx',
    'apps/erp/src/components/signature-pad-export.ts',
    // T-441: GUARDED_PURPOSES names staff_signature so the shared upload control never thumbnails it
    'apps/erp/src/components/upload/upload-rules.ts',
  ];
  const NAMES = /signatureFileId|signature_file_id|staff_signature|staffSignature|StaffSignature|signatureForPrint|view_staff_signature/;
  it('no other app file mentions the signature column, purpose or its functions', () => {
    const offenders = walk(join(root, 'apps/erp/src'))
      .map(rel)
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => NAMES.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('the staff wall and list views never select or render a signature', () => {
    for (const f of ['apps/erp/src/app/staff/page.tsx', 'apps/erp/src/app/staff/StaffViews.tsx']) {
      expect(read(f), f).not.toMatch(/signature/i);
    }
  });
  it('the employment repo (the list/roster selects) never reads the signature column', () => {
    expect(read('packages/db/src/repo/employment.ts')).not.toMatch(/signature/i);
  });
});

describe('screens: only the detail page offers the signature, as a per-click link', () => {
  const page = 'apps/erp/src/app/staff/[employmentId]/page.tsx';
  it('shows "Signature on file" text and never an inline signature image or id', () => {
    const src = read(page);
    expect(src).toContain('Signature on file');
    expect(src).not.toMatch(/signatureFileId|signature_file_id/);
    expect(src).not.toMatch(/<img[^>]*signature/i);
  });
  it('photo input asks for the front camera and image files only', () => {
    expect(read('apps/erp/src/components/PhotoInput.tsx')).toMatch(/capture/);
    const src = read(page);
    expect(src).toMatch(/accept=["']image\/\*["']/);
    expect(src).toMatch(/capture=["']user["']/);
  });
  it('the signature action takes a file part, never a data URL', () => {
    const src = read('apps/erp/src/app/staff/actions.ts');
    expect(src).toMatch(/setStaffSignature/);
    expect(src).toMatch(/removeStaffSignature/);
    expect(src).not.toMatch(/data:image|toDataURL|dataUrl|dataURL/);
    expect(existsSync(join(root, 'apps/erp/src/components/SignaturePad.tsx'))).toBe(true);
  });
});

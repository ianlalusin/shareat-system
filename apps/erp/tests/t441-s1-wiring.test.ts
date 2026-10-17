import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-441 S1 TESTER - wiring (source-reading + server-side render; this repo has no jsdom). Mutants M20-M23, M30, M31
 * and the route / repo / domain shape the audit fixed (A1, A3, A6). docs/tasks/441-photo-upload-control.md S1.
 *
 * ASSUMED CONTRACT:
 *   <PhotoUpload name purpose label required? capture? storeId? storeField? existing? /> default OR named export `PhotoUpload`
 *     in components/upload/PhotoUpload.tsx; SSR output (initial state) must show the shape, the picker, the words and the thumbnail rules.
 *   components/upload/Lightbox.tsx builds its image src as `/files/${id}?open=${counter}` (counter changes on every open).
 *   ap/actions.ts recordInvoiceAction: resolveUploadedFile(...) for the id, then claimUpload(...) AFTER recordInvoice(...).
 * RED reason before the build: none of the new files exist.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`${p} does not exist yet`);
  return readFileSync(full, 'utf8');
};
const UP = 'apps/erp/src/components/upload';

describe('the files S1 names exist', () => {
  it.each([
    `${UP}/upload-rules.ts`, `${UP}/upload-state.ts`, `${UP}/upload-xhr.ts`, `${UP}/PhotoUpload.tsx`, `${UP}/WaterFill.tsx`,
    `${UP}/Lightbox.tsx`, `${UP}/FileTile.tsx`, 'packages/domain/src/files/limits.ts', 'apps/erp/src/app/files/upload/route.ts',
    'apps/erp/src/lib/uploaded-file.ts',
  ])('%s', (p) => {
    expect(existsSync(join(root, p)), `${p} does not exist yet`).toBe(true);
  });
});

describe('M20/M21/M31 - the /ap pilot is wired to the control and the claim', () => {
  it('ap/page.tsx uses PhotoUpload (not PhotoInput) for the receipt, with the store field wired', () => {
    const src = read('apps/erp/src/app/ap/page.tsx');
    expect(src).toMatch(/components\/upload\/PhotoUpload/);
    expect(src).not.toMatch(/components\/PhotoInput/);
    const tag = src.slice(src.indexOf('<PhotoUpload'));
    const open = tag.slice(0, tag.indexOf('/>') + 2);
    expect(open).toMatch(/name="receiptPhoto"/);
    expect(open).toMatch(/purpose="receipt_photo"/);
    expect(open).toMatch(/storeField="storeId"/);
  });

  it('recordInvoiceAction resolves the id through resolveUploadedFile and claims it AFTER the invoice insert', () => {
    const src = read('apps/erp/src/app/ap/actions.ts');
    const start = src.indexOf('export async function recordInvoiceAction');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nexport async function', start + 10));
    expect(body).toMatch(/resolveUploadedFile\(/);
    expect(body).toMatch(/['"]receiptPhoto['"]/);
    expect(body).toMatch(/claimUpload\(/);
    expect(body.indexOf('claimUpload(')).toBeGreaterThan(body.indexOf('recordInvoice('));
    expect(body, 'the claim must run for BOTH paths, so it cannot sit inside an `if (...FileId...)`').toMatch(/linkTo/);
    // the action no longer reads the posted File itself nor calls uploadFile directly: the helper owns the no-JS fallback
    expect(body).not.toMatch(/formData\.get\(['"]receiptPhoto['"]\)/);
    expect(body).not.toMatch(/\buploadFile\(/);
    expect(src).toMatch(/uploaded-file/);
  });

  it('uploaded-file.ts: reads `${name}FileId`, keeps the no-JS File fallback through uploadFile, claims nothing itself', () => {
    const src = read('apps/erp/src/lib/uploaded-file.ts');
    expect(src).toMatch(/FileId/);
    expect(src).toMatch(/instanceof File/);
    expect(src).toMatch(/\buploadFile\(/);
    expect(src).toMatch(/export (async )?function resolveUploadedFile|export const resolveUploadedFile/);
    expect(src).not.toMatch(/claimUpload\(/);
    expect(src).not.toMatch(/from\s+['"]next\/(headers|navigation)['"]/); // callable from any action
  });
});

describe('A1/A2 - claimUpload is the repo\'s one conditional UPDATE, never linkFile', () => {
  it('domain claimUpload calls filesRepo.claimFile and does not reuse linkFile (it has no linked_to IS NULL guard)', () => {
    const src = read('packages/domain/src/files/index.ts');
    const start = src.indexOf('export async function claimUpload');
    expect(start, 'claimUpload is not defined in packages/domain/src/files/index.ts yet').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
    expect(body).toMatch(/claimFile\(/);
    expect(body).not.toMatch(/linkFile\(/);
    expect(body).not.toMatch(/\.update\(|\bUPDATE\b/); // SQL lives only in repo/
  });

  it('repo claimFile is one UPDATE guarded by org, uploader, purpose, store (NULL-safe), unlinked and the 24 h DB-clock window, RETURNING', () => {
    const src = read('packages/db/src/repo/files.ts');
    const start = src.indexOf('export async function claimFile');
    expect(start, 'claimFile is not defined in packages/db/src/repo/files.ts yet').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
    expect(body).toMatch(/\.update\(/);
    expect(body).toMatch(/isNull\(storedFiles\.linkedTo\)|linked_to is null/i);
    expect(body).toMatch(/storedFiles\.uploadedBy/);
    expect(body).toMatch(/storedFiles\.purpose/);
    expect(body).toMatch(/storedFiles\.orgId/);
    expect(body).toMatch(/is not distinct from|isNull\(storedFiles\.storeId\)/i);
    expect(body).toMatch(/now\(\)/i);
    expect(body).toMatch(/returning/i);
  });
});

describe('A3/A5 - the route file', () => {
  const src = () => read('apps/erp/src/app/files/upload/route.ts');
  it('is a node-runtime, never-cached POST that asks currentSession (not requireActor) and never buffers via formData()', () => {
    const s = src();
    expect(s).toMatch(/export (async )?function POST|export const POST/);
    expect(s).toMatch(/export const runtime = ['"]nodejs['"]/);
    expect(s).toMatch(/export const dynamic = ['"]force-dynamic['"]/);
    expect(s).toMatch(/currentSession\(/);
    expect(s).not.toMatch(/requireActor|requireSession/);
    expect(s).not.toMatch(/\.formData\(/);
    expect(s).toMatch(/x-forwarded-host/i);
    expect(s).toMatch(/no-store/);
    expect(s).toMatch(/uploadFile\(/);
  });
});

describe('M22/M30 - the lightbox', () => {
  const src = () => read(`${UP}/Lightbox.tsx`);
  it('builds its image src from /files/{id}?open={n} only - never a storage URL, path or signed link', () => {
    const s = src();
    expect(s).toMatch(/\/files\/\$\{[^}]+\}\?open=\$\{[^}]+\}/);
    expect(s).not.toMatch(/getDownloadURL|storage\.googleapis|firebasestorage|signedUrl|storagePath|memory:\/\//);
    expect(s).not.toMatch(/src=\{?['"]https?:/);
  });
  it('the open counter advances on every open (a repeated identical src would let the browser skip the audited GET)', () => {
    const s = src();
    expect(s).toMatch(/\+\+|\+=\s*1|\+\s*1\b|prev\s*=>\s*prev\s*\+\s*1|c\s*=>\s*c\s*\+\s*1/);
  });
  it('is a native modal dialog, the image mounts only while open, and a PDF is a link not an embed', () => {
    const s = src();
    expect(s).toMatch(/<dialog/);
    expect(s).toMatch(/showModal\(/);
    expect(s).toMatch(/Open PDF/);
    expect(s).not.toMatch(/<iframe|<embed|<object/);
    expect(s).toMatch(/\bopen\b\s*&&|\bopen\b\s*\?/); // <img> rendered only inside an open-gate
  });
});

describe('the XHR sender', () => {
  it('uses XMLHttpRequest upload progress against /files/upload, aborts, and words the failures', () => {
    const s = read(`${UP}/upload-xhr.ts`);
    expect(s).toMatch(/XMLHttpRequest/);
    expect(s).toMatch(/upload\.(onprogress|addEventListener\(['"]progress)/);
    expect(s).toMatch(/\/files\/upload/);
    expect(s).toMatch(/lengthComputable/);
    expect(s).toMatch(/\.abort\(\)/);
    expect(s).toMatch(/Upload interrupted - check the connection and press Retry/);
    expect(s).toMatch(/Your session ended - sign in again, then Retry/);
    expect(s).toMatch(/responseURL/);
    expect(s).not.toMatch(/setRequestHeader\(\s*['"]origin/i); // the browser sets Origin; a script cannot and must not
  });
  it('the water fill honours reduced motion and the theme tokens', () => {
    const s = read(`${UP}/WaterFill.tsx`);
    expect(s).toMatch(/motion-safe:/);
    expect(s).toMatch(/var\(--progress\)/);
    expect(s).toMatch(/var\(--progress-soft\)/);
  });
});

describe('M23 - the control, by source', () => {
  const src = () => read(`${UP}/PhotoUpload.tsx`);
  it('keeps the file input in the DOM (sr-only, not hidden), guards submission, announces politely, shows a real progressbar', () => {
    const s = src();
    expect(s).toMatch(/type="file"/);
    expect(s).toMatch(/sr-only/);
    const input = s.slice(s.indexOf('type="file"') - 200, s.indexOf('type="file"') + 400);
    expect(input).not.toMatch(/display:\s*['"]?none|className="hidden"|\bhidden\b\s*=/);
    expect(s).toMatch(/setCustomValidity\(\s*['"]Wait for the photo to finish uploading['"]/);
    expect(s).toMatch(/aria-live="polite"/);
    expect(s).toMatch(/role="progressbar"/);
    expect(s).toMatch(/aria-valuenow/);
    expect(s).toMatch(/\$\{name\}FileId|name\s*\+\s*['"]FileId['"]/); // the hidden id field the action reads
    expect(s).toMatch(/GUARDED_PURPOSES/);
    expect(s).toMatch(/upload-xhr/);
    expect(s).toMatch(/abort/);
    expect(s).toMatch(/revokeObjectURL/);
  });
  it('every /files/ URL the control or tile draws sits behind a guarded-purpose check', () => {
    for (const f of ['PhotoUpload.tsx', 'FileTile.tsx']) {
      const s = read(`${UP}/${f}`);
      let at = s.indexOf('/files/');
      while (at !== -1) {
        const before = s.slice(Math.max(0, at - 700), at);
        expect(before, `${f}: a /files/ src with no guarded check above it`).toMatch(/GUARDED|guarded|isGuarded/);
        at = s.indexOf('/files/', at + 1);
      }
    }
  });
});

// ------------------------------------------------------------------ server-side render (initial state, no effects)
async function renderControl(props: Record<string, unknown>): Promise<string> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('../src/components/upload/PhotoUpload')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`apps/erp/src/components/upload/PhotoUpload.tsx does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
  const C = (mod['PhotoUpload'] ?? mod['default']) as never;
  if (!C) throw new Error('PhotoUpload.tsx exports neither `PhotoUpload` nor a default');
  return renderToStaticMarkup(createElement(C, props as never));
}
const FID = '0190d3a4-0000-7000-8000-00000000abcd';

describe('M23/M6 - what the control renders (server render of the initial state)', () => {
  it('empty receipt: a button shape, a screen-reader-only file input that accepts images AND pdf, words, a polite live line', async () => {
    const html = await renderControl({ name: 'receiptPhoto', purpose: 'receipt_photo', label: 'Receipt photo', required: true });
    expect(html).toMatch(/<button/);
    expect(html).toMatch(/type="file"/);
    expect(html).toMatch(/name="receiptPhoto"/);
    expect(html).toMatch(/accept="[^"]*application\/pdf[^"]*"/);
    expect(html).toMatch(/accept="[^"]*image\/jpeg[^"]*"/);
    expect(html).toMatch(/Add photo or PDF/);
    expect(html).toMatch(/sr-only/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toMatch(/rounded-\[10px\]/);
    expect(html).not.toMatch(/rounded-full/);
    expect(html).toMatch(/required/);
    expect(html).not.toMatch(/<img/); // nothing to draw yet
  });

  it('staff photo is a circle, images only, and passes capture through', async () => {
    const html = await renderControl({ name: 'photo', purpose: 'staff_photo', label: 'Staff photo', capture: 'user' });
    expect(html).toMatch(/rounded-full/);
    expect(html).not.toMatch(/application\/pdf/);
    expect(html).toMatch(/capture="user"/);
    expect(html).toMatch(/Add photo/);
    expect(html).not.toMatch(/or PDF/);
  });

  it('M23 a stored leave certificate gets NO thumbnail and no /files/ request - a lock/document icon and "On file"', async () => {
    const html = await renderControl({ name: 'certificate', purpose: 'leave_document', label: 'Medical certificate', existing: { fileId: FID, kind: 'image' } });
    expect(html).not.toMatch(/<img/);
    expect(html).not.toContain('/files/');
    expect(html).not.toContain(FID);
    expect(html).toMatch(/On file/);
  });

  it('positive control: a stored receipt photo DOES draw its thumbnail from /files/{id}, with alt text from the label', async () => {
    const html = await renderControl({ name: 'receiptPhoto', purpose: 'receipt_photo', label: 'Receipt photo', existing: { fileId: FID, kind: 'image' } });
    expect(html).toMatch(new RegExp(`<img[^>]*src="/files/${FID}`));
    expect(html).toMatch(/alt="[^"]*Receipt photo[^"]*"/);
    expect(html).toMatch(/On file/);
  });

  it('a stored PDF is a document tile, never an <img>', async () => {
    const html = await renderControl({ name: 'receiptPhoto', purpose: 'receipt_photo', label: 'Receipt', existing: { fileId: FID, kind: 'pdf' } });
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/On file/);
  });

  it('a stored staff photo is allowed its thumbnail (gated by the loader passing `existing` only for canViewPhoto)', async () => {
    const html = await renderControl({ name: 'photo', purpose: 'staff_photo', label: 'Staff photo', existing: { fileId: FID, kind: 'image' } });
    expect(html).toMatch(new RegExp(`<img[^>]*src="/files/${FID}`));
  });
});

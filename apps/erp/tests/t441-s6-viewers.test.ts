import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-441 S6 TESTER - viewer-only surfaces (source-reading; this repo has no jsdom). docs/tasks/441-photo-upload-control.md S6, A6.
 *
 * ASSUMED CONTRACT:
 *   components/upload/PhotoThumb.tsx: default OR named export `PhotoThumb`, props { purpose, label, existing } (existing = { fileId, kind }),
 *   a client component that shows the stored picture inside the same shape (shapeFor) and opens the shared Lightbox on click.
 *   Read-only: never a file input. A PDF draws FileTile, never <img>. A guarded purpose never draws an <img> of the stored file.
 * DIFFERENCE FROM THE SPEC: staff/StaffViews.tsx has no "View photo" link; it draws a bare <img src="/files/..."> avatar. The
 * test asks for PhotoThumb to replace that <img>. The one remaining "View photo" link on staff is staff/[employmentId]/page.tsx (S3).
 * RED reason before the build: components/upload/PhotoThumb.tsx does not exist; the four screens still use links / bare <img>.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`${p} does not exist yet`);
  return readFileSync(full, 'utf8');
};
const UP = 'apps/erp/src/components/upload';
const APP = 'apps/erp/src/app';
const SCREENS = [
  `${APP}/ap/invoices/[id]/page.tsx`,
  `${APP}/customers/[customerId]/page.tsx`,
  `${APP}/inventory/deliveries/[id]/page.tsx`,
  `${APP}/staff/StaffViews.tsx`,
];
const FILE_INPUT = 'type="file"';

describe('PhotoThumb exists and is read-only', () => {
  it('M1 - components/upload/PhotoThumb.tsx exists and exports PhotoThumb', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    expect(src).toMatch(/export (default )?function PhotoThumb|export \{[^}]*PhotoThumb|export const PhotoThumb/);
  });

  it('M2 - it is a client component that reuses Lightbox and shapeFor (same shape + same full-size view)', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    expect(src).toMatch(/^\s*['"]use client['"]/m);
    expect(src).toMatch(/from ['"]\.\/Lightbox['"]/);
    expect(src).toMatch(/useLightbox/);
    expect(src).toMatch(/shapeFor/);
    expect(src).toMatch(/<Lightbox/);
  });

  it('M3 - it takes `existing` and has no file input, no upload, no change-the-file buttons', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    expect(src).toMatch(/existing/);
    expect(src).not.toContain(FILE_INPUT);
    expect(src).not.toMatch(/<input/);
    expect(src).not.toMatch(/sendFile|upload-xhr|shrinkPhoto|upload-compress|capture=/);
    expect(src).not.toMatch(/Replace|Remove/);
  });

  it('M4 - every src it builds is /files/{fileId} (no storage URL, no signed link, no path)', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    const srcs = src.match(/src=\{[^}]*\}/g) ?? [];
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s, s).toMatch(/\/files\//);
    expect(src).not.toMatch(/storage\.googleapis|firebasestorage|signedUrl|readFileUrl|https?:\/\//);
  });

  it('M5 - a PDF draws FileTile (document), never an <img>', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    expect(src).toMatch(/from ['"]\.\/FileTile['"]/);
    expect(src).toMatch(/<FileTile variant="document"/);
    expect(src).toMatch(/kind === 'image'|kind !== 'pdf'|kind === "image"/);
  });

  it('M6 - the guarded branch comes first, is exclusive, draws a lock tile and no <img> (mutant: guarded purpose draws the stored image)', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    expect(src).toMatch(/GUARDED_PURPOSES/);
    const g = src.indexOf('if (guarded)');
    const img = src.indexOf('<img');
    expect(g).toBeGreaterThan(-1);
    expect(img).toBeGreaterThan(-1);
    expect(g).toBeLessThan(img);
    const elseAt = src.indexOf('else', g);
    expect(elseAt).toBeGreaterThan(g);
    const guardBranch = src.slice(g, elseAt);
    expect(guardBranch).toContain('<FileTile variant="locked"');
    expect(guardBranch).not.toContain('<img');
    expect(elseAt).toBeLessThan(img); // the image is only in the else chain, never beside the guard
  });

  it('M7 - the click opens the Lightbox with kind and fileId (the audited /files/{id}?open=n route), from a real button', () => {
    const src = read(`${UP}/PhotoThumb.tsx`);
    const box = src.slice(src.indexOf('<Lightbox'));
    expect(box).toMatch(/fileId=/);
    expect(box).toMatch(/kind=/);
    expect(src).toMatch(/onClick=\{[^}]*show/);
    expect(src).toMatch(/<button/);
  });
});

describe('the four viewer screens use PhotoThumb', () => {
  it.each(SCREENS)('M8 - %s imports and renders PhotoThumb', (p) => {
    const src = read(p);
    expect(src).toMatch(/components\/upload\/PhotoThumb/);
    expect(src).toMatch(/<PhotoThumb/);
  });

  it.each(SCREENS)('M9 - %s no longer has the "View photo" link', (p) => {
    expect(read(p)).not.toMatch(/View photo/);
  });

  it.each(SCREENS)('M10 - %s has no new-tab link to /files/', (p) => {
    const src = read(p);
    expect(src).not.toMatch(/href=\{`\/files\//);
    expect(src).not.toMatch(/<a[^>]*\/files\/[^>]*target="_blank"/s);
  });

  it.each(SCREENS)('M11 - %s draws no <img> of its own for a /files/ picture (PhotoThumb owns it)', (p) => {
    expect(read(p)).not.toMatch(/<img[^>]*\/files\//s);
  });

  it.each(SCREENS)('M12 - %s has no file input and no upload control (viewer only)', (p) => {
    const src = read(p);
    expect(src).not.toContain(FILE_INPUT);
    expect(src).not.toMatch(/PhotoUpload|PhotoInput/);
  });
});

describe('each screen keeps its own read gate and the right purpose', () => {
  it('M13 - ap invoice: PhotoThumb inside the canViewReceipt gate, purpose receipt_photo, fileId = invoice.receiptFileId', () => {
    const src = read(`${APP}/ap/invoices/[id]/page.tsx`);
    expect(src).toMatch(/canViewPhoto\(actor, invoice\.receiptFileId\)/);
    const at = src.indexOf('<PhotoThumb');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 200), at)).toMatch(/canViewReceipt/);
    const tag = src.slice(at, src.indexOf('/>', at) + 2);
    expect(tag).toMatch(/purpose="receipt_photo"/);
    expect(tag).toMatch(/invoice\.receiptFileId/);
  });

  it('M14 - customer collections: PhotoThumb only for receipts in viewableReceipts, purpose receipt_photo', () => {
    const src = read(`${APP}/customers/[customerId]/page.tsx`);
    expect(src).toMatch(/viewableReceipts/);
    const at = src.indexOf('<PhotoThumb');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 300), at)).toMatch(/viewableReceipts\.has\(c\.receiptFileId\)/);
    const tag = src.slice(at, src.indexOf('/>', at) + 2);
    expect(tag).toMatch(/purpose="receipt_photo"/);
    expect(tag).toMatch(/c\.receiptFileId/);
  });

  it('M15 - delivery: PhotoThumb only when canViewProof, fileId = doc.proofFileId', () => {
    const src = read(`${APP}/inventory/deliveries/[id]/page.tsx`);
    expect(src).toMatch(/canViewPhoto\(actor, doc\.proofFileId\)/);
    const at = src.indexOf('<PhotoThumb');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 200), at)).toMatch(/canViewProof/);
    expect(src.slice(at, src.indexOf('/>', at) + 2)).toMatch(/doc\.proofFileId/);
  });
});

describe('staff list avatars', () => {
  it('M16 - Avatar draws PhotoThumb purpose="staff_photo" (a circle) for person.photoFileId, else initials', () => {
    const src = read(`${APP}/staff/StaffViews.tsx`);
    const at = src.indexOf('<PhotoThumb');
    expect(at).toBeGreaterThan(-1);
    const tag = src.slice(at, src.indexOf('/>', at) + 2);
    expect(tag).toMatch(/purpose="staff_photo"/);
    expect(tag).toMatch(/person\.photoFileId/);
    expect(src).toMatch(/initials\(person\.displayName\)/);
  });

  it('M17 - the list passes a photo only where canViewPhoto allows (staff/page.tsx gate kept; null otherwise)', () => {
    const src = read(`${APP}/staff/page.tsx`);
    expect(src).toMatch(/photoFileId: fileId && \(await canViewPhoto\(actor, fileId\)\) \? fileId : null/);
  });

  it('M18 - Avatar renders PhotoThumb purpose staff_photo only inside the person.photoFileId check, initials otherwise, no own <img> (mutant: photo drawn without the gate)', () => {
    const src = read(`${APP}/staff/StaffViews.tsx`);
    const start = src.indexOf('function Avatar');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nfunction ', start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    const gate = body.indexOf('if (person.photoFileId)');
    const thumb = body.indexOf('<PhotoThumb');
    const initialsAt = body.indexOf('initials(person.displayName)');
    expect(gate).toBeGreaterThan(-1);
    expect(thumb).toBeGreaterThan(gate);
    expect(initialsAt).toBeGreaterThan(thumb);
    const tag = body.slice(thumb, body.indexOf('/>', thumb) + 2);
    expect(tag).toMatch(/purpose="staff_photo"/);
    expect(body).not.toContain('<img');
  });
});

describe('guarded purposes never get a thumbnail anywhere', () => {
  it.each(SCREENS)('M19 - %s never names leave_document or staff_signature in a PhotoThumb', (p) => {
    const src = read(p);
    expect(src).toMatch(/<PhotoThumb/); // fails red until the screen uses it, so this cannot pass vacuously
    for (const m of src.matchAll(/<PhotoThumb[\s\S]*?\/>/g)) {
      expect(m[0]).not.toMatch(/leave_document|staff_signature/);
    }
  });

  it('M20 - no PhotoThumb on the leave or signature screens', () => {
    expect(existsSync(join(root, `${UP}/PhotoThumb.tsx`)), 'PhotoThumb does not exist yet').toBe(true);
    for (const p of [`${APP}/attendance/leave/page.tsx`, `${APP}/staff/SignaturePad.tsx`]) {
      if (!existsSync(join(root, p))) continue;
      expect(read(p), p).not.toMatch(/<PhotoThumb/);
    }
  });
});

describe('M21 - the thumbnail kind is the file\'s real kind, read only behind the read gate', () => {
  const PAGES = [
    { p: `${APP}/ap/invoices/[id]/page.tsx`, gate: 'canViewReceipt', id: 'invoice.receiptFileId' },
    { p: `${APP}/customers/[customerId]/page.tsx`, gate: 'viewableReceipts', id: 'viewableReceipts' },
    { p: `${APP}/inventory/deliveries/[id]/page.tsx`, gate: 'canViewProof', id: 'doc.proofFileId' },
  ];

  it.each(PAGES)('M21a - %s calls photoKinds( and imports it (mutant: kind never looked up)', ({ p }) => {
    const src = read(p);
    expect(src).toMatch(/import \{[^}]*photoKinds[^}]*\} from '[^']*lib\/photo-link'/);
    expect(src).toMatch(/photoKinds\(actor,/);
  });

  it.each(PAGES)('M21b - %s passes a computed kind to PhotoThumb, never a literal (mutant: kind hard-coded to image)', ({ p }) => {
    const src = read(p);
    const at = src.indexOf('<PhotoThumb');
    expect(at).toBeGreaterThan(-1);
    const tag = src.slice(at, src.indexOf('/>', at) + 2).replace(/ \?\? 'image'/g, '');
    expect(tag).toMatch(/kind: [A-Za-z.]+/);
    expect(tag).not.toMatch(/kind: ['"]/);
    expect(tag).not.toMatch(/kind=['"{]/);
    expect(tag).not.toMatch(/'image'|'pdf'/);
    // the fallback literal may exist only after a lookup (`?? 'image'`), never as the whole value
    expect(src).not.toMatch(/kind: 'image'\s*\}\}/);
  });

  it.each(PAGES)('M21c - %s reads kinds only behind its gate (mutant: kinds read for ungated ids)', ({ p, gate, id }) => {
    const src = read(p);
    const at = src.indexOf('photoKinds(actor,');
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    if (gate === 'viewableReceipts') {
      // the ids are exactly the gated set
      expect(line).toMatch(/photoKinds\(actor, \[\.\.\.viewableReceipts\]\)/);
    } else {
      expect(line).toContain(`${gate} && ${id}`);
      expect(line).toContain(`photoKinds(actor, [${id}])`);
    }
  });

  it('M21d - photoKinds maps application/pdf to pdf, anything else to image (mutant: always image)', () => {
    const src = read('apps/erp/src/lib/photo-link.ts');
    expect(src).toMatch(/r\.contentType === 'application\/pdf' \? 'pdf' : 'image'/);
    expect(src).toMatch(/kinds\.set\(r\.id,/);
  });

  it('M21e - photoKinds reads only the ids it is given, org-scoped (mutant: reads all files)', () => {
    const src = read('apps/erp/src/lib/photo-link.ts');
    expect(src).toMatch(/filesRepo\.getByIds\(tx, actor\.orgId, fileIds\)/);
  });
});

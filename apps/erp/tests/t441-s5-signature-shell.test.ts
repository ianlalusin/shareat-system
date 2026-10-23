import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * T-441 S5 TESTER - the signature adopts the upload shell (source-reading; this repo has no jsdom). The behavioural proofs
 * (staffMediaView hands the id only to a viewer who may see it; each GET of a signature is one audited view) are in
 * tests/integration/t441-s5-signature-view.test.ts.
 * docs/tasks/441-photo-upload-control.md section 4 "Signature (Q4)", audit A6 + A10, section 5 S5; bible row 353.
 *
 * ASSUMED CONTRACT:
 *   components/SignaturePad.tsx keeps the drawn canvas and gains an optional prop `signatureFileId?: string | null`.
 *   When it is set the saved state is a TILE: the text "Signature on file" + a <button> "View" that opens the shared
 *   <Lightbox> (components/upload/Lightbox, hook useLightbox) with fileId={signatureFileId} kind="image" and count={...}
 *   (the hook's counter gives the fresh ?open= per open, A6). The pad never builds a /files/ URL and never draws an <img>.
 *   Save shows Saving -> Saved, or Failed + a Retry button. No percentage, no progressbar.
 *   staff/[employmentId]/page.tsx passes signatureFileId={media.signatureFileId} (the loader decides who gets it) and no longer
 *   uses viewStaffSignatureAction; staff/actions.ts loses that action; staff/lib.ts mediaFor carries the field.
 *   people/staff-media.ts staffMediaView returns signatureFileId (string | null) and its header comment no longer says it never does.
 *
 * Mutants: S5a id handed to every viewer; S5b <img> thumbnail drawn on the page or in the pad; S5c tile without View button
 * or View not wired to the shared Lightbox; S5d own lightbox/URL (no fresh ?open= counter); S5e tile drawn although no id was
 * passed; S5f Save states missing; S5g percentage/progressbar; S5h old view-redirect action kept; S5i id leaks into a list /
 * card / export loader.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`${p} does not exist`);
  return readFileSync(full, 'utf8');
};
const PAGE = 'apps/erp/src/app/staff/[employmentId]/page.tsx';
const PAD = 'apps/erp/src/components/SignaturePad.tsx';
const ACTIONS = 'apps/erp/src/app/staff/actions.ts';
const MEDIA = 'packages/domain/src/people/staff-media.ts';
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

describe('S5 - the domain loader carries the id (and the old promise is retired)', () => {
  it('S5a staffMediaView names signatureFileId in its result type and gates it with a ternary ending in null', () => {
    const src = stripComments(read(MEDIA));
    expect(src).toMatch(/signatureFileId\s*:\s*string\s*\|\s*null/);
    const body = src.slice(src.indexOf('export async function staffMediaView'));
    // the id may only be assigned behind the viewer check, never straight from the stored column
    expect(body).toMatch(/signatureFileId\s*[:=][^,;\n]*\?[^,;\n]*:\s*null/);
  });
  it('A10: the header comment no longer says nothing returns a signature file id, and the loader doc no longer says "never its id"', () => {
    const raw = read(MEDIA);
    expect(raw).not.toMatch(/Nothing here returns a signature file id/);
    expect(raw).not.toMatch(/Returns booleans for the signature, never its id/);
  });
  it('the page-level wrapper mediaFor (staff/lib.ts) carries the field, and its failure fallback is null', () => {
    const lib = read('apps/erp/src/app/staff/lib.ts');
    const at = lib.indexOf('export async function mediaFor');
    const body = lib.slice(at, at + 900);
    expect(body).toMatch(/signatureFileId\s*:\s*string\s*\|\s*null/);
    expect(body).toMatch(/signatureFileId\s*:\s*null/);
  });
});

describe('S5 - the signature never appears as a picture outside the Lightbox', () => {
  it('S5b the pad and the staff page draw no <img> and no thumbnail component', () => {
    for (const f of [PAD, PAGE]) {
      const src = stripComments(read(f));
      expect(src, `${f} has an <img`).not.toMatch(/<img\b/);
      expect(src, `${f} uses a thumbnail`).not.toMatch(/PhotoThumb|Thumbnail|thumbnail/);
    }
  });
  it('S5d the pad builds no /files/ URL and no ?open= of its own - the shared Lightbox + useLightbox own both', () => {
    const src = stripComments(read(PAD));
    expect(src).not.toMatch(/\/files\//);
    expect(src).not.toMatch(/\?open=/);
    expect(src).not.toMatch(/<dialog\b/);
    expect(src).toMatch(/import\s*\{[^}]*\bLightbox\b[^}]*\}\s*from\s*['"][^'"]*upload\/Lightbox['"]/);
    expect(src).toMatch(/import\s*\{[^}]*\buseLightbox\b[^}]*\}\s*from\s*['"][^'"]*upload\/Lightbox['"]/);
    expect(src).toMatch(/useLightbox\(\)/);
  });
  it('the page hands the pad only the id the loader allowed, never a file URL', () => {
    const src = read(PAGE);
    expect(src).toMatch(/signatureFileId=\{media\.signatureFileId\}/);
    expect(src).not.toMatch(/\/files\/\$\{media\.signatureFileId/);
  });
});

describe('S5 - the saved state is a "Signature on file" tile with a View button into the Lightbox', () => {
  const pad = () => stripComments(read(PAD));
  it('S5c the pad takes an optional signatureFileId prop', () => {
    expect(pad()).toMatch(/signatureFileId\??\s*:\s*string/);
  });
  it('S5c the tile says "Signature on file" and has a <button> whose text is exactly View', () => {
    const src = pad();
    expect(src).toContain('Signature on file');
    expect(src).toMatch(/<button\b[^>]*>\s*View\s*<\/button>/);
  });
  it('S5c View opens the shared Lightbox: onClick calls the hook show, and the Lightbox gets fileId, kind="image" and count', () => {
    const src = pad();
    expect(src).toMatch(/=\s*useLightbox\(\)/);
    const btn = src.match(/<button\b[^>]*>\s*View\s*<\/button>/)?.[0] ?? '';
    expect(btn).toMatch(/onClick=\{[^}]*\bshow\b/);
    const tag = src.match(/<Lightbox\b[\s\S]*?\/>/)?.[0] ?? '';
    expect(tag, 'no <Lightbox .../> in the pad').not.toBe('');
    expect(tag).toMatch(/fileId=\{signatureFileId\}/);
    expect(tag).toMatch(/kind=["']image["']/);
    expect(tag).toMatch(/count=\{/);
    expect(tag).toMatch(/open=\{/);
    expect(tag).toMatch(/onClose=\{/);
    expect(tag).not.toMatch(/localSrc/);
  });
  it('S5e the tile and the Lightbox are rendered only when signatureFileId was passed', () => {
    const src = pad();
    const tileAt = src.indexOf('Signature on file');
    expect(tileAt).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, tileAt - 400), tileAt)).toMatch(/signatureFileId\s*(&&|\?)/);
    const lbAt = src.indexOf('<Lightbox');
    expect(lbAt).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, lbAt - 300), lbAt)).toMatch(/signatureFileId\s*(&&|\?)/);
  });
  it('the page no longer owns the saved state: no View-signature form, no old view action', () => {
    const src = stripComments(read(PAGE));
    expect(src).not.toMatch(/viewStaffSignatureAction/);
    expect(src).not.toMatch(/View signature/);
  });
});

describe('S5 - Save shows Saving, then Failed + Retry on error, and no percentage', () => {
  const pad = () => stripComments(read(PAD));
  it('S5f the words Saving and Failed and a Retry button are present (no Saved: the action redirects, so it is unreachable)', () => {
    const src = pad();
    expect(src).toMatch(/Saving/);
    expect(src).toMatch(/Failed/);
    expect(src).toMatch(/<button\b[^>]*>\s*Retry\s*<\/button>/);
  });
  it('S5f no dead Saved state: no setSaved / saved state variable remains (a redirect reloads the page, so it can never show)', () => {
    expect(pad()).not.toMatch(/setSaved|\[\s*saved\b|useState<[^>]*>\(\s*['"]saved['"]/i);
  });
  it('S5f Retry runs the same save again (onClick wired to save)', () => {
    const btn = pad().match(/<button\b[^>]*>\s*Retry\s*<\/button>/)?.[0] ?? '';
    expect(btn).toMatch(/onClick=\{[^}]*\bsave\b/);
  });
  it('S5g no percentage and no progressbar (a small PNG through its own server action)', () => {
    const src = pad();
    expect(src).not.toMatch(/role=["']progressbar["']/);
    expect(src).not.toMatch(/aria-valuenow/);
    expect(src).not.toMatch(/\d\s*%|[pP]ercent|[pP]rogress/);
  });
});

describe('S5 - the old view-by-redirect server action is gone', () => {
  it('S5h staff/actions.ts no longer has viewStaffSignatureAction nor mints a signature URL to redirect to', () => {
    const src = stripComments(read(ACTIONS));
    expect(src).not.toMatch(/viewStaffSignatureAction/);
    expect(src).not.toMatch(/viewStaffSignatureUrl/);
    expect(src).not.toMatch(/redirect\(`\$\{url\}`\)/);
  });
  it('S5h nothing in apps/erp/src still references the removed action', () => {
    const offenders = walk(join(root, 'apps/erp/src')).map(rel).filter((f) => /viewStaffSignatureAction/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('positive control: set and remove actions stay (only the VIEW action went)', () => {
    const src = stripComments(read(ACTIONS));
    expect(src).toMatch(/removeStaffSignatureAction/);
    expect(src).toMatch(/setStaffSignatureAction/);
  });
});

describe('row 353 - signatureFileId lives only in the detail-page chain, in no list, card, export or other loader', () => {
  it('S5i apps/erp/src: only the detail page, its mediaFor wrapper and the pad name it', () => {
    const ALLOWED = [PAGE, 'apps/erp/src/app/staff/lib.ts', PAD];
    const offenders = walk(join(root, 'apps/erp/src')).map(rel).filter((f) => !ALLOWED.includes(f)).filter((f) => /signatureFileId/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('S5i packages/domain/src: only staff-media.ts (the detail-page loader) names it', () => {
    const offenders = walk(join(root, 'packages/domain/src')).map(rel).filter((f) => f !== MEDIA).filter((f) => /signatureFileId/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('S5i packages/db/src: only persons.ts (column accessors), the schema, and the T-442 file-reference registry (files.ts, ref() form only) name it; rosters (employment.ts) never do', () => {
    const offenders = walk(join(root, 'packages/db/src'))
      .map(rel)
      .filter((f) => !f.startsWith('packages/db/src/schema/') && f !== 'packages/db/src/repo/persons.ts')
      .filter((f) => {
        let src = read(f);
        // T-442 registry: ref('persons', 'signature_file_id', [...]) only returns the id to the sweep/backfill, never to a screen
        if (f === 'packages/db/src/repo/files.ts') src = src.replace(/ref\(\s*'persons'\s*,\s*'signature_file_id'\s*,[^)]*\)/g, '');
        return /signatureFileId|signature_file_id/.test(src);
      });
    expect(offenders).toEqual([]);
  });
  it('S5i the staff list, wall and views still never mention a signature', () => {
    for (const f of ['apps/erp/src/app/staff/page.tsx', 'apps/erp/src/app/staff/StaffViews.tsx']) {
      expect(read(f), f).not.toMatch(/signature/i);
    }
  });
});

describe('S5 - readOnly (ended employment): tile + View only, never the drawing surface', () => {
  const pad = () => stripComments(read(PAD));
  it('the pad takes readOnly and its readOnly branch returns before any <canvas>, Clear, Save or Retry', () => {
    const src = pad();
    expect(src).toMatch(/readOnly\??\s*:\s*boolean/);
    const at = src.search(/if\s*\(\s*readOnly\s*\)\s*\{/);
    expect(at, 'no `if (readOnly) {` early return').toBeGreaterThan(-1);
    const end = src.indexOf('\n  }\n', at);
    const branch = src.slice(at, end);
    expect(branch).toMatch(/return\s*\(/);
    expect(branch).not.toMatch(/<canvas|Save signature|Clear|Retry|onPointer/);
    // and the canvas only exists after that branch
    expect(src.indexOf('<canvas')).toBeGreaterThan(end);
  });
  it('the page passes readOnly for an ended employment', () => {
    expect(read(PAGE)).toMatch(/<SignaturePad[^>]*\sreadOnly(\s|=|\/>|>)/);
    expect(read(PAGE)).toMatch(/isEnded/);
  });
});

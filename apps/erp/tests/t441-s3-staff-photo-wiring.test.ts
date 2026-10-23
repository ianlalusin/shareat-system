import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-441 S3 TESTER - the staff photo is wired to the shared control (source-reading; this repo has no jsdom).
 * docs/tasks/441-photo-upload-control.md section 5 "S3", bible row 353 (personal data strictly guarded), row 364.
 *
 * ASSUMED CONTRACT:
 *   staff/[employmentId]/page.tsx renders <PhotoUpload name="photo" purpose="staff_photo" capture="user" .../> from
 *   components/upload/PhotoUpload, `existing` is passed ONLY when the loader/canViewPhoto allowed it, PhotoInput is gone.
 *   staff/actions.ts setStaffPhotoAction resolves the id with resolveUploadedFile(..., 'photo', { purpose: 'staff_photo', ... })
 *   (reads `photoFileId`, keeps the no-JS File fallback) and hands { employmentId, fileId } to setStaffPhoto.
 *   people/staff-media.ts setStaffPhoto claims with claimUpload on the fileId path.
 *
 * Mutants: M42 page still imports PhotoInput; M43 wrong purpose; M44 capture dropped; M45 `existing` passed unconditionally
 * (a viewer without rights gets a fileId, row 353); M46 page passes its own shape (circle must come from shapeFor);
 * M47 action ignores photoFileId / reads the File itself; M48 action never passes the fileId to setStaffPhoto;
 * M49 domain claim path skips claimUpload.
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`${p} does not exist yet`);
  return readFileSync(full, 'utf8');
};
const PAGE = 'apps/erp/src/app/staff/[employmentId]/page.tsx';

/** True when the gate call (self-refusal, enrol_staff, ended) appears before the first claimUpload( in a function body. */
function gatesBeforeClaim(body: string): boolean {
  const gate = body.indexOf('openEmploymentForPhoto(');
  const claim = body.indexOf('claimUpload(');
  return gate > -1 && claim > -1 && gate < claim;
}

/** The opening <PhotoUpload ... /> tag, from its start to the first self-closing `/>` that is not inside a { } expression. */
function photoUploadTag(src: string): string {
  const start = src.indexOf('<PhotoUpload');
  expect(start, '<PhotoUpload is not used on the staff page yet').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '/' && src[i + 1] === '>') return src.slice(start, i + 2);
  }
  throw new Error('unterminated <PhotoUpload tag');
}

describe('the staff page uses the shared control', () => {
  it('M42 imports PhotoUpload from components/upload and no longer imports PhotoInput', () => {
    const src = read(PAGE);
    expect(src).toMatch(/components\/upload\/PhotoUpload/);
    expect(src).not.toMatch(/components\/PhotoInput/);
    expect(src).not.toMatch(/<PhotoInput\b/);
  });

  it('M43/M44/M46 name "photo", purpose staff_photo, capture "user", and no hand-set shape (the circle comes from shapeFor)', () => {
    const tag = photoUploadTag(read(PAGE));
    expect(tag).toMatch(/name="photo"/);
    expect(tag).toMatch(/purpose="staff_photo"/);
    expect(tag).toMatch(/capture="user"/);
    expect(tag).toMatch(/label=/);
    expect(tag, 'shape must come from shapeFor(purpose), not a prop').not.toMatch(/\bshape\s*=/);
  });

  it('the photo is filed under the employment store: storeId is passed to the control', () => {
    const tag = photoUploadTag(read(PAGE));
    expect(tag).toMatch(/storeId=\{[^}]*\}/);
  });

  it('M45 row 353: `existing` is passed only when the viewer may open the photo, never a raw id', () => {
    const src = read(PAGE);
    const tag = photoUploadTag(src);
    const m = tag.match(/existing=\{([\s\S]*?)\}\s*(?:\/>|[a-zA-Z]+=)/);
    expect(m, '`existing` prop missing on the staff photo control').not.toBeNull();
    const expr = m![1]!;
    // gated by the loader's photoFileId (null unless enrol_staff at the store) or canViewPhoto
    expect(expr).toMatch(/media\.photoFileId|canViewPhoto/);
    expect(expr, 'existing must be conditional (null/undefined for a viewer without rights)').toMatch(/\?|&&/);
    expect(expr).toMatch(/kind:\s*['"]image['"]/);
    // no other place hands the control a file id
    expect(src.match(/existing=/g) ?? []).toHaveLength(1);
  });
});

describe('the action reads the uploaded id and keeps the no-JS fallback', () => {
  const body = () => {
    const src = read('apps/erp/src/app/staff/actions.ts');
    const start = src.indexOf('export async function setStaffPhotoAction');
    expect(start).toBeGreaterThan(-1);
    return { src, body: src.slice(start, src.indexOf('\nexport async function', start + 10)) };
  };

  it('M47 reads photoFileId and passes fileId; keeps the File fallback as contentType/bytes; never uploads before the gates', () => {
    const { src, body: b } = body();
    expect(b).toMatch(/photoFileId/);
    expect(b).toMatch(/fileId/);
    // the File fallback: the body reads the part itself or via the file's filePart helper, which yields contentType + bytes
    expect(b).toMatch(/filePart\(formData,\s*['"]photo['"]\)|contentType/);
    expect(src).toMatch(/contentType:\s*f\.type[\s\S]{0,80}bytes:/);
    // mutant: upload before gates - the action must not upload itself; setStaffPhoto uploads after its gates
    expect(b).not.toMatch(/resolveUploadedFile\(/);
    expect(b).not.toMatch(/\buploadFile\(/);
  });

  it('M48 hands { employmentId, fileId } to setStaffPhoto', () => {
    const { body: b } = body();
    expect(b).toMatch(/setStaffPhoto\(/);
    expect(b).toMatch(/fileId/);
  });

  it('refuses with a sentence when neither a file id nor a file was posted (required cannot be enforced by a hidden input)', () => {
    const { body: b } = body();
    expect(b).toMatch(/Choose or take a photo/);
  });
});

describe('the domain claim path', () => {
  it('M49 setStaffPhoto claims a posted fileId with claimUpload, linking to the employment', () => {
    const src = read('packages/domain/src/people/staff-media.ts');
    const start = src.indexOf('export async function setStaffPhoto');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
    expect(body).toMatch(/claimUpload\(/);
    expect(body).toMatch(/fileId/);
    expect(body).toMatch(/linkTo/);
  });

  it('M50 the gates run BEFORE claimUpload (a throw rolls the claim back, so only source order proves it)', () => {
    const src = read('packages/domain/src/people/staff-media.ts');
    const start = src.indexOf('export async function setStaffPhoto');
    const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
    expect(gatesBeforeClaim(body)).toBe(true);
    // proven red on an in-memory mutated copy: the claim line moved to the top of the function
    const claimLine = body.match(/\n[^\n]*claimUpload\([^\n]*/)![0];
    const moved = body.replace(claimLine, '').replace('{\n', '{' + claimLine + '\n');
    expect(gatesBeforeClaim(moved), 'the order check must go red when the claim is moved before the gates').toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-441 S4 TESTER - wiring of the leave certificate onto the shared upload control (source-reading; this repo has no jsdom).
 * docs/tasks/441-photo-upload-control.md section 5 "S4", section 4 "Guarded purposes", audit A6, bible row 353.
 *
 * ASSUMED CONTRACT (the builder must match, or say so):
 *   attendance/leave/page.tsx renders <PhotoUpload name="certificate" purpose="leave_document" label=... storeId=... />
 *     imported from '@/components/upload/PhotoUpload' (PhotoInput is gone from the page).
 *   "View certificate" is a button that opens the shared Lightbox. Because the Lightbox needs client state, the button may live in a
 *     small client component in the same folder (apps/erp/src/app/attendance/leave/*.tsx); the test reads page.tsx AND every
 *     .tsx next to it, and requires the text "View certificate" to sit in a file that imports components/upload/Lightbox.
 *   The page decides who sees it through loadProofFileId (lib.ts) - the file id is passed down ONLY from that result.
 *   actions.ts: openLeaveDocumentAction (the server-action redirect to a signed URL) is gone;
 *   attachLeaveDocumentAction resolves the id with resolveUploadedFile(..., 'certificate', { purpose: 'leave_document', ... }) and passes
 *   { requestId, fileId } to attachLeaveDocument; it no longer reads the posted File itself.
 *
 * RED reason before the build: the page still uses PhotoInput and openLeaveDocumentAction.
 * Mutants killed are named in each title (S4-Wn).
 */
const root = join(__dirname, '..', '..', '..');
const read = (p: string) => {
  const full = join(root, p);
  if (!existsSync(full)) throw new Error(`${p} does not exist`);
  return readFileSync(full, 'utf8');
};
const LEAVE = 'apps/erp/src/app/attendance/leave';
const leaveTsx = () =>
  readdirSync(join(root, LEAVE))
    .filter((n) => n.endsWith('.tsx'))
    .map((n) => ({ name: n, src: read(`${LEAVE}/${n}`) }));
/** The text of one JSX opening tag starting at `start`, up to its closing `/>`. */
const tagAt = (src: string, start: number) => src.slice(start, src.indexOf('/>', start) + 2);

describe('S4-W1 - the certificate field is the shared PhotoUpload control', () => {
  const page = () => read(`${LEAVE}/page.tsx`);

  it('S4-W1a page.tsx imports PhotoUpload from components/upload and no longer PhotoInput', () => {
    expect(page()).toMatch(/components\/upload\/PhotoUpload/);
    expect(page()).not.toMatch(/components\/PhotoInput/);
    expect(page()).not.toMatch(/PhotoInput/);
  });

  it('S4-W1b the tag carries name="certificate", purpose="leave_document" and a store', () => {
    const src = page();
    const at = src.indexOf('<PhotoUpload');
    expect(at, '<PhotoUpload is not used on the leave page').toBeGreaterThan(-1);
    const tag = tagAt(src, at);
    expect(tag).toMatch(/name="certificate"/);
    expect(tag).toMatch(/purpose="leave_document"/);
    expect(tag, 'the upload is stored under the request store (claim compares it)').toMatch(/storeId=\{/);
    expect(tag).toMatch(/label=/);
  });

  it('S4-W1c the page has no raw file input of its own', () => {
    for (const { name, src } of leaveTsx()) expect(src, name).not.toMatch(/type="file"/);
  });

  it('S4-W1d the action never uploads before the domain gates: no resolveUploadedFile / uploadFile; fileId when posted, bytes fallback kept', () => {
    const src = read(`${LEAVE}/actions.ts`);
    const start = src.indexOf('export async function attachLeaveDocumentAction');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf(String.fromCharCode(10) + 'export ', start + 10);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body, 'mutant: upload before the gates').not.toMatch(/resolveUploadedFile\(|uploadFile\(/);
    expect(body).toMatch(/['"]certificateFileId['"]/);
    expect(body).toMatch(/attachLeaveDocument\(/);
    expect(body, 'posted id goes to the domain as { requestId, fileId }').toMatch(/\{ requestId, fileId \}/);
    expect(body, 'no-JS bytes fallback kept').toMatch(/contentType/);
    expect(body).toMatch(/arrayBuffer\(/);
  });
});

describe('S4-W2 - "View certificate" is the Lightbox, not a redirect to a signed URL', () => {
  it('S4-W2a openLeaveDocumentAction is gone from actions.ts and from the page', () => {
    expect(read(`${LEAVE}/actions.ts`)).not.toMatch(/openLeaveDocumentAction/);
    for (const { name, src } of leaveTsx()) expect(src, name).not.toMatch(/openLeaveDocumentAction/);
  });

  it('S4-W2b no server action in the leave folder redirects to a signed link any more', () => {
    const src = read(`${LEAVE}/actions.ts`);
    expect(src).not.toMatch(/openLeaveDocument\(/);
    expect(src).not.toMatch(/from 'next\/navigation'/); // redirect(url) was its only use
    expect(src).not.toMatch(/redirect\(`\$\{url\}`\)/);
  });

  it('S4-W2c the words "View certificate" live in a file that imports the shared Lightbox', () => {
    const holders = leaveTsx().filter((f) => f.src.includes('View certificate'));
    expect(holders.length, 'no "View certificate" button found').toBeGreaterThan(0);
    for (const h of holders) {
      expect(h.src, `${h.name} shows View certificate but does not use the Lightbox`).toMatch(/components\/upload\/Lightbox/);
      expect(h.src, h.name).toMatch(/useLightbox|<Lightbox/);
      expect(h.src, `${h.name}: a form posting to a server action is the old design`).not.toMatch(/<form[^>]*action=\{open/);
    }
  });

  it('S4-W2d the Lightbox is given the file id (route-backed) and the page never builds a /files/ URL or fetches bytes itself', () => {
    for (const { name, src } of leaveTsx()) {
      expect(src, name).not.toMatch(/['"`]\/files\//);
      expect(src, name).not.toMatch(/fetch\(/);
    }
    const holder = leaveTsx().find((f) => f.src.includes('View certificate'))!;
    expect(holder.src).toMatch(/fileId=\{/);
  });
});

describe('S4-W3 - the file id reaches the page only from the deciding loader', () => {
  it('S4-W3a the page calls loadProofFileId and gates "View certificate" on its result', () => {
    const page = read(`${LEAVE}/page.tsx`);
    expect(page).toMatch(/loadProofFileId\(/);
    expect(page).toMatch(/proofFileId/);
    // the view is rendered inside a branch on proofFileId, never on hasProof alone
    const all = leaveTsx();
    for (const f of all) {
      for (let at = f.src.indexOf('View certificate'); at !== -1; at = f.src.indexOf('View certificate', at + 1)) {
        const before = f.src.slice(Math.max(0, at - 900), at);
        expect(before, `${f.name}: View certificate is not gated on the deciding loader's id`).toMatch(/[pP]roofFileId|fileId/);
      }
    }
  });

  it('S4-W3b the page never reads the certificate id from the repo, the group rows or hasProof', () => {
    const page = read(`${LEAVE}/page.tsx`);
    expect(page).not.toMatch(/proofFileOf|requestOfFile|leaveRepo/);
    const lib = read(`${LEAVE}/lib.ts`);
    expect(lib).toMatch(/export (async )?function loadProofFileId/);
    expect(lib, 'the loader decides through the T-436 decision').toMatch(/decideLeaveDocumentRead|proofFileIdFor|leaveProofFileId/);
    expect(lib, 'the loader must not write an audit row').not.toMatch(/recordLeaveDocumentViewed|recordLeaveDocumentViewRefused|auditLogRepo/);
  });

  it('S4-W3c RequestGroup (the list rows) still carries hasProof only - no file id in list data', () => {
    const lib = read(`${LEAVE}/lib.ts`);
    const iface = lib.slice(lib.indexOf('export interface RequestGroup'), lib.indexOf('export function groupByRequest'));
    expect(iface).toMatch(/hasProof: boolean/);
    expect(iface).not.toMatch(/fileId|FileId/);
  });
});

describe('S4-W4 - guarded: no thumbnail of a stored certificate anywhere on the leave screen', () => {
  it('S4-W4a no <img> element in page.tsx or any client component beside it', () => {
    for (const { name, src } of leaveTsx()) expect(src, name).not.toMatch(/<img[ >\n]/);
  });

  it('S4-W4b PhotoUpload is never given `existing` for a certificate (the shape would hold a lock tile anyway; the id is for the Lightbox only)', () => {
    const src = read(`${LEAVE}/page.tsx`);
    const tag = tagAt(src, src.indexOf('<PhotoUpload'));
    expect(tag).not.toMatch(/existing=/);
  });

  it('S4-W4c the shared control still treats leave_document as guarded (so a stored one is never fetched as a thumbnail)', () => {
    const rules = read('apps/erp/src/components/upload/upload-rules.ts');
    expect(rules).toMatch(/GUARDED_PURPOSES[^\n]*leave_document/);
  });
});

describe('S4-W5 - attachLeaveDocument runs its gates before the claim (source order)', () => {
  const src = () => read('packages/domain/src/leave/documents.ts');
  /** Position check on one function body; exported shape so a mutated copy can be judged by the same rule. */
  function gatesBeforeClaim(text: string): string | null {
    const start = text.indexOf('export function attachLeaveDocument');
    if (start === -1) return 'attachLeaveDocument not found';
    const next = text.indexOf(String.fromCharCode(10) + 'export ', start + 10);
    const body = text.slice(start, next === -1 ? undefined : next);
    const claim = body.indexOf('claimUpload(');
    const auth = body.indexOf("authorize(trx, actor, 'manage_attendance'");
    const refuse = body.indexOf("'LEAVE_DOCUMENT_REFUSED'");
    if (claim === -1) return 'no claimUpload( call';
    if (auth === -1 || refuse === -1) return 'a gate is missing';
    if (auth > claim) return 'claim before authorize';
    if (refuse > claim) return 'claim before the cancelled/rejected check';
    return null;
  }

  it('S4-W5a the real source: authorize and the cancelled/rejected refusal come before claimUpload(', () => {
    expect(gatesBeforeClaim(src())).toBeNull();
  });

  it('S4-W5b proven red on in-memory mutants: claim moved before authorize, and before the status check', () => {
    const s = src();
    const claimBlock = /    if \('fileId' in input\) \{\n[^]*?\n    \}\n/.exec(s)![0];
    const without = s.replace(claimBlock, '');
    const m1 = without.replace('    const request = await leaveRepo', claimBlock + '    const request = await leaveRepo');
    expect(gatesBeforeClaim(m1), 'mutant: claim first').not.toBeNull();
    const authLine = "    await authorize(trx, actor, 'manage_attendance', { storeId: request.storeId });" + String.fromCharCode(10);
    const m2 = without.replace(authLine, authLine + claimBlock);
    expect(gatesBeforeClaim(m2), 'mutant: claim before the status check').not.toBeNull();
  });
});

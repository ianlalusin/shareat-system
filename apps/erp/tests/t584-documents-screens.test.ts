import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentDoc } from '../src/components/documents/DocumentDoc';
import { legacyBodyToDoc } from '@shareat/domain/documents/doc';
import { capabilityForRoute, capabilitiesForRoute } from '../src/lib/route-capability';

/**
 * T-584 - the /documents screens, as source-shape guards plus the route gate and a real render of the body (docs/tasks/584-documents.md s6, s7, s8 tests 2 and 8).
 * Real renders of the pages are checked by the lane in the browser; these hold the parts a refactor could silently break.
 */
const ROOT = join(__dirname, '..', '..', '..');
const DOCS = join(ROOT, 'apps/erp/src/app/documents');
const read = (rel: string): string => readFileSync(join(DOCS, rel), 'utf8');
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('T-584 route gates (test 2: by URL, not only by a hidden link)', () => {
  it('the register and a document need view_documents; issuing needs issue_documents; each sub-path inherits [kills: staff opening /documents by URL]', () => {
    expect(capabilitiesForRoute('/documents')).toEqual(['view_documents']);
    expect(capabilitiesForRoute('/documents/0198a8f0-0000-7000-8000-000000000000')).toEqual(['view_documents']);
    expect(capabilitiesForRoute('/documents/0198a8f0-0000-7000-8000-000000000000/print')).toEqual(['view_documents']);
    expect(capabilitiesForRoute('/documents/new')).toEqual(['issue_documents']);
  });

  it('every page of the family calls requirePageAccess with its own literal path, so a hidden link is never the only gate [kills: an ungated print page]', () => {
    expect(code('page.tsx')).toMatch(/requirePageAccess\(\s*'\/documents'/);
    expect(code('new/page.tsx')).toMatch(/requirePageAccess\(\s*'\/documents\/new'/);
    expect(code('[id]/page.tsx')).toMatch(/requirePageAccess\(\s*`\/documents\/\$\{id\}`/);
    expect(code('[id]/print/page.tsx')).toMatch(/requirePageAccess\(\s*`\/documents\/\$\{id\}\/print`/);
    expect(code('signature/[signatureId]/route.ts')).toMatch(/requireActor\(/);
  });

  it('/documents/templates is the admin capability alone; its sub-paths inherit it [kills: a manager reading the template library]', () => {
    expect(capabilitiesForRoute('/documents/templates')).toEqual(['manage_document_templates']);
    expect(capabilityForRoute('/documents/templates/anything')).toBe('manage_document_templates');
  });

  it('the neighbours did not move: /settings stays manage_store_settings', () => {
    expect(capabilityForRoute('/settings')).toBe('manage_store_settings');
  });
});

describe('T-584 templates screen - files and wiring', () => {
  it('page, actions, typed-forms and lib exist', () => {
    for (const f of ['templates/page.tsx', 'templates/actions.ts', 'templates/typed-forms.ts', 'lib.ts']) expect(existsSync(join(DOCS, f)), f).toBe(true);
  });

  it('the page is read-gated by requirePageAccess on its own literal path, and the actions by requireActor [kills: an ungated URL]', () => {
    expect(code('templates/page.tsx')).toMatch(/requirePageAccess\(\s*['"]\/documents\/templates['"]/);
    const a = code('templates/actions.ts');
    expect(a).toMatch(/['"]use server['"]/);
    expect(a).toMatch(/requireActor\(\s*['"]\/documents\/templates['"]/);
    expect(a).toMatch(/\bsaveDocumentTemplate\b/);
    expect(a).toMatch(/\bretireDocumentTemplate\b/);
    expect(a).toMatch(/errorMessage\(/);
    expect(a).toMatch(/keepTyping\(/);
  });

  it('the action re-implements no rule: no merge-field list, no length bound, no direct database import [kills: a second copy of the whitelist]', () => {
    const a = code('templates/actions.ts');
    expect(a).not.toMatch(/employee\.full_name|50[_,]?000|unknownFields|MERGE_FIELDS/);
    expect(a).not.toMatch(/from ['"]@shareat\/db['"]/);
  });
});

describe('T-584 rendering safety (s6, test 8)', () => {
  const files = (): string[] => walk(DOCS).filter((f) => /\.(tsx?|ts)$/.test(f));

  it('no documents file uses dangerouslySetInnerHTML or sets innerHTML [kills: an XSS door in a screen that prints other people\'s words]', () => {
    for (const f of files()) {
      const src = readFileSync(f, 'utf8');
      expect(src, relative(DOCS, f)).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
    }
  });

  it('<script> and an <img onerror> in a body print as literal text, escaped, with no tag in the output [kills: an XSS door]', () => {
    // The old markup is converted to a document (T-637) and drawn by the one renderer.
    const body = ['# <b>Title</b>', '', '<script>alert(1)</script> and **<img src=x onerror=alert(1)>**'].join('\n');
    const html = renderToStaticMarkup(createElement(DocumentDoc, { doc: legacyBodyToDoc(body) }));
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong>');
    expect(html).toContain('<h2');
  });

  it('a newline inside a paragraph stays a line break and a blank line starts a new paragraph [kills: a letter that runs together]', () => {
    const html = renderToStaticMarkup(createElement(DocumentDoc, { doc: legacyBodyToDoc(['Line one', 'Line two', '', 'Second paragraph'].join('\n')) }));
    expect(html.match(/<p/g)).toHaveLength(2);
    expect(html).toContain('Line one<br/>Line two');
  });
});

describe('T-584 issue, sign, revise, void screens - wiring', () => {
  it('the actions go through the domain and keep typing only where no PIN is involved [kills: a PIN echoed back after a refusal]', () => {
    const a = code('actions.ts');
    expect(a).toMatch(/['"]use server['"]/);
    for (const fn of ['issueDocument', 'reviseDocument', 'signDocument', 'voidDocument']) expect(a, fn).toMatch(new RegExp(`\\b${fn}\\b`));
    expect(a).toMatch(/keepTyping\(fd, DOCUMENT_ISSUE/);
    expect(a).toMatch(/keepTyping\(fd, DOCUMENT_REVISE/);
    const sign = a.slice(a.indexOf('export async function signDocumentAction'), a.indexOf('export async function voidDocumentAction'));
    expect(sign).not.toMatch(/keepTyping|typed:/);
    expect(a).toMatch(/loadDestructiveTarget\(actor, 'issued_document'/);
    expect(a).toMatch(/retypeMatches\(/);
  });

  it('the void action takes the number to retype from the database, never from the form [kills: a confirmation the browser decides]', () => {
    const a = code('actions.ts');
    expect(a).toMatch(/retypeMatches\(str\(fd, 'confirmName'\), target\.name/);
    expect(a).not.toMatch(/get\('(approved|confirmed|pinOk|verified)'\)/);
  });

  it('the sign form is a CheckedForm on the shared rules, with a password PIN field that is never given a value [kills: a PIN rendered into the page]', () => {
    const p = code('[id]/page.tsx');
    expect(p).toMatch(/<CheckedForm rules=\{DOCUMENT_SIGN_RULES\}/);
    expect(p).toMatch(/type="password"/);
    expect(p).not.toMatch(/type="password"[^>]*(defaultValue|value)=/);
  });

  it('the document page answers a missing document and a permission refusal with the same 404, as the print page does [kills: telling a stranger the document exists]', () => {
    const p = code('[id]/page.tsx');
    expect(p).toMatch(/AuthorizationError[\s\S]{0,80}return null/);
    expect(p).not.toMatch(/refused|userMessage/);
  });

  it('the revise and void reasons are limited by the shared rule set on the screen, and the void form is a CheckedForm [kills: a 500-character cap that only the server knew]', () => {
    const p = code('[id]/page.tsx');
    expect(p.match(/nativeAttrs\(DOCUMENT_REASON_RULES\.reason\)/g)).toHaveLength(2);
    expect(p).toMatch(/rules=\{DOCUMENT_REASON_RULES\}\s+action=\{voidDocumentAction\}/);
    expect(p).toMatch(/rules=\{DOCUMENT_REASON_RULES\}\s+typed=/);
  });

  it('the print page is A4, hides the navigation on paper, and prints VOID on a void document [kills: a print that looks live]', () => {
    const p = code('[id]/print/page.tsx');
    // T-637: the A4 rule, the margins, the header/footer and the page breaks live in the shared sheet (DocumentDoc), which t637-document-render.test.ts reads.
    expect(p).toMatch(/<DocumentSheet /);
    expect(p).toMatch(/no-print/);
    expect(p).toMatch(/VOID/);
    expect(p).toMatch(/Version \{data\.versionNo\} of \{data\.number\}/);
  });

  it('the signature route answers one uniform 404 for a refusal and serves bytes with no-store [kills: a route that tells a stranger a signature exists]', () => {
    const r = code('signature/[signatureId]/route.ts');
    expect(r).toMatch(/AuthorizationError/);
    expect(r).toMatch(/unavailable\(\)/);
    expect(r).toMatch(/no-store/);
    expect(r).not.toMatch(/Location/);
  });
});

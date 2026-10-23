import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * T-441 S7 - the upload guard (source-reading; this repo has no jsdom). docs/tasks/441-photo-upload-control.md S7.
 *
 * Four rules over every .ts/.tsx file under apps/erp/src. Each rule is a pure function over { path, text } pairs, so the
 * planted-violation cases below prove each rule goes red on a violation before the real scan is trusted.
 */
const root = join(__dirname, '..', '..', '..');
const SRC = join(root, 'apps', 'erp', 'src');
const UPLOAD_DIR = 'apps/erp/src/components/upload/';

type Source = { path: string; text: string };

function walk(dir: string, out: Source[]): Source[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    out.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
  }
  return out;
}

const inUpload = (path: string) => path.startsWith(UPLOAD_DIR);

/** Rule 1: type="file" appears nowhere outside components/upload/. */
export function rawFileInputViolations(files: Source[]): string[] {
  return files
    .filter((f) => !inUpload(f.path))
    .filter((f) => /type\s*=\s*\{?\s*["'`]file["'`]\s*\}?/.test(f.text))
    .map((f) => f.path);
}

/** Rule 2: nothing imports PhotoInput (any module path ending in /PhotoInput). */
export function photoInputImportViolations(files: Source[]): string[] {
  const importing = /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()\s*["'][^"'\n]*\/PhotoInput["']/;
  return files.filter((f) => importing.test(f.text)).map((f) => f.path);
}

/** Rule 3: no <img> whose src points at /files/ outside components/upload/. */
export function filesImgViolations(files: Source[]): string[] {
  const hits = (text: string) => {
    const tags: string[] = [];
    for (const m of text.matchAll(/<img\b/g)) {
      const start = m.index ?? 0;
      const end = text.indexOf('>', start);
      tags.push(text.slice(start, end === -1 ? undefined : end + 1));
    }
    return tags.some((tag) => /\bsrc\s*=\s*\{?\s*[`"'][^`"']*\/files\//.test(tag));
  };
  return files.filter((f) => !inUpload(f.path)).filter((f) => hits(f.text)).map((f) => f.path);
}

/**
 * Rule 4: a server-action file ('use server' at the top) that reads a posted File (formData.get(...) narrowed with
 * instanceof File / as File, or any .arrayBuffer() call) must CALL resolveUploadedFile(, filePart( or pass a
 * { contentType, bytes } object literal into a call. A bare mention of the helper name does not count.
 */
export function unguardedServerFileReadViolations(files: Source[]): string[] {
  return files
    .filter((f) => /^\s*['"]use server['"]/.test(f.text))
    .filter((f) => {
      const readsFile =
        (/formData\.get\(/.test(f.text) && /instanceof\s+File\b|\bas\s+File\b/.test(f.text)) || /\.arrayBuffer\(\)/.test(f.text);
      return readsFile;
    })
    .filter((f) => {
      const guarded =
        /\b(filePart|resolveUploadedFile)\s*\(/.test(f.text) || /\{[^{}]*\bcontentType\s*[:,][^{}]*\bbytes\b[^{}]*\}/.test(f.text);
      return !guarded;
    })
    .map((f) => f.path);
}

const real = walk(SRC, []);

describe('T-441 S7 upload guard over the real apps/erp/src tree', () => {
  it('scanned a real source tree (the guard is not vacuous)', () => {
    expect(real.length).toBeGreaterThan(100);
  });

  it('1. type="file" appears only under components/upload/', () => {
    expect(rawFileInputViolations(real)).toEqual([]);
  });

  it('2. nothing imports PhotoInput', () => {
    expect(photoInputImportViolations(real)).toEqual([]);
  });

  it('3. no <img> with a /files/ src outside components/upload/', () => {
    expect(filesImgViolations(real)).toEqual([]);
  });

  it('4. server actions that read a posted File use resolveUploadedFile, filePart or { contentType, bytes }', () => {
    expect(unguardedServerFileReadViolations(real)).toEqual([]);
  });
});

describe('each rule goes red on a planted violation (in memory, no files on disk)', () => {
  const page = (text: string) => ({ path: 'apps/erp/src/app/demo/page.tsx', text });
  const upload = (text: string) => ({ path: `${UPLOAD_DIR}PhotoUpload.tsx`, text });

  it('rule 1 reports a raw file input and ignores the one inside components/upload/', () => {
    expect(rawFileInputViolations([page('<input type="file" name="x" />')])).toEqual(['apps/erp/src/app/demo/page.tsx']);
    expect(rawFileInputViolations([page('<input type={"file"} />')])).toHaveLength(1);
    expect(rawFileInputViolations([upload('<input type="file" />')])).toEqual([]);
    expect(rawFileInputViolations([page('<input type="text" />')])).toEqual([]);
  });

  it('rule 2 reports an import of PhotoInput and ignores other imports', () => {
    expect(photoInputImportViolations([page("import { PhotoInput } from '@/components/PhotoInput';")])).toHaveLength(1);
    expect(photoInputImportViolations([page('const m = await import("../components/PhotoInput");')])).toHaveLength(1);
    expect(photoInputImportViolations([page("import { PhotoUpload } from '@/components/upload/PhotoUpload';")])).toEqual([]);
  });

  it('rule 3 reports an <img> with a /files/ src, including multi-line tags, and ignores the upload folder', () => {
    expect(filesImgViolations([page('<img src={`/files/${id}`} alt="" />')])).toHaveLength(1);
    expect(filesImgViolations([page('<img\n  className="x"\n  src="/files/abc"\n/>')])).toHaveLength(1);
    expect(filesImgViolations([upload('<img src={`/files/${id}`} alt="" />')])).toEqual([]);
    expect(filesImgViolations([page('<img src="/logo.png" alt="" />')])).toEqual([]);
  });

  it('rule 4 reports a server action that reads a File with no helper, and passes the guarded forms', () => {
    const bare = "'use server';\nexport async function save(formData: FormData) {\n  const f = formData.get('photo');\n  if (f instanceof File) await store(f);\n}\n";
    expect(unguardedServerFileReadViolations([page(bare)])).toEqual(['apps/erp/src/app/demo/page.tsx']);
    const viaHelper = bare.replace("const f = formData.get('photo');", "const f = await resolveUploadedFile(tx, actor, formData, 'photo', opts);");
    expect(unguardedServerFileReadViolations([page(viaHelper)])).toEqual([]);
    const viaPart = bare.replace("const f = formData.get('photo');", "const f = await filePart(formData, 'photo');");
    expect(unguardedServerFileReadViolations([page(viaPart)])).toEqual([]);
    const viaDomain = bare.replace('await store(f);', 'await save2({ contentType: f.type, bytes: new Uint8Array() });');
    expect(unguardedServerFileReadViolations([page(viaDomain)])).toEqual([]);
    expect(unguardedServerFileReadViolations([page(bare.replace("'use server';", "// not an action"))])).toEqual([]);
  });

  it('rule 4 reports a File read that only mentions filePart in a comment, and an arrayBuffer read with no safe path', () => {
    const commentOnly = "'use server';\nexport async function save(formData: FormData) {\n  // filePart is the helper we should use\n  const f = formData.get('x');\n  if (f instanceof File) await store(f);\n}\n";
    expect(unguardedServerFileReadViolations([page(commentOnly)])).toEqual(['apps/erp/src/app/demo/page.tsx']);
    const buffer = "'use server';\nexport async function up(formData: FormData) {\n  const f = formData.get('x') as Blob;\n  const buf = await f.arrayBuffer();\n  await store(buf);\n}\n";
    expect(unguardedServerFileReadViolations([page(buffer)])).toEqual(['apps/erp/src/app/demo/page.tsx']);
  });
});

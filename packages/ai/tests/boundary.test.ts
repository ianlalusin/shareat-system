import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-640: `packages/ai` is the ONLY code that calls a model, over plain `fetch` through one injectable client, with no provider SDK (so no new dependency or lockfile entry).
 * A static read of the tree: the provider hosts appear only in the adapters, `fetch(` only in http.ts, no SDK import anywhere, and no test file reaches the real client.
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
const sources = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'scripts'))].filter((f) => !/\.test\.tsx?$/.test(f) && !rel(f).includes('/tests/'));
const HOSTS = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;

describe('T-640 the AI package is the only door to a model', () => {
  it('a provider host appears only in packages/ai/src/adapters [kills: a second caller of a provider]', () => {
    const outside = sources.filter((f) => HOSTS.test(readFileSync(f, 'utf8')) && !rel(f).startsWith('packages/ai/src/adapters/'));
    expect(outside.map(rel)).toEqual([]);
  });

  it('`fetch(` appears in packages/ai only in http.ts, so every call goes through the injectable client [kills: an adapter that bypasses the fake in tests]', () => {
    const hits = sources.filter((f) => rel(f).startsWith('packages/ai/src/') && /(^|[^A-Za-z0-9_.])fetch\(/.test(readFileSync(f, 'utf8')));
    expect(hits.map(rel)).toEqual(['packages/ai/src/http.ts']);
  });

  it('no provider SDK is imported anywhere, and packages/ai declares no dependency [kills: an SDK pulled in without a licence check and a lockfile entry]', () => {
    const sdk = /from\s+['"](?:openai|@anthropic-ai\/[^'"]*|@google\/generative-ai|@google\/genai|@ai-sdk\/[^'"]*|ai)['"]/;
    expect(sources.filter((f) => sdk.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'ai', 'package.json'), 'utf8')) as { dependencies?: object };
    expect(pkg.dependencies).toBeUndefined();
  });

  it('no test reaches the real network client [kills: a CI run that calls a provider]', () => {
    const testFiles = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'tests'))].filter((f) => /t640|packages\/ai\/tests/.test(rel(f)) && /\.test\.tsx?$/.test(f) && !rel(f).endsWith('packages/ai/tests/boundary.test.ts'));
    expect(testFiles.length).toBeGreaterThan(3);
    expect(testFiles.filter((f) => /fetchHttpClient/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  it('the privacy guard sits in front of both callers: the real call and the Test call both run through `guarded` [kills: a path that skips the guard]', () => {
    for (const f of ['packages/domain/src/ai/call.ts', 'packages/domain/src/ai/test-model.ts']) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      const at = text.indexOf('guarded(');
      const call = text.indexOf('.chat(');
      expect(at, `${f} calls guarded(`).toBeGreaterThan(-1);
      expect(call, `${f} calls an adapter`).toBeGreaterThan(at);
    }
  });
});

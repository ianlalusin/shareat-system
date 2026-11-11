import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T-567: the hours a menu price follows are called "Menu hours" on screen, never "Lunch and dinner hours".
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const BANNED = ['Lunch and dinner hours', 'lunch or dinner hours'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('T-567: menu hours wording', () => {
  it('no screen text under apps/erp/src says "Lunch and dinner hours" (app/pos excluded)', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel.startsWith('app/pos/')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const phrase of BANNED) if (line.includes(phrase)) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

/**
 * T-387 S3 — the kit's file inventory and the server-safe rules (Guards 7 to 10) over the NEW files.
 *
 * `ui-token-discipline.test.ts` globs `components/ui/*.tsx` (readdirSync, `.endsWith('.tsx')`), so every new
 * component is covered by Guards 7 to 10 automatically. It does NOT cover `.ts` files, so `status-tone.ts` is
 * checked here. This file also proves the glob would pick the new files up (they are present as `.tsx`) and that the
 * barrel exports them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, '..', 'src', 'components', 'ui');
const NEW_TSX = ['Badge', 'Banner', 'FlashBanner', 'Select', 'Textarea', 'Checkbox', 'Table', 'EmptyState', 'StatusIcon'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the S3 kit files exist where the token-discipline glob will find them', () => {
  const globbed = readdirSync(UI).filter((f) => f.endsWith('.tsx'));
  it.each(NEW_TSX)('%s.tsx is in components/ui and inside the Guards 7-10 glob', (name) => {
    expect(existsSync(path.join(UI, `${name}.tsx`))).toBe(true);
    expect(globbed).toContain(`${name}.tsx`);
  });
  it('status-tone.ts exists (the table and the two lookups)', () => {
    expect(existsSync(path.join(UI, 'status-tone.ts'))).toBe(true);
  });
});

describe('the barrel exports the S3 kit', () => {
  const barrel = existsSync(path.join(UI, 'index.ts')) ? readFileSync(path.join(UI, 'index.ts'), 'utf8') : '';
  it.each(['Badge', 'Banner', 'FlashBanner', 'Select', 'Textarea', 'Checkbox', 'Table', 'Th', 'Td', 'NumTd', 'EmptyState', 'StatusIcon', 'statusTone', 'statusLabel'])(
    '%s is exported from @/components/ui',
    (name) => {
      expect(strip(barrel)).toMatch(new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b`));
    },
  );
});

describe('server-safe, token-only (L4): every new file in components/ui', () => {
  const files = [...NEW_TSX.map((n) => `${n}.tsx`), 'status-tone.ts'].filter((f) => existsSync(path.join(UI, f)));
  it('found the files to check (a glob matching nothing passes every guard vacuously)', () => {
    expect(files.length).toBe(NEW_TSX.length + 1);
  });
  it.each([...NEW_TSX.map((n) => `${n}.tsx`), 'status-tone.ts'])('%s', (f) => {
    const p = path.join(UI, f);
    expect(existsSync(p), f).toBe(true);
    const src = strip(readFileSync(p, 'utf8'));
    expect(src, 'no "use client"').not.toMatch(/['"]use client['"]/);
    expect(src, 'no hooks').not.toMatch(/\buse(?:State|Effect|Ref|Memo|Callback|Reducer|Context|Id|Transition|FormStatus|FormState|Optimistic)\b/);
    expect(src, 'no stock hue utility').not.toMatch(/\b(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/);
    expect(src, 'no raw hex').not.toMatch(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
    expect(src, 'no text-warning (warning is a fill; text is warning-ink)').not.toMatch(/\btext-warning(?!-ink)\b/);
    expect(src, 'no solid bg-danger (soft is bg-danger-surface)').not.toMatch(/\bbg-danger(?![\w-])/);
    expect(src, 'no dark:*-danger (the theme swaps the token)').not.toMatch(/dark:[\w-]*danger/);
    expect(src, 'no #f87171').not.toMatch(/f87171/i);
  });
  it('FlashBanner imports the Flash type with `import type` only (the flash module pulls next/headers into every render)', () => {
    const p = path.join(UI, 'FlashBanner.tsx');
    expect(existsSync(p)).toBe(true);
    const src = strip(readFileSync(p, 'utf8'));
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+['"]([^'"]+)['"]/gm)) {
      expect(m[1], 'value import').not.toMatch(/lib\/flash|next\/headers|next\/navigation/);
    }
  });
});

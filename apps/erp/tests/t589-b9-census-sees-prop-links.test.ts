/**
 * T-589 B9 — the touch-target census must see a link passed as JSX in a Page `crumb` / `description`
 * prop (inline, or via a hoisted const), measure the crumb like any control, and record a link inside
 * a description SENTENCE as `inline-exempt` (WCAG 2.5.8) instead of leaving it UNRESOLVED.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCensus } from './touch-target-geometry';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const realCss = join(srcRoot, 'app', 'globals.css');

let tmpRoot: string;
let fixture: ReturnType<typeof runCensus>['results'];

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 't589-b9-'));
  mkdirSync(join(tmpRoot, 'app', 'fake'), { recursive: true });
  writeFileSync(join(tmpRoot, 'app', 'globals.css'), '');
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'page.tsx'),
    [
      "import Link from 'next/link';",
      "const NAV_LINK = 'inline-flex min-h-11 items-center';",
      'const HOISTED = (<>Hoisted text with <Link href="/c">c</Link> inside.</>);',
      'export default function P() {',
      '  return (',
      '    <>',
      '      <Page density="table" title="X" crumb={<Link href="/a" className={NAV_LINK}>A</Link>} description={<>Text with <Link href="/b">b</Link> inside.</>}>x</Page>',
      '      <Page density="table" title="Y" description={HOISTED}>y</Page>',
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );
  fixture = runCensus(tmpRoot, join(tmpRoot, 'app', 'globals.css')).results;
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('T-589 B9 — links in Page props', () => {
  it('the crumb link is a candidate, measured as a standalone control (PASS 44)', () => {
    expect(fixture.find((r) => r.line === 7 && r.tag === 'Link' && r.status === 'pass')).toMatchObject({ px: 44 });
  });

  it('a sentence link in an inline description is inline-exempt', () => {
    const hits = fixture.filter((r) => r.line === 7 && r.status === 'inline-exempt');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: 'inline link in a sentence (WCAG 2.5.8 exemption)' });
  });

  it('a sentence link in a hoisted description const is inline-exempt', () => {
    expect(fixture.filter((r) => r.line === 3 && r.status === 'inline-exempt')).toHaveLength(1);
  });

  it('on the real tree: settings/organization -> /admin/stores and settings/attendance -> /payroll are inline-exempt', () => {
    const real = runCensus(srcRoot, realCss).results;
    for (const file of ['app/settings/organization/page.tsx', 'app/settings/attendance/page.tsx']) {
      const exempt = real.filter((r) => r.file === file && r.status === 'inline-exempt');
      expect(exempt, file).toHaveLength(1);
    }
    // and the Settings crumb links stay measured, not exempt
    for (const file of ['app/settings/organization/page.tsx', 'app/settings/attendance/page.tsx']) {
      expect(real.some((r) => r.file === file && r.tag === 'a' && r.status === 'pass' && r.px === 44), file).toBe(true);
    }
  });
});

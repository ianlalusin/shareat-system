/**
 * T-348 S2a / DEF-474 Amendment A2 — the action-link resolver must learn that `<PageDescription>`
 * supplies `text-sm` (bible §6.3's own "state your own opaque-set" pattern, applied to a new
 * ancestor-font-size table, NOT `OPAQUE_COMPONENTS` — `<PageDescription>` is not foreign, its box
 * is fully knowable, just not from its own call-site className any more).
 *
 * `resolveAncestorFontSize` walks JSX `.parent` within ONE file; a `<Link>` inside
 * `<PageDescription>…</PageDescription>` used to lose `text-sm` because that class now lives inside
 * `PageDescription.tsx`'s own render, invisible from the call site — measured in S1's temporary
 * wiring, `money-accounts/page.tsx` went 1 FAIL -> 1 UNRESOLVED (task doc, Amendment A2).
 *
 * All legs use a locally-defined stub (no import) — the fix this task expects is a tag-name table
 * keyed the same way as `OPAQUE_COMPONENTS` (§6.3), not an import-origin gate like
 * `KNOWN_COMPONENT_HEIGHT_PX`'s `@/components/ui` check — so a same-named local stub must trigger
 * the identical resolver branch as the real component. R3's `Foo` stub is byte-identical to the
 * `PageDescription` stub bar the name (`stub(name)` below) — the only variable is the tag name.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCensus } from './touch-target-geometry';

let tmpRoot: string;
let globalsCssPath: string;
let results: ReturnType<typeof runCensus>['results'];

function stub(name: string): string {
  return `function ${name}({ children, className }: { children: React.ReactNode; className?: string }) { return <p className={className}>{children}</p>; }\n`;
}
const PAGE_DESCRIPTION_STUB = stub('PageDescription');

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'touch-target-page-description-'));
  globalsCssPath = join(tmpRoot, 'app', 'globals.css');
  mkdirSync(join(tmpRoot, 'app'), { recursive: true });
  writeFileSync(globalsCssPath, '');

  // R1 — bare <PageDescription>, no className: must resolve text-sm, not UNRESOLVED.
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r1'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r1', 'page.tsx'),
    `import Link from 'next/link';\n${PAGE_DESCRIPTION_STUB}export default function Page() {\n  return (\n    <PageDescription>\n      <Link href="/somewhere">Somewhere</Link>\n    </PageDescription>\n  );\n}\n`,
  );

  // R2 — positive control: the same Link inside a plain <p className="text-sm ...">, no
  // PageDescription involved at all. Must be green TODAY — proves the harness itself is sound.
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r2'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r2', 'page.tsx'),
    `import Link from 'next/link';\nexport default function Page() {\n  return (\n    <p className="text-sm text-neutral-600">\n      <Link href="/somewhere">Somewhere</Link>\n    </p>\n  );\n}\n`,
  );

  // R3 — negative control: an unknown capitalised ancestor, its stub body byte-identical to
  // PageDescription's (only the name differs). Must stay UNRESOLVED both today and after the fix
  // — proves the remedy is a named table entry, not a blanket "any component" default.
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r3'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r3', 'page.tsx'),
    `import Link from 'next/link';\n${stub('Foo')}export default function Page() {\n  return (\n    <Foo>\n      <Link href="/somewhere">Somewhere</Link>\n    </Foo>\n  );\n}\n`,
  );

  // R4 — a className on <PageDescription> itself (e.g. "mt-1", the one carried-over token per S2
  // item 1) must not stop R1 resolving.
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r4'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r4', 'page.tsx'),
    `import Link from 'next/link';\n${PAGE_DESCRIPTION_STUB}export default function Page() {\n  return (\n    <PageDescription className="mt-1">\n      <Link href="/somewhere">Somewhere</Link>\n    </PageDescription>\n  );\n}\n`,
  );

  // R5 — an explicit text-* on <PageDescription> itself must win over the table default: the
  // component appends the passed className LAST, so a caller-supplied size overrides its own
  // internal text-sm the way the browser renders it. Proves the fix checks PageDescription's own
  // className before falling back to the table, not an unconditional "PageDescription -> sm".
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r5'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r5', 'page.tsx'),
    `import Link from 'next/link';\n${PAGE_DESCRIPTION_STUB}export default function Page() {\n  return (\n    <PageDescription className="text-base">\n      <Link href="/somewhere">Somewhere</Link>\n    </PageDescription>\n  );\n}\n`,
  );

  // R6 — a DYNAMIC className on <PageDescription> itself (e.g. `className={getClass()}`, not a
  // string literal or a resolvable local const) must stay UNRESOLVED, not fall back to the table
  // default: an opaque expression could carry its own text-* override the scanner cannot see, so
  // guessing "sm" would be exactly the silent wrong answer §6.1's fail-closed rule exists to avoid.
  mkdirSync(join(tmpRoot, 'app', 'fake', 'r6'), { recursive: true });
  writeFileSync(
    join(tmpRoot, 'app', 'fake', 'r6', 'page.tsx'),
    `import Link from 'next/link';\n${PAGE_DESCRIPTION_STUB}export default function Page() {\n  return (\n    <PageDescription className={getClass()}>\n      <Link href="/somewhere">Somewhere</Link>\n    </PageDescription>\n  );\n}\n`,
  );

  results = runCensus(tmpRoot, globalsCssPath).results;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function linkResult(rel: string) {
  return results.find((r) => r.file === rel && r.tag === 'Link');
}

describe('T-348 S2a / Amendment A2 — resolver learns PageDescription supplies text-sm', () => {
  it('R1: a bare <PageDescription> ancestor resolves its <Link> to text-sm (20px), not UNRESOLVED', () => {
    const hit = linkResult('app/fake/r1/page.tsx');
    expect(hit, `expected a Link candidate in r1/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 20 });
  });

  it('R2 (positive control, green today): the same Link under a real text-sm <p> resolves to 20px', () => {
    const hit = linkResult('app/fake/r2/page.tsx');
    expect(hit, `expected a Link candidate in r2/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 20 });
  });

  it('R3 (negative control, green today and after): an unknown ancestor component stays UNRESOLVED', () => {
    const hit = linkResult('app/fake/r3/page.tsx');
    expect(hit, `expected a Link candidate in r3/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit?.status).toBe('unresolved');
  });

  it('R4: a className on <PageDescription> itself (e.g. mt-1) does not stop R1 resolving', () => {
    const hit = linkResult('app/fake/r4/page.tsx');
    expect(hit, `expected a Link candidate in r4/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 20 });
  });

  it('R5: an explicit text-base on <PageDescription> itself overrides the table default (24px, PASS)', () => {
    const hit = linkResult('app/fake/r5/page.tsx');
    expect(hit, `expected a Link candidate in r5/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit).toMatchObject({ status: 'pass', px: 24 });
  });

  it('R6 (green today, pins the behaviour): a dynamic className on <PageDescription> stays UNRESOLVED, never guesses the table default', () => {
    const hit = linkResult('app/fake/r6/page.tsx');
    expect(hit, `expected a Link candidate in r6/page.tsx; got ${JSON.stringify(hit)}`).toBeDefined();
    expect(hit?.status).toBe('unresolved');
  });
});

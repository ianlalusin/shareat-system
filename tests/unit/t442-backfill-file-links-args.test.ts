import { describe, expect, it } from 'vitest';

/**
 * T-442 S1 TESTER - M10 (script args), docs/tasks/442-receipt-photo-link-backfill.md section 3 "Script" + audit A10.
 *
 * ASSUMED CONTRACT: `scripts/backfill-file-links.ts` exports `parseArgs(argv: readonly string[])` and does NOT run
 * `main()` on import (guard it like `scripts/master-data.ts:293`, an is-main check) - otherwise importing it here would
 * touch the database. Returns `{ confirm: boolean; check: boolean; org: string | null | undefined }`; an unknown argument
 * or a malformed `--org=` THROWS (the script's main turns a throw into exit 1).
 *
 * RED reason before the build: scripts/backfill-file-links.ts does not exist.
 */
type Parsed = { confirm?: boolean; check?: boolean; org?: string | null };
async function load(): Promise<(argv: readonly string[]) => Parsed> {
  const loaders = import.meta.glob('../../scripts/backfill-file-links.ts') as Record<string, () => Promise<{ parseArgs?: unknown }>>;
  const load = Object.values(loaders)[0];
  if (!load) throw new Error('import fails: scripts/backfill-file-links.ts does not exist yet');
  const mod = await load();
  if (typeof mod.parseArgs !== 'function') throw new Error('scripts/backfill-file-links.ts must export parseArgs (and not run main on import)');
  return mod.parseArgs as never;
}

const ORG = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('backfill-file-links parseArgs (M10)', () => {
  it('no args = a dry run: confirm false, check false, no org filter', async () => {
    const p = (await load())([]);
    expect(p.confirm).toBe(false);
    expect(p.check).toBeFalsy();
    expect(p.org ?? null).toBeNull();
  });

  it('--confirm turns writing on', async () => {
    expect((await load())(['--confirm']).confirm).toBe(true);
  });

  it('--check is the read-only census flag and does not turn writing on', async () => {
    const p = (await load())(['--check']);
    expect(p.check).toBe(true);
    expect(p.confirm).toBe(false);
  });

  it('--org=<uuid> is accepted and carried through', async () => {
    const p = (await load())(['--confirm', `--org=${ORG}`]);
    expect(p.org).toBe(ORG);
  });

  it('an unknown argument is refused, not ignored (a --confrim typo must not run as a dry run)', async () => {
    const parse = await load();
    expect(() => parse(['--confrim'])).toThrow();
    expect(() => parse(['--confirm', 'extra'])).toThrow();
    expect(() => parse(['--check', '--confirm'])).toThrow(); // --check is read-only; combining it with --confirm is refused
  });

  it('A10: --org= must be a uuid; empty or malformed is refused', async () => {
    const parse = await load();
    expect(() => parse(['--org=nope'])).toThrow();
    expect(() => parse(['--org='])).toThrow();
    expect(() => parse([`--org=${ORG}x`])).toThrow();
  });
});

/**
 * T-398 S7e (TESTER) - O10: `provision-terminal --org` (B12, K8). docs/tasks/398-s7/S7-REFRESH.md s6 (clock terminal), s11 (O10).
 * scripts/provision-terminal.ts:105-110 looks a store up by CODE ALONE with `limit 1`; with two companies that share a store code it silently picks one.
 * Real Postgres via TEST_DATABASE_URL (the script is spawned with DATABASE_URL = SYSTEM_DATABASE_URL = TEST_DATABASE_URL, a superuser, so it passes
 * its own rolbypassrls guard). Every run is a DRY RUN (no --confirm): the plan names the store it resolved, nothing is written; row counts are
 * asserted unchanged. The script's flags use the `--key=value` form, so `--org=<uuid>`.
 *
 * STATUS TODAY: RED on the ambiguity legs (the script picks one store and prints a plan, exit 0) and on the --org leg (`--org` is "unrecognised
 * argument"). GREEN-AS-GUARD: the single-company control (a code held by one company still resolves with no --org), and the unchanged refusals.
 *
 * MUTANTS: `limit 1` kept without --org; --org parsed but ignored in the lookup; --org matched on name; refusal leaking the other company's store name;
 * --org validated as a uuid not at all (a bad value falls through to the code-only lookup).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const script = join(repoRoot, 'scripts', 'provision-terminal.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();

async function world() {
  const t = tag();
  const shared = `SH${t}`.slice(0, 12); // the store code both companies use
  const solo = `SO${t}`.slice(0, 12); // a code only company A uses
  const orgA = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`S7E Org A ${t}`}, ${`s7ea-${t}`}) returning id`)[0]!.id;
  const orgB = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`S7E Org B ${t}`}, ${`s7eb-${t}`}) returning id`)[0]!.id;
  const nameA = `Alpha Store ${t}`;
  const nameB = `Bravo Store ${t}`;
  const storeA = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA}, ${shared}, ${nameA}) returning id`)[0]!.id;
  const storeB = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgB}, ${shared}, ${nameB}) returning id`)[0]!.id;
  await sql`insert into stores (org_id, code, name) values (${orgA}, ${solo}, ${`Solo Store ${t}`})`;
  return { t, shared, solo, orgA, orgB, nameA, nameB, storeA, storeB };
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, DATABASE_URL: url, SYSTEM_DATABASE_URL: url },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const counts = async () =>
  (await sql<{ p: number; c: number }[]>`select (select count(*) from persons where kind = 'terminal')::int p, (select count(*) from person_credentials)::int c`)[0]!;

describe('O10 - provision-terminal --org', () => {
  it('a code held by TWO companies, no --org: refused, naming the ambiguity and --org; no plan printed; nothing written - Mutant: limit 1 kept', async () => {
    const w = await world();
    const before = await counts();
    const r = run([`--store=${w.shared}`, '--uid=fake-uid-1']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/REFUSED/);
    expect(r.out).toMatch(/--org/);
    expect(r.out).toMatch(/ambiguous|more than one|both|several|two companies|which company/i);
    expect(r.out, 'a refusal must not print a plan for a guessed store').not.toMatch(/firebase uid\s*:/);
    expect(await counts()).toEqual(before);
  });

  it('the ambiguity refusal names neither company\'s store (it cannot say which one it would have picked) - Mutant: the message echoes the first match', async () => {
    const w = await world();
    const r = run([`--store=${w.shared}`, '--uid=fake-uid-2']);
    expect(r.out).not.toContain(w.nameA);
    expect(r.out).not.toContain(w.nameB);
  });

  it('with --org=<B>: resolves B\'s store only (plan names Bravo, never Alpha); dry run writes nothing - Mutant: --org parsed but ignored', async () => {
    const w = await world();
    const before = await counts();
    const r = run([`--store=${w.shared}`, `--org=${w.orgB}`, '--uid=fake-uid-3']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(w.nameB);
    expect(r.out).not.toContain(w.nameA);
    expect(r.out).toMatch(/DRY RUN/);
    expect(await counts()).toEqual(before);
  });

  it('with --org=<A>: resolves A\'s store (the symmetric case, so "always B" or "always the newest" fails)', async () => {
    const w = await world();
    const r = run([`--store=${w.shared}`, `--org=${w.orgA}`, '--uid=fake-uid-4']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(w.nameA);
    expect(r.out).not.toContain(w.nameB);
  });

  it('--org of a company that has no such store code: refused "no store", and it does not fall back to the other company - Mutant: org filter applied only when it finds a row', async () => {
    const w = await world();
    const r = run([`--store=${w.solo}`, `--org=${w.orgB}`, '--uid=fake-uid-5']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/REFUSED: no store/);
    expect(r.out).not.toContain('Solo Store');
  });

  it('--org that is not a uuid is refused before any lookup - Mutant: a bad value falls through to the code-only lookup', async () => {
    const w = await world();
    const r = run([`--store=${w.shared}`, '--org=not-a-uuid', '--uid=fake-uid-6']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/--org/);
    expect(r.out).not.toContain(w.nameA);
    expect(r.out).not.toContain(w.nameB);
  });

  it('control (green today): a code held by ONE company still resolves with no --org - Mutant: --org made mandatory for every store', async () => {
    const w = await world();
    const r = run([`--store=${w.solo}`, '--uid=fake-uid-7']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Solo Store ${w.t}`);
    expect(r.out).toMatch(/DRY RUN/);
  });

  it('control (green today): an unknown code is still "REFUSED: no store with code"', () => {
    const r = run([`--store=NOPE${tag()}`, '--uid=fake-uid-8']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/REFUSED: no store with code/);
  });
});

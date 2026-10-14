/**
 * T-401 S5, I16 (docs/tasks/401-erp-menu-catalog-master.md section 4): a store with NO switch row builds a plan, and writes
 * everything a pull writes, deep-equal to the GOLDEN captured from the code BEFORE S5 (t401-s5-golden-no-switch.json, taken at
 * the branch tip containing S1-S4, no usage-pull.ts edit). GREEN NOW, and it must stay green after the builder's change.
 *
 * Re-capture (never as part of the builder's work): T401_S5_CAPTURE=1 on the pre-S5 code only.
 *
 * Mutants killed: listActiveMaps changed or skipped on the no-switch path; the no-switch path writing a `depletionSource`
 * key anywhere (plan line, pull row, usage record, audit row); the no-switch path resolving a location, quantity or section
 * differently; a switch of ANOTHER store (B) changing store A's output.
 * Finding recorded with the golden: today the usage pull writes NO audit_log row of its own (the JSON's auditRows holds only what the
 * postings write), so "the pull's audit row carries depletionSource only when switched" has nothing to attach to yet (see the report).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { rawSwitch, sql, world } from './t401-s5-setup';
import { runScenario, seedScenario } from './t401-s5-golden-scenario';

const GOLDEN = join(fileURLToPath(new URL('.', import.meta.url)), 't401-s5-golden-no-switch.json');

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('I16 -- an unswitched store is byte-identical to the pre-S5 golden', () => {
  it('plan, stored pull, usage records, stock out and audit rows equal the golden; nothing says depletionSource', async () => {
    const w = await world('golden');
    const day = await seedScenario(w, w.a.storeId, w.a.kitchen, w.a.display!);
    const out = await runScenario(w, w.a.storeId, day, w.a.kitchen, w.a.display!);
    if (process.env.T401_S5_CAPTURE === '1') {
      writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n');
    }
    expect(existsSync(GOLDEN), 'the golden file is committed beside this test').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown;
    expect(out).toEqual(golden);
    expect(JSON.stringify(out)).not.toContain('depletionSource');
  }, 120_000);

  it('a switch on ANOTHER store (B) changes nothing for store A (mutant: the source is read org-wide)', async () => {
    const w = await world('golden-b');
    await rawSwitch(w, w.b.storeId, 'menu_rules', 'B only', 0);
    const day = await seedScenario(w, w.a.storeId, w.a.kitchen, w.a.display!);
    const out = await runScenario(w, w.a.storeId, day, w.a.kitchen, w.a.display!);
    expect(out).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  }, 120_000);
});

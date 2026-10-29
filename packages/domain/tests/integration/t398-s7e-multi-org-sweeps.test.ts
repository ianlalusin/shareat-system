/**
 * T-398 S7e (BUILDER) - O7b: the two daily sweeps with two companies. docs/tasks/398-s7/S7-REFRESH.md s7.
 * `posDayImportSweep` and `usageAutoPostSweep` each run once per company they are given and write a `scheduler_runs` row under THAT company's id,
 * and a run for one company writes nothing for the other.
 *
 * ## Why one run per orgId and not one all-company run
 * With no `orgId` a sweep visits every active organisation in the database. On a shared test database that includes other tests' organisations
 * (some with POS links), so an all-company run would reach into their data (and, for the POS import, their feeds). Running the sweep for each of
 * the two companies by id exercises the same per-company path (`listOrgsToRun(orgId)` -> `runJobForOrg` under that company's principal)
 * without touching anyone else's rows. The all-company enumeration itself (`listOrgsToRun()` with no id) is covered by the scheduler unit tests.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '@shareat/db';
import { usageAutoPostSweep } from '@shareat/domain';
import { posDayImportSweep } from '../../src/pos/day-import-job';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');
const sql = postgres(url, { max: 3 });

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const tag = Date.now().toString(36);
const mkOrg = async (n: string) =>
  (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`S7E sweeps ${n} ${tag}`}, ${`s7e-sw-${n}-${tag}`}) returning id`)[0]!.id;
const runs = (orgId: string, job: string) =>
  sql<{ org_id: string; outcome: string }[]>`select org_id, outcome from scheduler_runs where org_id = ${orgId} and job = ${job}`;

describe('O7b - the daily sweeps with two companies', () => {
  it('each sweep, run for company A and for company B, writes one row under each company and none across', async () => {
    const a = await mkOrg('a');
    const b = await mkOrg('b');
    const now = new Date();

    for (const org of [a, b]) {
      const imp = await posDayImportSweep({ orgId: org, now, trigger: 'manual', fetchers: {} as never });
      expect(imp.outcomes.map((o) => o.orgId)).toEqual([org]);
      const use = await usageAutoPostSweep({ orgId: org, now, trigger: 'manual' });
      expect(use.outcomes).toHaveLength(1);
      expect(use.hadFailures).toBe(false);
    }

    for (const job of ['pos_day_import', 'usage_auto_post']) {
      const ra = await runs(a, job);
      const rb = await runs(b, job);
      expect(ra, `${job}: one row under company A`).toHaveLength(1);
      expect(rb, `${job}: one row under company B`).toHaveLength(1);
      expect(ra[0]!.org_id).toBe(a);
      expect(rb[0]!.org_id).toBe(b);
    }
  });
});

import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createItem } from '@shareat/domain';
import { testItemCode } from '../../packages/domain/tests/integration/_fixtures/item-code';

/**
 * T-386 S6 - `docs/tasks/386-item-code-auto-suggest.md` R12 / S6. TESTER file.
 *
 * The rule S6 adds: `items.code` matches '^[A-Z0-9]{4}-[0-9]{3}$' AND right(code, 3) <> '000' - constraint `items_code_shape_check`.
 *
 * ## State before the migration (red first)
 * No such constraint exists: the raw-insert and raw-update legs of the refused codes SUCCEED (so each fails its "refused on
 * items_code_shape_check" assertion). The shaped-code leg and the domain-sentence leg are controls that pass today.
 *
 * ## Mutants (each named on the leg it turns red)
 * Regex without `^`/`$` anchors -> the 5-digit and 3-letter legs. Drop `right(code,3) <> '000'` -> the '-000' leg. `[A-Z0-9]` -> `[A-Z]`
 * -> the shaped-with-digits control. Lower-case allowed (`[A-Za-z0-9]`) -> the lower-case leg. The CHECK on INSERT only -> every update leg.
 *
 * ## Why the owner connection
 * The owner connection runs the raw statements: the point is the table CHECK itself, which binds every role. (The 0189 trigger only
 * fires for a code already of the shape, so for these refused codes the CHECK is the only thing that can speak.)
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const CONSTRAINT = 'items_code_shape_check';
/** R5, the override-shape sentence. The CHECK's own sentence (CONSTRAINT_MESSAGES) is this same text (S6 builder slice). */
const S_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function mkOrg(hint: string) {
  const code = uid(`t386s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, personId: p!.id, actor: { personId: p!.id, orgId } as Actor };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;

type PgErr = { code?: string; constraint_name?: string; message?: string } | null;
const attempt = async (fn: () => Promise<unknown>): Promise<PgErr> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as PgErr;
  }
};
const insertRaw = (o: Org, code: string) =>
  attempt(
    () => sql`insert into items (org_id, code, name, kind, base_unit, created_by)
              values (${o.orgId}, ${code}, ${uid('n')}, 'raw_material', 'kg', ${o.personId})`,
  );
async function shapedItem(o: Org): Promise<{ id: string; code: string }> {
  const code = testItemCode();
  const [r] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${o.orgId}, ${code}, ${uid('n')}, 'raw_material', 'kg', ${o.personId}) returning id`;
  return { id: r!.id, code };
}
// CHWN-000 is refused by the 0189 never-reused trigger, which fires BEFORE the CHECK (both refuse; s2 D2 asserts the same).
const constraintFor = (bad: string) => (bad.endsWith('-000') ? 'items_code_never_reused' : CONSTRAINT);
const refusedByShape = (err: PgErr, label: string, bad = '') => {
  expect(err, `${label}: must be refused`).not.toBeNull();
  expect(err!.code, `${label}: check_violation`).toBe('23514');
  expect(err!.constraint_name, `${label}: the shape CHECK (or, for -000, the never-reused trigger that fires first)`).toBe(constraintFor(bad));
};

// The four named by the spec, plus the shapes next to them: wrong case, wrong lengths, wrong separator, trailing text, blank.
const BAD = [
  ['lower-case', 'chwn-001'],
  ['3-letter stem', 'CHW-001'],
  ['number 000', 'CHWN-000'],
  ['5-digit number', 'CHWN-00001'],
  ['4-digit number', 'CHWN-0001'],
  ['2-digit number', 'CHWN-01'],
  ['5-character stem', 'CHWNX-001'],
  ['no dash', 'CHWN001'],
  ['underscore', 'CHWN_001'],
  ['trailing text', 'CHWN-001X'],
  ['leading space', ' CHWN-001'],
  ['legacy free-form', 'PORK-BELLY'],
] as const;

describe('T-386 S6 - items_code_shape_check on a raw INSERT', () => {
  for (const [label, bad] of BAD) {
    it(`${label} (${JSON.stringify(bad)}) is refused on ${CONSTRAINT}`, async () => {
      const o = await mkOrg('ins');
      refusedByShape(await insertRaw(o, bad), label, bad);
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from items where org_id = ${o.orgId}`;
      expect(n!.n, 'nothing was stored').toBe(0);
    });
  }

  it('control: a shaped code passes (letters, digits, mixed; 001 and 999 are the ends)', async () => {
    const o = await mkOrg('ok');
    for (const good of ['0001-001', 'ZZZZ-999', 'A1B2-050', testItemCode()]) {
      expect(await insertRaw(o, good), good).toBeNull();
    }
  });
});

describe('T-386 S6 - items_code_shape_check on an UPDATE of the code', () => {
  for (const [label, bad] of BAD) {
    it(`${label} (${JSON.stringify(bad)}) is refused on ${CONSTRAINT}`, async () => {
      const o = await mkOrg('upd');
      const item = await shapedItem(o);
      refusedByShape(await attempt(() => sql`update items set code = ${bad} where id = ${item.id}`), label, bad);
      const [row] = await sql<{ code: string }[]>`select code from items where id = ${item.id}`;
      expect(row!.code, 'the old code is untouched').toBe(item.code);
    });
  }

  it('control: updating to another shaped code (above the mark) passes; updating a non-code column is untouched by the CHECK', async () => {
    const o = await mkOrg('updok');
    const item = await shapedItem(o);
    expect(await attempt(() => sql`update items set name = ${uid('renamed')} where id = ${item.id}`)).toBeNull();
    expect(await attempt(() => sql`update items set code = ${testItemCode()} where id = ${item.id}`)).toBeNull();
  });
});

describe('T-386 S6 - the domain refusal sentence is the R5 shape sentence', () => {
  async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return transaction(async (tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
      return fn(tx);
    });
  }
  async function sentenceOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (err) {
      const m = (err as { userMessage?: unknown }).userMessage;
      if (typeof m !== 'string') throw new Error(`expected a refusal sentence (userMessage), got: ${(err as Error).message}`);
      return m;
    }
    throw new Error('expected the call to be refused');
  }

  for (const bad of ['CHW-001', 'CHWN-000', 'CHWN-00001', 'CHWN001', 'PORK-BELLY']) {
    it(`createItem with the override ${JSON.stringify(bad)} is refused with the shape sentence, and nothing is stored`, async () => {
      const o = await mkOrg('dom');
      const s = await sentenceOf(
        asOrg(o.orgId, (tx) =>
          createItem(tx, o.actor, { name: uid('Probe'), code: bad, kind: 'raw_material', baseUnit: 'kg' } as Parameters<typeof createItem>[2]),
        ),
      );
      expect(s).toBe(S_SHAPE);
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from items where org_id = ${o.orgId}`;
      expect(n!.n).toBe(0);
    });
  }
});

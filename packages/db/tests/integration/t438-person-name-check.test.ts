/**
 * T-438 S2a - migration 0207: `persons_name_parts_check` (docs/tasks/438-hire-name-parts-and-staff-pin-only.md, N1-N3).
 * Cases D1-D5. RED on a 0206-era database: the three columns do not exist, so every insert below errors with
 * `column "last_name" of relation "persons" does not exist` (D3's all-NULL leg is the only one that passes before 0207).
 * Fixtures run on any `_test` DB.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function org(): Promise<string> {
  const code = uid('t438chk');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return o!.id;
}

type Parts = { last: string | null; first: string | null; middle: string | null };
async function insert(orgId: string, display: string, p: Parts, kind = 'person') {
  return sql`
    insert into persons (org_id, display_name, kind, last_name, first_name, middle_name)
    values (${orgId}, ${display}, ${kind}, ${p.last}, ${p.first}, ${p.middle})
    returning id, last_name, first_name, middle_name, display_name`;
}
async function code(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code ?? `no-code:${(e as Error).message}`;
  }
  return 'accepted';
}

describe('T-438 D1 - parts must agree with display_name', () => {
  it('parts with a non-matching display_name -> 23514 (check_violation)', async () => {
    // Kills: CHECK missing the display_name equality leg.
    const o = await org();
    expect(await code(insert(o, 'Santos Maria', { last: 'Santos', first: 'Maria', middle: null }))).toBe('23514');
    expect(await code(insert(o, 'Santos, Maria C.', { last: 'Santos', first: 'Maria', middle: null }))).toBe('23514');
    expect(await code(insert(o, 'santos, Maria', { last: 'Santos', first: 'Maria', middle: null }))).toBe('23514');
  });
  it('the exact formatted display_name is accepted', async () => {
    const o = await org();
    const rows = await insert(o, 'Santos, Maria C.', { last: 'Santos', first: 'Maria', middle: 'clara' });
    expect(rows[0]!['display_name']).toBe('Santos, Maria C.');
  });
});

describe('T-438 D2 - the TypeScript formatter and the SQL expression agree', () => {
  const cases: [string, string, string | null][] = [
    ['Santos', 'Maria', 'clara'], // U1
    ['Santos', 'Maria', null], // U2
    ['Dela Cruz', 'Juan Miguel', 'santos'], // U3 (already normalised)
    ['Reyes', 'Ana', 'ñoño'], // upper() of a non-ASCII initial
  ];
  for (const [last, first, middle] of cases) {
    it(`${last} / ${first} / ${middle ?? '(none)'}`, async () => {
      // Kills: TS and SQL formats drifting (initial case, period, comma/space).
      const o = await org();
      // Imported lazily from source (not the barrel) so the other cases go red for the DB reason, not for a missing module.
      const { formatDisplayName } = await import('../../../domain/src/people/person-name');
      const display = formatDisplayName({ lastName: last, firstName: first, ...(middle === null ? {} : { middleName: middle }) });
      expect(await code(insert(o, display, { last, first, middle }))).toBe('accepted');
    });
  }
});

describe('T-438 D3 - all-or-nothing parts', () => {
  it('last set, first NULL -> refused; first set, last NULL -> refused', async () => {
    // Kills: all-or-nothing leg missing.
    const o = await org();
    expect(await code(insert(o, 'Santos', { last: 'Santos', first: null, middle: null }))).toBe('23514');
    expect(await code(insert(o, 'Maria', { last: null, first: 'Maria', middle: null }))).toBe('23514');
  });
  it('a middle name alone (no last/first) -> refused', async () => {
    const o = await org();
    expect(await code(insert(o, 'C.', { last: null, first: null, middle: 'clara' }))).toBe('23514');
  });
  it('all three NULL accepts any display_name (legacy rows, terminals, system author)', async () => {
    const o = await org();
    expect(await code(insert(o, 'Maria Dela Cruz Santos', { last: null, first: null, middle: null }))).toBe('accepted');
    expect(await code(insert(o, 'Anything at all', { last: null, first: null, middle: null }))).toBe('accepted');
  });
  it('empty or untrimmed last/first -> refused', async () => {
    const o = await org();
    expect(await code(insert(o, ', Maria', { last: '', first: 'Maria', middle: null }))).toBe('23514');
    expect(await code(insert(o, 'Santos, ', { last: 'Santos', first: '', middle: null }))).toBe('23514');
    expect(await code(insert(o, ' Santos, Maria', { last: ' Santos', first: 'Maria', middle: null }))).toBe('23514');
    expect(await code(insert(o, 'Santos, Maria ', { last: 'Santos', first: 'Maria ', middle: null }))).toBe('23514');
  });
});

describe('T-438 D4 - only a person has parts', () => {
  it('parts on a kind = terminal row -> refused', async () => {
    // Kills: `kind = 'person'` leg missing.
    const o = await org();
    expect(await code(insert(o, 'Santos, Maria', { last: 'Santos', first: 'Maria', middle: null }, 'terminal'))).toBe('23514');
  });
  it('a terminal with NULL parts is still fine', async () => {
    const o = await org();
    expect(await code(insert(o, 'Terminal - Lipa', { last: null, first: null, middle: null }, 'terminal'))).toBe('accepted');
  });
});

describe('T-438 D5 - middle name shape', () => {
  it('middle empty string -> refused; untrimmed middle -> refused; NULL middle -> accepted', async () => {
    // Kills: empty-string middle allowed.
    const o = await org();
    expect(await code(insert(o, 'Santos, Maria', { last: 'Santos', first: 'Maria', middle: '' }))).toBe('23514');
    expect(await code(insert(o, 'Santos, Maria C.', { last: 'Santos', first: 'Maria', middle: ' clara' }))).toBe('23514');
    expect(await code(insert(o, 'Santos, Maria', { last: 'Santos', first: 'Maria', middle: null }))).toBe('accepted');
  });
});

describe('T-438 N1/N3 - updating a row cannot drift the pair either', () => {
  it('UPDATE display_name alone on a row with parts -> refused; a legacy row (NULL parts) can be renamed freely', async () => {
    const o = await org();
    const [ok] = await insert(o, 'Santos, Maria', { last: 'Santos', first: 'Maria', middle: null });
    expect(await code(sql`update persons set display_name = 'Someone Else' where id = ${ok!['id']}`)).toBe('23514');
    const [legacy] = await insert(o, 'Maria Santos', { last: null, first: null, middle: null });
    expect(await code(sql`update persons set display_name = 'Maria S. Santos' where id = ${legacy!['id']}`)).toBe('accepted');
  });
});

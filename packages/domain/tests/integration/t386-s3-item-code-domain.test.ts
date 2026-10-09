import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-386 S3 - `docs/tasks/386-item-code-auto-suggest.md` S3 / R5-R9, tests A1-A11, the rename legs R1-R7 (spec R8) and the
 * suggestion legs S1-S5 (spec R9). TESTER file. Real Postgres, real `authorize()`, as APP_ROLE under an org principal.
 *
 * State at HEAD (red first): `createItem` demands a typed free-form code and writes it as is; `requestItem` demands a typed code;
 * `approveItemRequest` copies it; `renameItem` takes any code; `suggestItemCode` does not exist. Every leg below that exercises
 * allocation fails on HEAD with the call's own refusal ("an item needs a code", "Cannot read properties of undefined (reading
 * 'trim')") or "suggestItemCode is not a function". The legs named "control" pass today and must stay green.
 *
 * Each test names its killing mutant. Refusals are asserted by their EXACT sentence (`userMessage`, set by `refuse()`), never by
 * "it threw": a database constraint reaching the person is exactly what the domain's own checks exist to prevent (spec A2).
 *
 * Inputs the HEAD types do not admit (`code` optional, `adoptSuggestedCode`) go through a cast, the T-383 idiom.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { approveItemRequest, createItem, mergeItems, requestItem } from '@shareat/domain';

type BaseUnit = 'kg' | 'pcs';
type Kind = 'raw_material' | 'retail';
type NewItem = { name: string; code?: string; kind?: Kind; baseUnit?: BaseUnit };
type SameStem = { id: string; code: string; name: string; status: string };
type Suggestion = { stem: string | null; code: string | null; full: boolean; sameStem: SameStem[] };

// Read off the namespace so a missing export fails the leg that calls it (TypeError at call time), not the whole file at import.
const renameItem = (domain as unknown as {
  renameItem: (tx: Tx | null, actor: Actor, input: { itemId: string; name: string; code: string; adoptSuggestedCode?: boolean }) => Promise<{ changed: boolean }>;
}).renameItem;
const suggestItemCode = (domain as unknown as {
  suggestItemCode: (tx: Tx | null, actor: Actor, input: { name: string; forItemId?: string }) => Promise<Suggestion>;
}).suggestItemCode;

const sql = postgres(url, { max: 12 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t386s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const manager2Id = await mk('Manager Two', 'manager');
  const staffId = await mk('Staff', 'staff');
  return {
    orgId, storeId: store!.id, createdBy: superId,
    superAdmin: actor(orgId, superId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
    manager2: actor(orgId, manager2Id), staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const create = (f: Fixture, who: Actor, i: NewItem) =>
  asOrg(f.orgId, (tx) =>
    createItem(tx, who, { kind: 'raw_material', baseUnit: 'kg', ...i } as unknown as Parameters<typeof createItem>[2]),
  );
const request = (f: Fixture, who: Actor, i: NewItem & { code?: string }) =>
  asOrg(f.orgId, (tx) => requestItem(tx, who, { kind: 'raw_material', baseUnit: 'kg', ...i } as unknown as Parameters<typeof requestItem>[2]));
const approve = (f: Fixture, who: Actor, requestId: string, code?: string) =>
  asOrg(f.orgId, (tx) => approveItemRequest(tx, who, { requestId, ...(code === undefined ? {} : { code }) } as never));
const rename = (f: Fixture, who: Actor, itemId: string, name: string, code: string, adopt?: boolean) =>
  asOrg(f.orgId, (tx) => renameItem(tx, who, { itemId, name, code, ...(adopt === undefined ? {} : { adoptSuggestedCode: adopt }) }));
const suggest = (f: Fixture, who: Actor, name: string, forItemId?: string) =>
  asOrg(f.orgId, (tx) => suggestItemCode(tx, who, { name, ...(forItemId ? { forItemId } : {}) }));

const itemRow = async (id: string) =>
  (await sql<{ name: string; code: string; status: string }[]>`select name, code, status from items where id = ${id}`)[0]!;
const codeOf = async (id: string) => (await itemRow(id)).code;
const markOf = async (f: Fixture, stem: string) =>
  (await sql<{ last_seq: number }[]>`select last_seq from item_code_counters where org_id = ${f.orgId} and stem = ${stem}`)[0]?.last_seq ?? null;
// Tolerates the table not existing yet (HEAD): a control leg that only asserts "no counter row" must not turn red for lack of the table.
const counterRows = async (f: Fixture) => {
  const [t] = await sql<{ r: string | null }[]>`select to_regclass('public.item_code_counters')::text as r`;
  if (!t!.r) return 0;
  return (await sql<{ n: number }[]>`select count(*)::int as n from item_code_counters where org_id = ${f.orgId}`)[0]!.n;
};
const itemCount = async (f: Fixture) => (await sql<{ n: number }[]>`select count(*)::int as n from items where org_id = ${f.orgId}`)[0]!.n;
const requestRow = async (id: string) =>
  (await sql<{ code: string; status: string; created_item_id: string | null; similar_warning: string | null }[]>`
    select code, status, created_item_id, similar_warning from item_requests where id = ${id}`)[0]!;
const auditRows = (itemId: string) =>
  sql<{ before: { name?: string; code?: string }; after: { name?: string; code?: string }; actor_person_id: string }[]>`
    select before, after, actor_person_id from audit_log where entity = 'items' and entity_id = ${itemId} and action = 'rename_item' order by occurred_at, id`;

/** The sentence a person reads: `RefusalError.userMessage`. Fails if the call succeeded or threw something that is not a refusal. */
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
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint;
    if (c) return c;
  }
  return undefined;
}

// The sentences (spec R5). {CODE}/{STEM} are the upper-case forms.
const S_NO_STEM = 'Give the item a name with letters or numbers in it.';
const S_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';
const S_FULL = (stem: string) => `Every number under ${stem} has been used (999 items). A super-admin can type a code with different letters.`;
const S_TAKEN = (code: string, stem: string, last: string, next: string) =>
  `${code} cannot be used: numbers up to ${stem}-${last} have already been given out under ${stem}. The next free one is ${stem}-${next}.`;

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('A - createItem allocates the code', () => {
  it(
    'A1: no code, "Chicken wings" -> CHWN-001; "Chicken winglets" -> CHWN-002; the mark is 2. Mutants: allocator returns last_seq (not +1) -> CHWN-000/001 red; counter never raised -> both CHWN-001 red. Red today: createItem refuses a missing code',
    async () => {
      const f = await fixture('a1');
      const a = await create(f, f.superAdmin, { name: 'Chicken wings' });
      const b = await create(f, f.superAdmin, { name: 'Chicken winglets' });
      expect(await codeOf(a.id)).toBe('CHWN-001');
      expect(await codeOf(b.id)).toBe('CHWN-002');
      expect(await markOf(f, 'CHWN')).toBe(2);
    },
    60_000,
  );

  it(
    'A1b: a blank or whitespace code is "absent" and allocates (R5: absent or blank). Mutant: only undefined is absent -> "" reaches the CHECK, red. Red today: blank code is refused by createItem',
    async () => {
      const f = await fixture('a1b');
      const a = await create(f, f.superAdmin, { name: 'Pork belly', code: '' });
      const b = await create(f, f.superAdmin, { name: 'Pork belly sliced', code: '   ' });
      expect(await codeOf(a.id)).toBe('PRBL-001');
      expect(await codeOf(b.id)).toBe('PRBS-001');
    },
    60_000,
  );

  it(
    'A1c: the stem comes from the NAME as typed: "Coke 1.5" CK15-001, "Coke 1.5L" CK15-002, "Coke 15" CK15-003 (collisions are numbered, never blocked), "Coke 330ml" CK33-001. Mutant: stem from the trimmed-lower name with punctuation kept -> red. Red today: no code is allocated',
    async () => {
      const f = await fixture('a1c');
      const codes: string[] = [];
      for (const name of ['Coke 1.5', 'Coke 1.5L', 'Coke 15', 'Coke 330ml']) {
        codes.push(await codeOf((await create(f, f.superAdmin, { name })).id));
      }
      expect(codes).toEqual(['CK15-001', 'CK15-002', 'CK15-003', 'CK33-001']);
    },
    60_000,
  );

  it(
    'A2: super-admin override " ck15-005 " on "Coke 1.5" -> stored CK15-005 (trimmed, upper-cased); a following "Coke 1.5L" with no code -> CK15-006; override CK15-003 -> the "cannot be used" sentence naming the next free CK15-007; override COKE15 -> the shape sentence; nothing written by the refusals. Mutants: no upper-case -> red; no mark check (trigger only) -> the sentence is the generic 23514 one -> red. Red today: the free-form code is stored as typed',
    async () => {
      const f = await fixture('a2');
      const a = await create(f, f.superAdmin, { name: 'Coke 1.5', code: ' ck15-005 ' });
      expect(await codeOf(a.id)).toBe('CK15-005');
      expect(await markOf(f, 'CK15')).toBe(5);
      const b = await create(f, f.superAdmin, { name: 'Coke 1.5L' });
      expect(await codeOf(b.id)).toBe('CK15-006');
      const before = await itemCount(f);
      expect(await sentenceOf(create(f, f.superAdmin, { name: 'Coke 15', code: 'CK15-003' }))).toBe(S_TAKEN('CK15-003', 'CK15', '006', '007'));
      expect(await sentenceOf(create(f, f.superAdmin, { name: 'Coke 15', code: 'COKE15' }))).toBe(S_SHAPE);
      expect(await itemCount(f), 'refusals write nothing').toBe(before);
      expect(await markOf(f, 'CK15'), 'and move no mark').toBe(6);
    },
    60_000,
  );

  it(
    'A2b: shape refusals: too short, too long, a dash missing, CHWN-000, CHWN-0001, spaces inside, punctuation - each gets the shape sentence; a legacy code like PORK-BELLY is refused for a NEW item. Mutant: accept any non-blank string (HEAD behaviour) -> red on the first. Red today: all accepted',
    async () => {
      const f = await fixture('a2b');
      for (const bad of ['CHW-001', 'CHWNX-001', 'CHWN001', 'CHWN-000', 'CHWN-0001', 'CH N-001', 'CHWN-0.1', 'PORK-BELLY', 'CHWN_001']) {
        expect(await sentenceOf(create(f, f.superAdmin, { name: `Probe ${bad}`, code: bad })), bad).toBe(S_SHAPE);
      }
      expect(await itemCount(f)).toBe(0);
    },
    60_000,
  );

  it(
    'A2c: an override need not use the name\'s stem (Ian: "another code of the same shape"): "Soy sauce" with SYSC... is not required - ABCD-010 is stored; a later "Soy sauce." with no code still starts at SYSC-001 (its own stem has its own mark). Mutant: override must match the name\'s stem -> red. Red today: free-form code stored',
    async () => {
      const f = await fixture('a2c');
      const a = await create(f, f.superAdmin, { name: 'Soy sauce', code: 'ABCD-010' });
      expect(await codeOf(a.id)).toBe('ABCD-010');
      const b = await create(f, f.superAdmin, { name: 'Soy sauce.' });
      expect(await codeOf(b.id)).toBe('SYSC-001');
      expect(await markOf(f, 'ABCD')).toBe(10);
    },
    60_000,
  );

  it(
    'A3: stem full: a real CHWN-999 override, then "Chicken wings." (stem CHWN) with no code -> the full sentence, nothing written; with override CHWX-001 -> ok. (Spec wrote "Chicken wings 2" - that name\'s stem is CHW2, so it would not hit the full stem.) Mutant: allocate 1000 -> red. Red today: the free-form code is stored',
    async () => {
      const f = await fixture('a3');
      const top = await create(f, f.superAdmin, { name: 'Chicken wings', code: 'CHWN-999' });
      expect(await codeOf(top.id)).toBe('CHWN-999');
      const before = await itemCount(f);
      expect(await sentenceOf(create(f, f.superAdmin, { name: 'Chicken wings.' }))).toBe(S_FULL('CHWN'));
      expect(await itemCount(f)).toBe(before);
      expect(await markOf(f, 'CHWN')).toBe(999);
      const other = await create(f, f.superAdmin, { name: 'Chicken wings.', code: 'CHWX-001' });
      expect(await codeOf(other.id)).toBe('CHWX-001');
    },
    60_000,
  );

  it(
    'A4: null stem: name "--" -> "Give the item a name with letters or numbers in it."; nothing written, no counter row. Mutant: allocate XXXX-001 -> red. Red today: "--" is created',
    async () => {
      const f = await fixture('a4');
      expect(await sentenceOf(create(f, f.superAdmin, { name: '--' }))).toBe(S_NO_STEM);
      expect(await itemCount(f)).toBe(0);
      expect(await counterRows(f)).toBe(0);
    },
    60_000,
  );

  it(
    'A8 (control): manager and admin -> AuthorizationError from createItem and approveItemRequest, with or without a code (I3: only approve_item paths accept one). Green today and after',
    async () => {
      const f = await fixture('a8');
      for (const who of [f.manager, f.admin, f.staff]) {
        expect(await failure(create(f, who, { name: 'Chicken wings' }))).toBeInstanceOf(AuthorizationError);
        expect(await failure(create(f, who, { name: 'Chicken wings', code: 'CHWN-001' }))).toBeInstanceOf(AuthorizationError);
      }
      expect(await itemCount(f)).toBe(0);
      const r = await request(f, f.manager, { name: 'Chicken wings' }).catch(() => null);
      if (r) {
        for (const who of [f.manager, f.admin]) {
          expect(await failure(approve(f, who, r.requestId))).toBeInstanceOf(AuthorizationError);
          expect(await failure(approve(f, who, r.requestId, 'CHWN-050'))).toBeInstanceOf(AuthorizationError);
        }
        expect((await requestRow(r.requestId)).status).toBe('requested');
      }
    },
    60_000,
  );
});

describe('A - requests keep a frozen preview; approval allocates', () => {
  it(
    'A5 (the DEF): two managers request "Chicken wings" and "Chicken winglets" (both stem CHWN) before either is approved: both item_requests.code = CHWN-001 (a preview, not a promise); approve both -> CHWN-001 then CHWN-002, no error. Mutant: approval copies req.code -> the second approval dies on 23505/23514 -> red. Red today: requestItem demands a typed code, and equal typed codes make the second approval die on items_org_code_key',
    async () => {
      const f = await fixture('a5');
      const r1 = await request(f, f.manager, { name: 'Chicken wings' });
      const r2 = await request(f, f.manager2, { name: 'Chicken winglets' });
      expect((await requestRow(r1.requestId)).code).toBe('CHWN-001');
      expect((await requestRow(r2.requestId)).code).toBe('CHWN-001');
      expect(await counterRows(f), 'a request allocates nothing').toBe(0);
      const a1 = await approve(f, f.superAdmin, r1.requestId);
      const a2 = await approve(f, f.superAdmin, r2.requestId);
      expect(await codeOf(a1.itemId)).toBe('CHWN-001');
      expect(await codeOf(a2.itemId)).toBe('CHWN-002');
      expect((await requestRow(r1.requestId)).status).toBe('approved');
      expect((await requestRow(r2.requestId)).status).toBe('approved');
    },
    60_000,
  );

  it(
    'A5b: the preview follows the mark at request time: after CHWN-001 exists a new request for "Chicken winglets" stores CHWN-002; a full stem stores "CHWN-???" and the approval says the stem is full (an override gets through). Mutant: preview allocates (mark rises on request) -> the counter leg red. Red today: the code is whatever was typed',
    async () => {
      const f = await fixture('a5b');
      await create(f, f.superAdmin, { name: 'Chicken wings' });
      const r = await request(f, f.manager, { name: 'Chicken winglets' });
      expect((await requestRow(r.requestId)).code).toBe('CHWN-002');
      expect(await markOf(f, 'CHWN'), 'requesting does not move the mark').toBe(1);

      await create(f, f.superAdmin, { name: 'Chicken wings.', code: 'CHWN-999' });
      const full = await request(f, f.manager, { name: 'Chicken wings..' });
      expect((await requestRow(full.requestId)).code).toBe('CHWN-???');
      expect(await sentenceOf(approve(f, f.superAdmin, full.requestId))).toBe(S_FULL('CHWN'));
      expect((await requestRow(full.requestId)).status, 'a refused approval leaves the request open').toBe('requested');
      const done = await approve(f, f.superAdmin, full.requestId, 'CHWX-001');
      expect(await codeOf(done.itemId)).toBe('CHWX-001');
    },
    60_000,
  );

  it(
    'A6: requestItem ignores a code: at runtime `{..., code: "ZZZZ-001"}` stores the preview, not ZZZZ-001 (TS-level the input has none). Mutant: `input.code ?? preview` -> red. Red today: the typed code is stored',
    async () => {
      const f = await fixture('a6');
      const r = await request(f, f.manager, { name: 'Chicken wings', code: 'ZZZZ-001' });
      expect((await requestRow(r.requestId)).code).toBe('CHWN-001');
    },
    60_000,
  );

  it(
    'A6b: a request whose name has no letters or numbers is refused with the stem sentence BEFORE anything is stored. Mutant: store "XXXX-001" -> red. Red today: the request is stored',
    async () => {
      const f = await fixture('a6b');
      expect(await sentenceOf(request(f, f.manager, { name: '--' }))).toBe(S_NO_STEM);
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from item_requests where org_id = ${f.orgId}`;
      expect(n!.n).toBe(0);
    },
    60_000,
  );

  it(
    'A7: approveItemRequest with override code "sysc-010" -> the item is SYSC-010 (upper-cased); a bad shape or a number not above the mark is refused with its sentence and the request stays open. Mutants: override ignored -> SYSC-001, red; no shape check -> red. Red today: approveItemRequest takes no code',
    async () => {
      const f = await fixture('a7');
      const r = await request(f, f.manager, { name: 'Soy sauce' });
      expect(await sentenceOf(approve(f, f.superAdmin, r.requestId, 'SOY'))).toBe(S_SHAPE);
      await create(f, f.superAdmin, { name: 'Soy sauce.', code: 'SYSC-004' });
      expect(await sentenceOf(approve(f, f.superAdmin, r.requestId, 'SYSC-002'))).toBe(S_TAKEN('SYSC-002', 'SYSC', '004', '005'));
      expect((await requestRow(r.requestId)).status).toBe('requested');
      const ok = await approve(f, f.superAdmin, r.requestId, 'sysc-010');
      expect(await codeOf(ok.itemId)).toBe('SYSC-010');
      expect(await markOf(f, 'SYSC')).toBe(10);
    },
    60_000,
  );

  it(
    'A7b: approval without a code allocates from the REQUEST\'s name (not from a stored preview): a preview of CHWN-001 sits on the request while the mark has since moved to 5 -> the item is CHWN-006. Mutant: approval copies req.code -> 23514 never-reused, red. Red today: the item is created with the stored code',
    async () => {
      const f = await fixture('a7b');
      const r = await request(f, f.manager, { name: 'Chicken wings' });
      expect((await requestRow(r.requestId)).code).toBe('CHWN-001');
      await create(f, f.superAdmin, { name: 'Chicken winglets', code: 'CHWN-005' });
      const ok = await approve(f, f.superAdmin, r.requestId);
      expect(await codeOf(ok.itemId)).toBe('CHWN-006');
    },
    60_000,
  );

  it(
    'A9: concurrency: two transactions on separate connections approve two CHWN requests at once (Promise.all) -> codes {CHWN-001, CHWN-002} in some order, both succeed. Run five times (five stems). Mutant: drop FOR UPDATE in lockItemCodeStem -> one fails with 23514/23505 -> red. Red today: requestItem needs a typed code and equal codes cannot both be approved',
    async () => {
      const f = await fixture('a9');
      const bases: [string, string, string][] = [
        ['Kimchi', 'Kimchi.', 'KMCH'],
        ['Gochujang', 'Gochujang.', 'GCHJ'],
        ['Calamansi', 'Calamansi.', 'CLMN'],
        ['Coffee', 'Coffee.', 'COFF'],
        ['Gloves', 'Gloves.', 'GLVS'],
      ];
      for (const [n1, n2, stem] of bases) {
        const r1 = await request(f, f.manager, { name: n1 });
        const r2 = await request(f, f.manager2, { name: n2 });
        const [a, b] = await Promise.all([approve(f, f.superAdmin, r1.requestId), approve(f, f.superAdmin, r2.requestId)]);
        expect(new Set([await codeOf(a.itemId), await codeOf(b.itemId)]), stem).toEqual(new Set([`${stem}-001`, `${stem}-002`]));
        expect(await markOf(f, stem)).toBe(2);
      }
    },
    120_000,
  );

  it(
    'A9b: concurrency, create path: two simultaneous no-code createItem of the same stem -> two different numbers, both succeed. Mutant: no row lock -> a duplicate number / 23514, red. Red today: createItem needs a code',
    async () => {
      const f = await fixture('a9b');
      const [a, b] = await Promise.all([
        create(f, f.superAdmin, { name: 'Pepper' }),
        create(f, f.superAdmin, { name: 'Pepper.' }),
      ]);
      expect(new Set([await codeOf(a.id), await codeOf(b.id)])).toEqual(new Set(['PEPR-001', 'PEPR-002']));
    },
    60_000,
  );
});

describe('A - a number once given out is never given out again', () => {
  it(
    'A10: create "Pork belly" (PRBL-001), retire it (raw status update), rename it "Pork belly (old)" with the adopt tick (-> PRBO-001); now no item holds PRBL-001, yet creating "Pork belly" again gives PRBL-002, never -001. Mutant: the allocator uses max() over current codes -> PRBL-001, red. Red today: no allocation',
    async () => {
      const f = await fixture('a10');
      const first = await create(f, f.superAdmin, { name: 'Pork belly' });
      expect(await codeOf(first.id)).toBe('PRBL-001');
      await sql`update items set status = 'inactive' where id = ${first.id}`;
      await rename(f, f.superAdmin, first.id, 'Pork belly (old)', 'PRBL-001', true);
      expect(await codeOf(first.id)).toBe('PRBO-001');
      const [held] = await sql<{ n: number }[]>`select count(*)::int as n from items where org_id = ${f.orgId} and code = 'PRBL-001'`;
      expect(held!.n, 'nobody holds PRBL-001 any more').toBe(0);
      const again = await create(f, f.superAdmin, { name: 'Pork belly' });
      expect(await codeOf(again.id)).toBe('PRBL-002');
    },
    60_000,
  );

  it(
    'A10b: merge and recode do not free numbers either: a merged SYSC-002 stays issued (next is SYSC-003); an item recoded by override from CHWN-001 to CHWN-005 leaves 001..005 issued (next is CHWN-006). Mutant: max() over current codes of non-merged items -> red. Red today: no allocation',
    async () => {
      const f = await fixture('a10b');
      const win = await create(f, f.superAdmin, { name: 'Soy sauce' });
      const lose = await create(f, f.superAdmin, { name: 'Soy sauce.' });
      expect(await codeOf(lose.id)).toBe('SYSC-002');
      await asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: lose.id, winnerId: win.id }));
      const next = await create(f, f.superAdmin, { name: 'Soy sauce..' });
      expect(await codeOf(next.id)).toBe('SYSC-003');

      const wings = await create(f, f.superAdmin, { name: 'Chicken wings' });
      await rename(f, f.superAdmin, wings.id, 'Chicken wings', 'CHWN-005');
      expect(await codeOf(wings.id)).toBe('CHWN-005');
      const more = await create(f, f.superAdmin, { name: 'Chicken winglets' });
      expect(await codeOf(more.id)).toBe('CHWN-006');
    },
    60_000,
  );

  it(
    'A10c: the freed number cannot come back by override either: after CHWN-001 -> CHWN-005 by rename, a typed CHWN-001 on another item gets the "cannot be used ... next free one is CHWN-006" sentence. Mutant: override checked against current codes only -> accepted, red. Red today: free-form accepted',
    async () => {
      const f = await fixture('a10c');
      const wings = await create(f, f.superAdmin, { name: 'Chicken wings' });
      await rename(f, f.superAdmin, wings.id, 'Chicken wings', 'CHWN-005');
      expect(await sentenceOf(create(f, f.superAdmin, { name: 'Chicken winglets', code: 'CHWN-001' }))).toBe(S_TAKEN('CHWN-001', 'CHWN', '005', '006'));
    },
    60_000,
  );
});

describe('A - the similarity warning lists items that share the code letters', () => {
  it(
    'A11: request "Chicken winglets" after CHWN-001 "Chicken wings" exists -> similarWarning contains "Same code letters as: CHWN-001 Chicken wings (active)" EXACTLY once, even though the trigram list also has that item (precondition asserted), joined to the trigram text by "; ". Mutant: append the same-stem text per list -> twice, red; replace the trigram text -> the "Possible duplicate" text vanishes, red. Red today: requestItem demands a code, no such text',
    async () => {
      const f = await fixture('a11');
      await create(f, f.superAdmin, { name: 'Chicken wings' });
      const r = await request(f, f.manager, { name: 'Chicken winglets' });
      expect(r.similar.map((s) => s.code), 'precondition: the trigram list has the item too').toContain('CHWN-001');
      const w = r.similarWarning ?? '';
      expect(w).toContain('Same code letters as: CHWN-001 Chicken wings (active)');
      expect(w.split('CHWN-001 Chicken wings').length - 1, 'once').toBe(1);
      expect(w.split('Chicken wings').length - 1, "the item's NAME appears once in the whole warning (it is in both lists)").toBe(1);
      expect(w).toContain('Possible duplicate of');
      expect(w).toMatch(/; Same code letters as: /);
      expect((await requestRow(r.requestId)).similar_warning, 'and it is frozen on the request').toBe(w);
    },
    60_000,
  );

  it(
    'A11b: same code letters is a SECOND signal, not a copy of the first: "Chickpea wings" (stem CHWN) after "Chicken wings" carries the same-stem text whatever the trigram score; an unrelated "Charcoal" carries neither (control: the warning stays quiet). Mutant: only warn when trigram hits -> red on the first. Red today: no such text',
    async () => {
      const f = await fixture('a11b');
      await create(f, f.superAdmin, { name: 'Chicken wings' });
      const near = await request(f, f.manager, { name: 'Chickpea wings' });
      expect(near.similarWarning ?? '').toContain('Same code letters as: CHWN-001 Chicken wings (active)');
      const far = await request(f, f.manager, { name: 'Charcoal' });
      expect(far.similarWarning).toBeNull();
    },
    60_000,
  );

  it(
    'A11c: retired and merged items are listed with their status: after CHWN-001 is retired, a request for "Chicken winglets" says "(inactive)". Mutant: active items only -> red. Red today: no such text',
    async () => {
      const f = await fixture('a11c');
      const old = await create(f, f.superAdmin, { name: 'Chicken wings' });
      await sql`update items set status = 'inactive' where id = ${old.id}`;
      const r = await request(f, f.manager, { name: 'Chicken winglets' });
      expect(r.similarWarning ?? '').toContain('CHWN-001 Chicken wings (inactive)');
    },
    60_000,
  );
});

describe('R - renameItem and the code (spec R8)', () => {
  it(
    'R1: adopt ticked, "Chicken wings" CHWN-001 -> "Chicken wing tips" (stem CHWT): code CHWT-001; one audit row, before {Chicken wings, CHWN-001} after {Chicken wing tips, CHWT-001}. Mutant: adopt ignored -> code stays, red. Red today: the flag is ignored',
    async () => {
      const f = await fixture('ar1');
      const id = (await create(f, f.superAdmin, { name: 'Chicken wings' })).id;
      expect(await rename(f, f.superAdmin, id, 'Chicken wing tips', 'CHWN-001', true)).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Chicken wing tips', code: 'CHWT-001' });
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        before: { name: 'Chicken wings', code: 'CHWN-001' }, after: { name: 'Chicken wing tips', code: 'CHWT-001' },
        actor_person_id: f.superAdmin.personId,
      });
    },
    60_000,
  );

  it(
    'R1b: adopt ticked IGNORES the typed code: typed "ZZZZ-001" with the tick -> the suggested CHWT-001. Mutant: typed code wins over the tick -> ZZZZ-001, red. Red today: the typed code is written',
    async () => {
      const f = await fixture('ar1b');
      const id = (await create(f, f.superAdmin, { name: 'Chicken wings' })).id;
      await rename(f, f.superAdmin, id, 'Chicken wing tips', 'ZZZZ-001', true);
      expect(await codeOf(id)).toBe('CHWT-001');
    },
    60_000,
  );

  it(
    'R2: adopt ticked, "Pork belly" PRBL-001 -> "Pork Belly" (same stem, shaped): the code STAYS PRBL-001 and the audit row records the name change only. Mutant: adopt always re-allocates -> PRBL-002, red. Red today: createItem refuses a missing code',
    async () => {
      const f = await fixture('ar2');
      const id = (await create(f, f.superAdmin, { name: 'Pork belly' })).id;
      expect(await rename(f, f.superAdmin, id, 'Pork Belly', 'PRBL-001', true)).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Pork Belly', code: 'PRBL-001' });
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ before: { name: 'Pork belly', code: 'PRBL-001' }, after: { name: 'Pork Belly', code: 'PRBL-001' } });
      expect(await markOf(f, 'PRBL'), 'no new number was issued').toBe(1);
    },
    60_000,
  );

  it(
    'R3 (q4 default): adopt unticked, code unchanged, name changes to one with a different stem -> the code stays (a code never follows a rename by itself). Mutant: always adopt -> CHWT-001, red. Red today: createItem needs a code',
    async () => {
      const f = await fixture('ar3');
      const id = (await create(f, f.superAdmin, { name: 'Chicken wings' })).id;
      expect(await rename(f, f.superAdmin, id, 'Chicken wing tips', 'CHWN-001')).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Chicken wing tips', code: 'CHWN-001' });
      expect(await rename(f, f.superAdmin, id, 'Chicken wing tips 2', 'CHWN-001', false)).toEqual({ changed: true });
      expect(await codeOf(id)).toBe('CHWN-001');
      expect(await markOf(f, 'CHWT'), 'no number issued without the tick').toBeNull();
    },
    60_000,
  );

  it(
    'R4: a LEGACY code (PORK-BELLY, raw insert) unchanged on rename is ok - no shape check on an unchanged code (the recode has not run yet). Mutant: shape-check the code always -> red. Red today: green (control: HEAD renames freely)',
    async () => {
      const f = await fixture('ar4');
      const [row] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by)
        values (${f.orgId}, 'PORK-BELLY', 'Pork belly', 'raw_material', 'kg', ${f.createdBy}) returning id`;
      expect(await rename(f, f.superAdmin, row!.id, 'Pork belly sliced', 'PORK-BELLY')).toEqual({ changed: true });
      expect(await itemRow(row!.id)).toMatchObject({ name: 'Pork belly sliced', code: 'PORK-BELLY' });
      expect(await counterRows(f)).toBe(0);
    },
    60_000,
  );

  it(
    'R5: adopt ticked on legacy PORK-BELLY, renamed "Pork belly" -> the code is ALLOCATED: PRBL-001 (the legacy code is not of the shape, so it is never "kept"). Mutant: keep when stems match without checking the shape -> stays PORK-BELLY, red. Red today: the flag is ignored',
    async () => {
      const f = await fixture('ar5');
      const [row] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by)
        values (${f.orgId}, 'PORK-BELLY', 'Pork bellies', 'raw_material', 'kg', ${f.createdBy}) returning id`;
      await rename(f, f.superAdmin, row!.id, 'Pork belly', 'PORK-BELLY', true);
      expect(await codeOf(row!.id)).toBe('PRBL-001');
    },
    60_000,
  );

  it(
    'R6: a typed override that was already issued (PRBL-001, held by another item) -> the "cannot be used" sentence (the domain\'s mark check speaks before the unique index); the item is unchanged and no audit row exists. Mutant: no mark check -> the database speaks (items_org_code_key / 23514), red. Red today: items_org_code_key reaches the caller',
    async () => {
      const f = await fixture('ar6');
      await create(f, f.superAdmin, { name: 'Pork belly' });
      const other = (await create(f, f.superAdmin, { name: 'Soy sauce' })).id;
      expect(await sentenceOf(rename(f, f.superAdmin, other, 'Soy sauce', 'PRBL-001'))).toBe(S_TAKEN('PRBL-001', 'PRBL', '001', '002'));
      expect(await itemRow(other)).toMatchObject({ name: 'Soy sauce', code: 'SYSC-001' });
      expect(await auditRows(other)).toHaveLength(0);
    },
    60_000,
  );

  it(
    'R6b: a typed override of a bad shape on rename -> the shape sentence; a good override above the mark is written upper-cased ("prbl-009" -> PRBL-009). Mutant: no shape check / no upper-case -> red. Red today: written as typed',
    async () => {
      const f = await fixture('ar6b');
      const id = (await create(f, f.superAdmin, { name: 'Pork belly' })).id;
      expect(await sentenceOf(rename(f, f.superAdmin, id, 'Pork belly', 'PORK-BELLY'))).toBe(S_SHAPE);
      expect(await rename(f, f.superAdmin, id, 'Pork belly', ' prbl-009 ')).toEqual({ changed: true });
      expect(await codeOf(id)).toBe('PRBL-009');
    },
    60_000,
  );

  it(
    'R7: a blank code with the tick off passes to the database as blank: items_code_not_blank_check (T-383 R5 unchanged). Mutant: blank means "keep" -> no refusal, red. Red today: green (control: the legacy-accepting HEAD already passes the blank to the CHECK)',
    async () => {
      const f = await fixture('ar7');
      const id = (await create(f, f.superAdmin, { name: 'Pork belly', code: 'PRBL-001' })).id;
      expect(constraintOf(await failure(rename(f, f.superAdmin, id, 'Pork belly', '')))).toBe('items_code_not_blank_check');
      expect(await codeOf(id)).toBe('PRBL-001');
    },
    60_000,
  );

  it(
    'R8 (control, I3): admin and manager cannot rename or recode: AuthorizationError, row unchanged. Green today and after',
    async () => {
      const f = await fixture('ar8');
      const id = (await create(f, f.superAdmin, { name: 'Pork belly', code: 'PRBL-001' })).id;
      for (const who of [f.admin, f.manager]) {
        expect(await failure(rename(f, who, id, 'Pork belly sliced', 'PRBL-009'))).toBeInstanceOf(AuthorizationError);
        expect(await failure(rename(f, who, id, 'Pork belly sliced', 'PRBL-001', true))).toBeInstanceOf(AuthorizationError);
      }
      expect(await itemRow(id)).toMatchObject({ name: 'Pork belly', code: 'PRBL-001' });
    },
    60_000,
  );
});

describe('A - legacy lower-case codes and the allocator', () => {
  it(
    'A12: an item that holds a lower-case legacy chwn-001 (raw insert, as production data may) reserves the number: a new "Chicken wings" with no code is allocated CHWN-002, not CHWN-001 (the case twin). Mutant: the allocator ignores codes that are not already upper-case -> CHWN-001 -> unique-index error, red. Red against e0d4b03 if the allocator does not see the lower-case row',
    async () => {
      const f = await fixture('a12');
      await sql`insert into items (org_id, code, name, kind, base_unit, created_by)
                values (${f.orgId}, 'chwn-001', 'Legacy wings', 'raw_material', 'kg', ${f.createdBy})`;
      const made = await create(f, f.superAdmin, { name: 'Chicken wings' });
      expect(await codeOf(made.id)).toBe('CHWN-002');
    },
    60_000,
  );
});

describe("R - rename: the item's own code typed in another case is unchanged", () => {
  it(
    'R9: a super-admin typing the item\'s own current code in lower case ("ck15-001" for CK15-001) is treated as unchanged, not refused: name and code unchanged -> {changed:false}, no audit; a name change with the code typed in lower case goes through with the code kept and the mark untouched. Mutant: compare the typed code to item.code case-sensitively -> it is read as an override and refused as "cannot be used", red',
    async () => {
      const f = await fixture('ar9');
      const id = (await create(f, f.superAdmin, { name: 'Coke 1.5' })).id;
      expect(await codeOf(id)).toBe('CK15-001');
      expect(await rename(f, f.superAdmin, id, 'Coke 1.5', 'ck15-001')).toEqual({ changed: false });
      expect(await auditRows(id)).toHaveLength(0);
      expect(await rename(f, f.superAdmin, id, 'Coke 1.5 (x)', ' ck15-001 ')).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5 (x)', code: 'CK15-001' });
      expect(await markOf(f, 'CK15')).toBe(1);
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ before: { code: 'CK15-001' }, after: { code: 'CK15-001' } });
    },
    60_000,
  );
});

describe('S - suggestItemCode (spec R9): read-only', () => {
  it(
    'S1: with CHWN-001 (active) and CHWN-002 (retired) existing, "Chicken wings." -> { stem CHWN, code CHWN-003, full false, sameStem [both, with statuses, ordered by code] }. Mutants: statuses dropped; active only -> red. Red today: suggestItemCode is not a function',
    async () => {
      const f = await fixture('s1');
      const a = await create(f, f.superAdmin, { name: 'Chicken wings' });
      const b = await create(f, f.superAdmin, { name: 'Chicken winglets' });
      await sql`update items set status = 'inactive' where id = ${b.id}`;
      const s = await suggest(f, f.manager, 'Chicken wings.');
      expect(s).toMatchObject({ stem: 'CHWN', code: 'CHWN-003', full: false });
      expect(s.sameStem).toEqual([
        { id: a.id, code: 'CHWN-001', name: 'Chicken wings', status: 'active' },
        { id: b.id, code: 'CHWN-002', name: 'Chicken winglets', status: 'inactive' },
      ]);
    },
    60_000,
  );

  it(
    'S2: writes nothing: a fresh stem suggests STEM-001 and creates NO counter row (count(*) of the counters unchanged); a repeat call gives the same answer. Mutant: the suggestion goes through lockItemCodeStem (which ensures the row) -> a counter row appears, red. Red today: not a function',
    async () => {
      const f = await fixture('s2');
      const before = await counterRows(f);
      const s1 = await suggest(f, f.manager, 'Gochujang');
      const s2 = await suggest(f, f.manager, 'Gochujang');
      expect(s1).toMatchObject({ stem: 'GCHJ', code: 'GCHJ-001', full: false, sameStem: [] });
      expect(s2).toEqual(s1);
      expect(await counterRows(f)).toBe(before);
      expect(await itemCount(f)).toBe(0);
    },
    60_000,
  );

  it(
    'S3: forItemId: the CHWN-001 item asked about its own name returns its own code CHWN-001 and excludes itself from sameStem; asked about a new name with the same stem it returns the next number. Mutant: forItemId ignored -> CHWN-002 and itself listed, red. Red today: not a function',
    async () => {
      const f = await fixture('s3');
      const a = await create(f, f.superAdmin, { name: 'Chicken wings' });
      const b = await create(f, f.superAdmin, { name: 'Chicken winglets' });
      const own = await suggest(f, f.superAdmin, 'Chicken wings', a.id);
      expect(own).toMatchObject({ stem: 'CHWN', code: 'CHWN-001' });
      expect(own.sameStem.map((x) => x.id)).toEqual([b.id]);
      const tips = await suggest(f, f.superAdmin, 'Chicken wing tips', a.id);
      expect(tips).toMatchObject({ stem: 'CHWT', code: 'CHWT-001', sameStem: [] });
    },
    60_000,
  );

  it(
    'S4: a full stem -> { full: true, code: null }; a name with no letters or numbers -> { stem: null, code: null, full: false, sameStem: [] } (the form shows nothing, the save refuses). (code null for full is the planner\'s "{STEM}-???" read; spec R9 says string | null.) Red today: not a function',
    async () => {
      const f = await fixture('s4');
      await create(f, f.superAdmin, { name: 'Chicken wings', code: 'CHWN-999' });
      const full = await suggest(f, f.manager, 'Chicken wings.');
      expect(full).toMatchObject({ stem: 'CHWN', code: null, full: true });
      const none = await suggest(f, f.manager, '--');
      expect(none).toEqual({ stem: null, code: null, full: false, sameStem: [] });
    },
    60_000,
  );

  it(
    'S5: authorisation: a manager is allowed (manage_items); staff -> AuthorizationError. sameStem lists at most 10, ordered by code. Mutant: authorize approve_item -> manager refused, red; no limit -> 12 listed, red. Red today: not a function',
    async () => {
      const f = await fixture('s5');
      for (let i = 1; i <= 12; i++) await create(f, f.superAdmin, { name: `Coffee${'.'.repeat(i)}` });
      const s = await suggest(f, f.manager, 'Coffee');
      expect(s.stem).toBe('COFF');
      expect(s.sameStem).toHaveLength(10);
      expect(s.sameStem.map((x) => x.code)).toEqual(Array.from({ length: 10 }, (_, i) => `COFF-${String(i + 1).padStart(3, '0')}`));
      expect(s.code).toBe('COFF-013');
      expect(await failure(suggest(f, f.staff, 'Coffee'))).toBeInstanceOf(AuthorizationError);
    },
    120_000,
  );

  it(
    'S6: scoped to the caller\'s org: another org\'s CHWN-001 is neither counted in the suggestion nor listed. Mutant: query without org_id -> red. Red today: not a function',
    async () => {
      const a = await fixture('s6a');
      const b = await fixture('s6b');
      await create(a, a.superAdmin, { name: 'Chicken wings' });
      const s = await suggest(b, b.manager, 'Chicken wings');
      expect(s).toMatchObject({ code: 'CHWN-001', sameStem: [] });
    },
    60_000,
  );
});

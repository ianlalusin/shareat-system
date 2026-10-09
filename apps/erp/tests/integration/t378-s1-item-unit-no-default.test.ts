/**
 * T-378 S1 (DEF-598) - `docs/tasks/378-item-unit-editable.md` S1, R1. TESTER file.
 *
 * Nobody gets a unit (or kind) they did not pick: the request/create form starts blank, and a
 * blank or unknown unit is refused by the database CHECKs in a plain sentence.
 *
 * Real Postgres, real `@shareat/auth`, real page render and real actions. Only `requireSession` /
 * `requireActor`, `next/navigation` and the Next.js path aliases are mocked (t350-s2 and
 * t365 precedent).
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!,
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: () => null }));

import { BASE_UNITS, ITEM_KINDS } from '@shareat/db';
import { paramsOf } from '../helpers/flash-jar';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const UNIT_SENTENCE = 'Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t378s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Store') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { orgId, personId: p!.id };
  };
  return { orgId, superAdmin: await mk('Super', 'super_admin'), admin: await mk('Admin', 'admin') };
}

async function redirectOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let ItemsPage: typeof import('../../src/app/items/page').default;
let actions: typeof import('../../src/app/items/actions');

beforeAll(async () => {
  ItemsPage = (await import('../../src/app/items/page')).default;
  actions = await import('../../src/app/items/actions');
}, 30_000);

/** The `<select name=...>` element's opening tag, and its options as {value, selected, text}. */
function selectOf(html: string, name: string) {
  const m = html.match(new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) throw new Error(`no <select name="${name}"> in the /items render`);
  const tag = /^<select\b[^>]*>/.exec(m[0])?.[0] ?? '';
  const options = [...(m[1] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((o) => ({
    value: /\bvalue="([^"]*)"/.exec(o[1] ?? '')?.[1] ?? null,
    selected: /\bselected(=|\s|$)/.test(o[1] ?? ''),
    text: o[2] ?? '',
  }));
  return { tag, options };
}

async function itemsHtml(hint: string): Promise<string> {
  const f = await fixture(hint);
  ACTOR_HOLDER.actor = f.superAdmin;
  const el = await ItemsPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}

describe('U1 - the unit and kind selects start blank', () => {
  it(
    'baseUnit: first option is value="" "Choose a unit", it alone is selected, required, options exactly BASE_UNITS. Killing mutants: restore defaultValue="kg" / drop required. Red today: kg is selected, no blank option',
    async () => {
      const { tag, options } = selectOf(await itemsHtml('u1'), 'baseUnit');
      expect(options[0], 'first option').toMatchObject({ value: '', text: 'Choose a unit', selected: true });
      expect(options.filter((o) => o.selected).map((o) => o.value), 'only the blank is selected').toEqual(['']);
      expect(tag, 'required').toMatch(/\brequired\b/);
      expect(options.slice(1).map((o) => o.value)).toEqual([...BASE_UNITS]);
    },
    30_000,
  );

  it(
    'kind: first option is value="" "Choose a kind", it alone is selected, required, options exactly ITEM_KINDS. Killing mutant: restore defaultValue="raw_material". Red today: raw_material is selected',
    async () => {
      const { tag, options } = selectOf(await itemsHtml('u1b'), 'kind');
      expect(options[0], 'first option').toMatchObject({ value: '', text: 'Choose a kind', selected: true });
      expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual(['']);
      expect(tag, 'required').toMatch(/\brequired\b/);
      expect(options.slice(1).map((o) => o.value)).toEqual([...ITEM_KINDS]);
    },
    30_000,
  );
});

describe('U2-U4 - a blank or unknown unit is refused in a sentence', () => {
  it(
    "U2: requestItemAction with baseUnit '' -> the unit sentence, and no item_requests row. Killing mutants: delete the item_requests_base_unit_check entry (generic sentence) / action writes `|| 'kg'` (a row exists). Red today: generic fallback sentence",
    async () => {
      const f = await fixture('u2');
      ACTOR_HOLDER.actor = f.admin;
      const name = uid('Coke 1.5');
      const to = await redirectOf(() =>
        actions.requestItemAction(form({ name, code: uid('COKE'), kind: 'retail', baseUnit: '', reason: '' })),
      );
      expect(param(to, 'error')).toBe(UNIT_SENTENCE);
      expect(param(to, 'ok')).toBeNull();
      const rows = await sql`select 1 from item_requests where org_id = ${f.orgId} and name = ${name}`;
      expect(rows.length).toBe(0);
    },
    30_000,
  );

  it(
    'U3: createItemAction (super-admin) with baseUnit "box" -> the same sentence via items_base_unit_check, and no items row. Killing mutant: delete the items_base_unit_check entry. Red today: generic fallback sentence',
    async () => {
      const f = await fixture('u3');
      ACTOR_HOLDER.actor = f.superAdmin;
      const name = uid('Box thing');
      const to = await redirectOf(() =>
        actions.createItemAction(form({ name, code: testItemCode(), kind: 'raw_material', baseUnit: 'box' })),
      );
      expect(param(to, 'error')).toBe(UNIT_SENTENCE);
      const rows = await sql`select 1 from items where org_id = ${f.orgId} and name = ${name}`;
      expect(rows.length).toBe(0);
    },
    30_000,
  );

  it(
    'U4 (control, green today): baseUnit "pcs" -> ok redirect, and the request row keeps base_unit = pcs',
    async () => {
      const f = await fixture('u4');
      ACTOR_HOLDER.actor = f.admin;
      const name = uid('Coke 1.5');
      const to = await redirectOf(() =>
        actions.requestItemAction(form({ name, code: uid('COKE'), kind: 'retail', baseUnit: 'pcs', reason: '' })),
      );
      expect(param(to, 'error')).toBeNull();
      expect(param(to, 'ok')).toMatch(/Request submitted/);
      const rows = await sql<{ base_unit: string }[]>`select base_unit from item_requests where org_id = ${f.orgId} and name = ${name}`;
      expect(rows.map((r) => r.base_unit)).toEqual(['pcs']);
    },
    30_000,
  );
});

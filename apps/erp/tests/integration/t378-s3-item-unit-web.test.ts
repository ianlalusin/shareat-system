/**
 * T-378 S3 (DEF-598, DEF-599) - `docs/tasks/378-item-unit-editable.md` S3, web legs W1-W5. TESTER file.
 *
 * Real Postgres, real `@shareat/auth`, real page renders and real actions. Only `requireSession` /
 * `requireActor`, `next/navigation` and the Next.js path aliases are mocked (t378-s1, t350-s2 and
 * t365 precedent). Each test names its killing mutant and why it is red on HEAD.
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
  notFound: () => {
    throw new Error('notFound');
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

import { BASE_UNITS } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const LOCKED_SENTENCE =
  "This item's unit can no longer change: it already has stock, counts, invoices, recipes, prices or orders " +
  'recorded in its current unit, and changing it would re-read every one of them in the new unit.';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t378w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Store') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { orgId, personId: p!.id };
  };
  return {
    orgId, storeId: store!.id,
    superAdmin: await mk('Super', 'super_admin'),
    admin: await mk('Admin', 'admin'),
    manager: await mk('Manager', 'manager'),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function insertItem(f: Fixture, baseUnit: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${f.orgId}, ${uid('IT')}, ${`Item ${uid('n')}`}, 'raw_material', ${baseUnit}, ${f.superAdmin.personId})
    returning id`;
  return row!.id;
}
/** History through the cheapest blocking reference (store_item_thresholds, C2 row 13). */
async function giveHistory(f: Fixture, itemId: string): Promise<void> {
  await sql`insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by)
            values (${f.orgId}, ${f.storeId}, ${itemId}, 1, ${f.superAdmin.personId})`;
}
const unitOf = async (id: string) =>
  (await sql<{ base_unit: string }[]>`select base_unit from items where id = ${id}`)[0]!.base_unit;

async function redirectOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => new URL(to, 'http://localhost').searchParams.get(k);
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let ItemsPage: typeof import('../../src/app/items/page').default;
let ItemDetailPage: typeof import('../../src/app/items/[id]/page').default;
let actions: typeof import('../../src/app/items/actions');
let errorMessage: typeof import('../../src/lib/constraint-messages').errorMessage;

beforeAll(async () => {
  ItemsPage = (await import('../../src/app/items/page')).default;
  ItemDetailPage = (await import('../../src/app/items/[id]/page')).default;
  actions = await import('../../src/app/items/actions');
  errorMessage = (await import('../../src/lib/constraint-messages')).errorMessage;
}, 60_000);

async function itemsHtml(f: Fixture): Promise<string> {
  ACTOR_HOLDER.actor = f.superAdmin;
  return renderToStaticMarkup((await ItemsPage({ searchParams: Promise.resolve({}) })) as never);
}
async function detailHtml(f: Fixture, id: string): Promise<string> {
  ACTOR_HOLDER.actor = f.superAdmin;
  const el = await ItemDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}
/** The `<form>` blocks of a render (forms do not nest). */
const formsOf = (html: string) => [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => m[0]);
function selectIn(block: string, name: string) {
  const m = block.match(new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) return null;
  const options = [...(m[1] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((o) => ({
    value: /\bvalue="([^"]*)"/.exec(o[1] ?? '')?.[1] ?? null,
    selected: /\bselected(=|\s|$)/.test(o[1] ?? ''),
  }));
  return { options };
}

describe('W1 - the item page: a unit form until the item has history, the locked sentence after', () => {
  it(
    'no history: a baseUnit select with the current unit (ltr) selected, options exactly BASE_UNITS, a "Change unit" button, and an itemId hidden input. Killing mutant: the page ignores unitHistoryExists (history leg, below). Red today: no such form',
    async () => {
      const f = await fixture('w1a');
      const id = await insertItem(f, 'ltr');
      const block = formsOf(await detailHtml(f, id)).find((b) => /Change unit/.test(b));
      expect(block, 'a form with a Change unit button').toBeDefined();
      const sel = selectIn(block!, 'baseUnit');
      expect(sel, 'baseUnit select').not.toBeNull();
      expect(sel!.options.filter((o) => o.selected).map((o) => o.value)).toEqual(['ltr']);
      expect(sel!.options.map((o) => o.value)).toEqual([...BASE_UNITS]);
      expect(block).toMatch(new RegExp(`<input[^>]*name="itemId"[^>]*value="${id}"|<input[^>]*value="${id}"[^>]*name="itemId"`));
    },
    60_000,
  );

  it(
    'with history: no baseUnit select anywhere, no Change unit button, and the locked sentence shown. Killing mutant: the page ignores unitHistoryExists (the form still renders). Red today: the sentence is absent',
    async () => {
      const f = await fixture('w1b');
      const id = await insertItem(f, 'ltr');
      await giveHistory(f, id);
      const html = await detailHtml(f, id);
      expect(html).not.toMatch(/<select\b[^>]*name="baseUnit"/);
      expect(html).not.toMatch(/Change unit/);
      expect(decode(html)).toContain(LOCKED_SENTENCE);
    },
    60_000,
  );
});

describe('W2 - changeItemUnitAction', () => {
  it(
    'super-admin, no history -> ok "Unit changed to pcs." and the unit is pcs. Killing mutant: action does not call changeItemBaseUnit. Red today: the action does not exist',
    async () => {
      const f = await fixture('w2a');
      const id = await insertItem(f, 'kg');
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'pcs' })));
      expect(param(to, 'ok')).toBe('Unit changed to pcs.');
      expect(await unitOf(id)).toBe('pcs');
    },
    60_000,
  );

  it(
    'unchanged unit -> ok "The unit is already kg." Killing mutant: the no-change branch reports a change. Red today: the action does not exist',
    async () => {
      const f = await fixture('w2c');
      const id = await insertItem(f, 'kg');
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'kg' })));
      expect(param(to, 'ok')).toBe('The unit is already kg.');
    },
    60_000,
  );

  it(
    'super-admin, with history -> error is the locked sentence, unit unchanged. Killing mutant: trigger CONSTRAINT renamed or the key dropped from CONSTRAINT_MESSAGES (generic sentence). Red today: the action does not exist',
    async () => {
      const f = await fixture('w2b');
      const id = await insertItem(f, 'kg');
      await giveHistory(f, id);
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'pcs' })));
      expect(param(to, 'error')).toBe(LOCKED_SENTENCE);
      expect(await unitOf(id)).toBe('kg');
    },
    60_000,
  );

  it(
    'manager -> the super-admin sentence (T-378 S4 S4-R2 supersedes the generic approve_item sentence), unit unchanged. Killing mutant: authorize(..., "manage_items") or the AuthorizationError mapping dropped. Red today: the action does not exist',
    async () => {
      const f = await fixture('w2d');
      const id = await insertItem(f, 'kg');
      ACTOR_HOLDER.actor = f.manager;
      // T-378 S4 (DEF-600): was the generic "Your role (Manager) can't approve a new item..." sentence.
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'pcs' })));
      expect(param(to, 'error')).toBe("Only a super-admin can change an item's unit.");
      expect(await unitOf(id)).toBe('kg');
    },
    60_000,
  );
});

describe('W3 - requestItemAction carries the three ticks (DEF-599, the form path)', () => {
  const legs = [
    { tick: 'isPurchasable', fields: {}, want: [false, false, false], mutant: 'the action omits the isPurchasable flag() (DB default true)' },
    { tick: 'sellableRetail', fields: { isPurchasable: 'on', sellableRetail: 'on' }, want: [true, true, false], mutant: 'the action omits the sellableRetail flag()' },
    { tick: 'sellableWholesale', fields: { isPurchasable: 'on', sellableWholesale: 'on' }, want: [true, false, true], mutant: 'the action omits the sellableWholesale flag()' },
  ] as const;
  for (const leg of legs) {
    it(
      `${leg.tick}: posted ${JSON.stringify(leg.fields)} -> item_requests (is_purchasable, sellable_retail, sellable_wholesale) = ${JSON.stringify(leg.want)}. Killing mutant: ${leg.mutant}. Red today: the row has the column defaults`,
      async () => {
        const f = await fixture(`w3${leg.tick}`);
        ACTOR_HOLDER.actor = f.admin;
        const name = uid('Coke 1.5');
        const to = await redirectOf(() =>
          actions.requestItemAction(form({ name, code: uid('COKE'), kind: 'retail', baseUnit: 'pcs', reason: '', ...leg.fields })),
        );
        expect(param(to, 'error')).toBeNull();
        const [r] = await sql<{ a: boolean; b: boolean; c: boolean }[]>`
          select is_purchasable a, sellable_retail b, sellable_wholesale c from item_requests
          where org_id = ${f.orgId} and name = ${name}`;
        expect([r!.a, r!.b, r!.c]).toEqual([...leg.want]);
      },
      60_000,
    );
  }
});

describe('W4 - the approve form confirms the unit and flags (R5)', () => {
  async function pendingRequest(f: Fixture, baseUnit: string, wholesale: boolean): Promise<{ id: string; name: string }> {
    const name = uid('Pending');
    const [r] = await sql<{ id: string }[]>`
      insert into item_requests (org_id, name, code, kind, base_unit, sellable_wholesale, requested_by)
      values (${f.orgId}, ${name}, ${uid('PQ')}, 'retail', ${baseUnit}, ${wholesale}, ${f.manager.personId})
      returning id`;
    return { id: r!.id, name };
  }

  it(
    'a pending pcs request with wholesale ticked -> its approve form has a baseUnit select with pcs selected and the wholesale checkbox checked. Killing mutant: the approve form omits the select (or the defaultChecked). Red today: no select, no checkbox',
    async () => {
      const f = await fixture('w4a');
      const req = await pendingRequest(f, 'pcs', true);
      const block = formsOf(await itemsHtml(f)).find((b) => b.includes(`value="${req.id}"`) && /Approve/.test(b));
      expect(block, 'the approve form').toBeDefined();
      const sel = selectIn(block!, 'baseUnit');
      expect(sel, 'baseUnit select in the approve form').not.toBeNull();
      expect(sel!.options.filter((o) => o.selected).map((o) => o.value)).toEqual(['pcs']);
      const box = /<input\b[^>]*name="sellableWholesale"[^>]*>/.exec(block!)?.[0] ?? '';
      expect(box, 'wholesale checkbox').toMatch(/\bchecked\b/);
      const retail = /<input\b[^>]*name="sellableRetail"[^>]*>/.exec(block!)?.[0] ?? '';
      expect(retail, 'retail checkbox exists and is not pre-ticked').toMatch(/name="sellableRetail"/);
      expect(retail).not.toMatch(/\bchecked\b/);
    },
    60_000,
  );

  it(
    'approveItemRequestAction with baseUnit=kg and sellableRetail=on on a pcs request -> the new item is kg and retail. Killing mutant: the action does not read baseUnit / sellableRetail. Red today: the item is pcs, not retail',
    async () => {
      const f = await fixture('w4b');
      const req = await pendingRequest(f, 'pcs', false);
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() =>
        actions.approveItemRequestAction(form({ requestId: req.id, baseUnit: 'kg', sellableRetail: 'on' })),
      );
      expect(param(to, 'error')).toBeNull();
      const [it] = await sql<{ base_unit: string; sellable_retail: boolean }[]>`
        select base_unit, sellable_retail from items where org_id = ${f.orgId} and name = ${req.name}`;
      expect(it).toMatchObject({ base_unit: 'kg', sellable_retail: true });
    },
    60_000,
  );
});

describe('W5 - the small print', () => {
  it(
    'no longer says "a request carries only name, kind and unit". Killing mutant: the old small print restored. Red today: it is there',
    async () => {
      const f = await fixture('w5');
      const html = decode(await itemsHtml(f)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
      expect(html).not.toMatch(/a request carries only name, kind and unit/);
    },
    60_000,
  );
});

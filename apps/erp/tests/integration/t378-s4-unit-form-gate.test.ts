/**
 * T-378 S4 (DEF-600) - `docs/tasks/378-item-unit-editable.md` S4, legs G1-G4. TESTER file.
 *
 * Real Postgres, real `@shareat/auth`, real page renders and real actions. Only `requireSession` /
 * `requireActor`, `next/navigation` and the Next.js path aliases are mocked (t378-s1, t350-s2 and
 * t365 precedent). Each test names its killing mutant and why it is red on HEAD.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { paramsOf } from '../helpers/flash-jar';

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


const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const NOT_SUPER_ADMIN = "Only a super-admin can change an item's unit.";
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
const param = (to: string, k: string) => paramsOf(to).get(k);
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}


let ItemDetailPage: typeof import('../../src/app/items/[id]/page').default;
let actions: typeof import('../../src/app/items/actions');

beforeAll(async () => {
  ItemDetailPage = (await import('../../src/app/items/[id]/page')).default;
  actions = await import('../../src/app/items/actions');
}, 60_000);

async function detailHtmlAs(actor: { orgId: string; personId: string }, id: string): Promise<string> {
  ACTOR_HOLDER.actor = actor;
  const el = await ItemDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}
/** Precondition, asked of the REAL gate: this actor does / does not hold approve_item. */
async function holdsApproveItem(f: Fixture, actor: { orgId: string; personId: string }): Promise<boolean> {
  const { authorize, AuthorizationError } = await import('@shareat/auth');
  const { withOrgPrincipal } = await import('@shareat/db');
  return withOrgPrincipal(f.orgId, async (tx) => {
    try {
      await authorize(tx, actor, 'approve_item', {});
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  });
}

describe('G1/G2 - the change-unit form is drawn only for who may use it', () => {
  for (const who of ['manager', 'admin'] as const) {
    it(
      `G1 (${who}): no history -> no baseUnit select, no Change unit button, the sentence shown. Killing mutant: drop the authorize gate in page.tsx (form drawn for everyone). Red today: the form is drawn`,
      async () => {
        const f = await fixture(`g1${who}`);
        expect(await holdsApproveItem(f, f[who]), `${who} must lack approve_item`).toBe(false);
        const id = await insertItem(f, 'kg');
        const html = await detailHtmlAs(f[who], id);
        expect(html).not.toMatch(/<select\b[^>]*name="baseUnit"/);
        expect(html).not.toMatch(/Change unit/);
        expect(decode(html)).toContain(NOT_SUPER_ADMIN);
      },
      60_000,
    );
  }

  it(
    'G2 (control): a super-admin on a no-history item sees the form and not the refusal sentence. Killing mutant: the gate inverted or always false. Green today and after',
    async () => {
      const f = await fixture('g2');
      expect(await holdsApproveItem(f, f.superAdmin), 'super-admin must hold approve_item').toBe(true);
      const id = await insertItem(f, 'kg');
      const html = await detailHtmlAs(f.superAdmin, id);
      expect(html).toMatch(/<select\b[^>]*name="baseUnit"/);
      expect(html).toMatch(/Change unit/);
      expect(decode(html)).not.toContain(NOT_SUPER_ADMIN);
    },
    60_000,
  );
});

describe('G3/G4 - changeItemUnitAction names the real reason', () => {
  it(
    'G3: an admin (no approve_item) -> the error is exactly the super-admin sentence, unit unchanged. Killing mutant: drop the AuthorizationError mapping (generic approve_item sentence). Red today: generic sentence',
    async () => {
      const f = await fixture('g3');
      expect(await holdsApproveItem(f, f.admin), 'admin must lack approve_item').toBe(false);
      const id = await insertItem(f, 'kg');
      ACTOR_HOLDER.actor = f.admin;
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'pcs' })));
      expect(param(to, 'error')).toBe(NOT_SUPER_ADMIN);
      expect(await unitOf(id)).toBe('kg');
    },
    60_000,
  );

  it(
    'G4: a super-admin on an item WITH history still gets the locked sentence, not the super-admin one. Killing mutant: the mapping catches every error. Green today and after',
    async () => {
      const f = await fixture('g4');
      const id = await insertItem(f, 'kg');
      await giveHistory(f, id);
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.changeItemUnitAction(form({ itemId: id, baseUnit: 'pcs' })));
      expect(param(to, 'error')).toBe(LOCKED_SENTENCE);
      expect(param(to, 'error')).not.toBe(NOT_SUPER_ADMIN);
      expect(await unitOf(id)).toBe('kg');
    },
    60_000,
  );
});

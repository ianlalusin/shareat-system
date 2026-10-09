/**
 * T-383 S1 - `docs/tasks/383-item-rename.md` S1, web legs W1-W3. TESTER file.
 *
 * Real Postgres, real `@shareat/auth`, real page renders and real actions. Only `requireSession` /
 * `requireActor`, `next/navigation` and the Next.js path aliases are mocked (t378-s4 precedent).
 * Each test names its killing mutant and why it is red on HEAD.
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

// T-383 S2a (B2.4): retire and restore are super-admin only too, so one combined sentence covers all three (W5b).
const NOT_SUPER_ADMIN = 'Only a super-admin can rename, retire or restore an item.';
const MERGED_SENTENCE = 'This item was merged into another, so it cannot be retired or restored.';
const DUP_NAME =
  'An item with that name already exists — names are one per organisation, ignoring case. To reuse the name, rename the existing item on its page first.';
// Shared by createItem and the request actions: the readers are not all super-admins, so no 'on its page' hint.
const SHARED_DUP_NAME =
  'An item with that name already exists — names are one per organisation, ignoring case. To reuse the name, ask a super-admin to rename the existing item first.';
const BLANK_NAME = 'Give the item a name people will recognise.';
const BLANK_CODE = 'Give the item a code.';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t383w-${hint}`);
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

async function insertItem(f: Fixture, name: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${f.orgId}, ${code}, ${name}, 'raw_material', 'kg', ${f.superAdmin.personId})
    returning id`;
  return row!.id;
}
const rowOf = async (id: string) =>
  (await sql<{ name: string; code: string }[]>`select name, code from items where id = ${id}`)[0]!;

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
/** The opening tag of the first <input> with this name, or null. */
const inputTag = (html: string, name: string): string | null =>
  new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? null;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let ItemDetailPage: typeof import('../../src/app/items/[id]/page').default;
// `renameItemAction` does not exist at HEAD: typed loosely so each test fails on its BEHAVIOUR (TypeError), not at import.
let actions: typeof import('../../src/app/items/actions') & {
  renameItemAction: (fd: FormData) => Promise<void>;
  setItemStatusAction: (fd: FormData) => Promise<void>; // T-383 S2a: does not exist at HEAD
};

beforeAll(async () => {
  ItemDetailPage = (await import('../../src/app/items/[id]/page')).default;
  actions = (await import('../../src/app/items/actions')) as never;
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

describe('W1 - the Name and code form is drawn only for who may use it', () => {
  it(
    'W1 (super-admin): name and code inputs hold the item values and are required, a hidden itemId, an Edit button (locked until Edit, Amendment A0). Killing mutants: required dropped; defaultValue dropped. Red today: no such inputs',
    async () => {
      const f = await fixture('w1s');
      expect(await holdsApproveItem(f, f.superAdmin), 'super-admin must hold approve_item').toBe(true);
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      const html = await detailHtmlAs(f.superAdmin, id);
      const name = inputTag(html, 'name');
      const code = inputTag(html, 'code');
      expect(name, 'a name input').not.toBeNull();
      expect(code, 'a code input').not.toBeNull();
      expect(name).toMatch(/value="Coke 1\.5"/);
      expect(code).toMatch(/value="CK15-001"/);
      expect(name).toMatch(/\brequired\b/);
      expect(code).toMatch(/\brequired\b/);
      const hidden = inputTag(html, 'itemId');
      expect(hidden).toMatch(/type="hidden"/);
      expect(hidden).toContain(id);
      expect(html).toMatch(/<fieldset disabled/);
      expect(html).toMatch(/aria-label="Edit [^"]*"[^>]*>Edit</);
      expect(html).not.toMatch(/>Rename</);
      expect(html).not.toMatch(/\b(w-64|w-40)\b/);
    },
    60_000,
  );

  for (const who of ['manager', 'admin'] as const) {
    it(
      `W1 (${who}): no name input, no Edit button, the sentence shown. Killing mutant: drop the gate (form drawn for everyone). Red today: the sentence is absent`,
      async () => {
        const f = await fixture(`w1${who}`);
        expect(await holdsApproveItem(f, f[who]), `${who} must lack approve_item`).toBe(false);
        const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
        const html = await detailHtmlAs(f[who], id);
        expect(inputTag(html, 'name')).toBeNull();
        expect(html).not.toMatch(/>Rename</);
        // 2026-10-09, T-384 sweep fallout: the page now carries other EditableRecords (unit, organisation default), so
        // "no Edit button" is scoped to the RENAME record, whose label is exactly the item name.
        expect(html).not.toMatch(/aria-label="Edit Coke 1\.5"[^>]*>Edit</);
        expect(decode(html)).toContain(NOT_SUPER_ADMIN);
      },
      60_000,
    );
  }
});

describe('W2 - renameItemAction', () => {
  it(
    'W2: super-admin -> ok "Renamed." and the row is renamed; the same values again -> ok "Nothing to change." Red today: renameItemAction is not a function',
    async () => {
      const f = await fixture('w2a');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Coke 1.5 (old)', code: 'CK1O-001' })));
      expect(param(to, 'ok')).toBe('Renamed.');
      expect(await rowOf(id)).toEqual({ name: 'Coke 1.5 (old)', code: 'CK1O-001' });
      const again = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Coke 1.5 (old)', code: 'CK1O-001' })));
      expect(param(again, 'ok')).toBe('Nothing to change.');
    },
    60_000,
  );

  it(
    'W2: duplicate name -> error is the new name sentence (with the way out); duplicate code -> the new code sentence; row unchanged. Killing mutant: errorMessage keeps the old sentences. Red today: not a function',
    async () => {
      const f = await fixture('w2b');
      await insertItem(f, 'Pepsi 1.5', 'PEPS-001');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const byName = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'pepsi 1.5', code: 'CK15-001' })));
      expect(param(byName, 'error')).toBe(DUP_NAME);
      const byCode = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Coke 1.5', code: 'PEPS-001' })));
      expect(param(byCode, 'error')).toMatch(/^PEPS-001 cannot be used: /);
      expect(await rowOf(id)).toEqual({ name: 'Coke 1.5', code: 'CK15-001' });
    },
    60_000,
  );

  it(
    'W2b: blank name -> error is the blank-name sentence, blank code -> the blank-code sentence (CONSTRAINT_MESSAGES keys); row unchanged. Killing mutant: name || item.name (silent no-op, no error). Red today: not a function',
    async () => {
      const f = await fixture('w2c');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const n = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: '   ', code: 'CK15-001' })));
      expect(param(n, 'error')).toBe(BLANK_NAME);
      const c = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Coke 1.5', code: '' })));
      expect(param(c, 'error')).toBe(BLANK_CODE);
      expect(await rowOf(id)).toEqual({ name: 'Coke 1.5', code: 'CK15-001' });
    },
    60_000,
  );

  for (const who of ['manager', 'admin'] as const) {
    it(
      `W2 (${who}): the error is exactly the super-admin sentence and the name is unchanged. Killing mutant: drop the AuthorizationError mapping (generic approve_item sentence). Red today: not a function`,
      async () => {
        const f = await fixture(`w2${who}`);
        expect(await holdsApproveItem(f, f[who]), `${who} must lack approve_item`).toBe(false);
        const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
        ACTOR_HOLDER.actor = f[who];
        const to = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Coke 1.5 (old)', code: 'CK1O-001' })));
        expect(param(to, 'error')).toBe(NOT_SUPER_ADMIN);
        expect(await rowOf(id)).toEqual({ name: 'Coke 1.5', code: 'CK15-001' });
      },
      60_000,
    );
  }
});

describe('W3 - the create form tells you how to reuse a taken name or code', () => {
  it(
    'W3: createItemAction with a taken name -> error is the new name sentence; a taken code -> the new code sentence. Killing mutant: the old sentences. Red today: the old sentences',
    async () => {
      const f = await fixture('w3');
      await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const byName = await redirectOf(() =>
        actions.createItemAction(form({ code: 'NEWX-001', name: 'coke 1.5', kind: 'raw_material', baseUnit: 'pcs' })),
      );
      expect(param(byName, 'error')).toBe(SHARED_DUP_NAME);
      const byCode = await redirectOf(() =>
        actions.createItemAction(form({ code: 'CK15-001', name: 'Something else', kind: 'raw_material', baseUnit: 'pcs' })),
      );
      expect(param(byCode, 'error')).toMatch(/^CK15-001 cannot be used: /);
    },
    60_000,
  );

  it(
    "W3b: a manager who submits the duplicate (createItemAction; requestItemAction accepts an exact duplicate as a request, so it raises no duplicate error) is never told to rename 'on its page' (they cannot). Guards the shared errorMessage against leaking the page hint to non-super-admins. Green against a2fd5c3 (their refusal is an authorization sentence); kept as the regression guard",
    async () => {
      const f = await fixture('w3b');
      await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.manager;
      const to = await redirectOf(() =>
        actions.createItemAction(form({ code: 'CK15-001', name: 'Coke 1.5', kind: 'raw_material', baseUnit: 'pcs' })),
      );
      const err = param(to, 'error') ?? '';
      expect(err).not.toBe('');
      expect(err).not.toContain('on its page');
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// T-383 S2a (Amendment B2.4): the Retire section and setItemStatusAction. Red today: no section, no action.
// ---------------------------------------------------------------------------------------------------------------
async function stockRoom(f: Fixture, storeId: string): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${f.orgId}, ${uid('lt')}, 'Stockroom') returning id`;
  const [l] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${storeId}, ${uid('loc')}, 'Kitchen', ${t!.id}, 'operating', true, ${f.superAdmin.personId}) returning id`;
  return l!.id;
}
async function stockAt(f: Fixture, storeId: string, itemId: string, qty: string): Promise<void> {
  const [existing] = await sql<{ id: string }[]>`select id from stock_locations where store_id = ${storeId} limit 1`;
  const loc = existing?.id ?? (await stockRoom(f, storeId));
  await sql`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${f.orgId}, ${storeId}, ${loc}, ${itemId}, now(), ${qty}, 'receipt', 'test', ${crypto.randomUUID()}, ${f.superAdmin.personId})`;
}
async function otherStore(f: Fixture, name: string): Promise<string> {
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('st')}, ${name}) returning id`;
  return s!.id;
}
async function liveMap(f: Fixture, itemId: string): Promise<void> {
  await sql`
    insert into pos_item_maps (org_id, store_id, pos_item_key, pos_item_name, mode, item_id, quantity_per_sale, status, created_by)
    values (${f.orgId}, ${f.storeId}, ${uid('pk')}, 'POS Coke', 'direct', ${itemId}, 1, 'active', ${f.superAdmin.personId})`;
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from items where id = ${id}`)[0]!.status;
const retireAudit = (id: string) =>
  sql<{ action: string }[]>`select action from audit_log where entity = 'items' and entity_id = ${id} and action in ('retire_item','restore_item') order by occurred_at, id`;

describe('W4 - the Retire section', () => {
  it(
    'W4 (super-admin, active item): with +5 at one store, +3 then -3 at another (net zero) and one live POS map, the section lists the first store with its quantity and unit, the map line with the B2 wording, and not the net-zero store; it carries the explanatory line, a Retire button, and a hidden status=inactive. Killing mutants: readout without HAVING (the net-zero store appears); POS-map line wording; drop the gate (W4 manager leg). Red today: no Retire section',
    async () => {
      const f = await fixture('w4');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      const zulu = await otherStore(f, 'Zulu');
      await stockAt(f, f.storeId, id, '5');
      await stockAt(f, zulu, id, '3');
      await stockAt(f, zulu, id, '-3');
      await liveMap(f, id);
      expect(await holdsApproveItem(f, f.superAdmin)).toBe(true);
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      expect(html).toMatch(/Still holds stock at: Store \(5(\.0+)? kg\)/);
      expect(html).toContain('It stays on count sheets until counted out.');
      // The sellability section lists every store, so scope to the Retire section only.
      const retireStart = html.indexOf('Retire or restore');
      expect(retireStart).toBeGreaterThan(-1);
      const retireSection = html.slice(retireStart, html.indexOf('</section>', retireStart));
      expect(retireSection).not.toContain('Zulu');
      expect(html).toMatch(
        /1 live POS maps? still use it\. Point them at the replacement; sales keep using up this item until its stock runs out./,
      );
      expect(html).not.toMatch(/live recipes? still use it/);
      expect(html).toContain(
        'Retiring keeps every record. It can no longer be ordered, received, priced, mapped to a POS item or put on a new recipe. Stock already on hand can still be used, wasted, moved and counted until it runs out. You can restore it.',
      );
      expect(html).toMatch(/>Retire</);
      expect(html).not.toMatch(/>Restore</);
      expect(inputTag(html, 'status')).toMatch(/type="hidden"/);
      expect(inputTag(html, 'status')).toMatch(/value="inactive"/);
    },
    60_000,
  );

  it(
    'W4 (clean item): nothing uses it -> the Retire button is there but none of the readout lines are. Killing mutant: draw the lines unconditionally (zero counts rendered). Red today: no Retire button',
    async () => {
      const f = await fixture('w4c');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      expect(html).toMatch(/>Retire</);
      expect(html).not.toContain('Still holds stock at');
      expect(html).not.toMatch(/live POS maps? still use it/);
      expect(html).not.toMatch(/live recipes? still use it/);
    },
    60_000,
  );

  it(
    'W4b (super-admin, inactive item): with +5 at a store it shows "Retired.", the store line ending "It can still be used, wasted, moved and counted until it runs out.", a Restore button with hidden status=active, and no Retire button. Killing mutant: the loader reads the readout only when active (the store line vanishes). Red today: no Retired. text, no Restore button',
    async () => {
      const f = await fixture('w4b');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      await stockAt(f, f.storeId, id, '5');
      await sql`update items set status = 'inactive' where id = ${id}`;
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      expect(html).toContain('Retired.');
      expect(html).toMatch(/Still holds stock at: Store \(5(\.0+)? kg\)/);
      expect(html).toContain('It can still be used, wasted, moved and counted until it runs out.');
      expect(html).toMatch(/>Restore</);
      expect(html).not.toMatch(/>Retire</);
      expect(inputTag(html, 'status')).toMatch(/value="active"/);
    },
    60_000,
  );

  it(
    'W4 (merged item): no Retire section at all (no Retire, no Restore, no explanatory line). Killing mutant: drop the merged exclusion. Red today passes trivially, so this leg is a regression guard that goes red on the mutant; named as legitimately green today',
    async () => {
      const f = await fixture('w4m');
      const target = await insertItem(f, 'Target', 'TGTX-001');
      const id = await insertItem(f, 'Merged one', 'MRGX-001');
      await sql`update items set status = 'merged', merged_into_id = ${target} where id = ${id}`;
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      expect(html).not.toMatch(/>Retire</);
      expect(html).not.toMatch(/>Restore</);
      expect(html).not.toContain('Retiring keeps every record');
    },
    60_000,
  );

  for (const who of ['manager', 'admin'] as const) {
    it(
      `W4 (${who}): no Retire or Restore control, no form with status. Killing mutant: drop the gate on the section. Green today (no section yet); the gate mutant turns it red`,
      async () => {
        const f = await fixture(`w4${who}`);
        const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
        const html = decode(await detailHtmlAs(f[who], id));
        expect(html).not.toMatch(/>Retire</);
        expect(html).not.toMatch(/>Restore</);
        expect(inputTag(html, 'status')).toBeNull();
      },
      60_000,
    );
  }
});

describe('W5 - setItemStatusAction', () => {
  it(
    'W5: retire -> ok "Retired. Its records stay." and the row is inactive with one retire_item audit row; restore -> ok "Restored."; asking for the state it is already in -> ok "No change: it already is." and no new audit row. Red today: setItemStatusAction is not a function',
    async () => {
      const f = await fixture('w5');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const retired = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'inactive' })));
      expect(param(retired, 'ok')).toBe('Retired. Its records stay.');
      expect(await statusOf(id)).toBe('inactive');
      const again = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'inactive' })));
      expect(param(again, 'ok')).toBe('No change: it already is.');
      const restored = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'active' })));
      expect(param(restored, 'ok')).toBe('Restored.');
      expect(await statusOf(id)).toBe('active');
      expect((await retireAudit(id)).map((r) => r.action)).toEqual(['retire_item', 'restore_item']);
    },
    60_000,
  );

  it(
    'W5: a merged item -> error is the merged sentence, status unchanged. Killing mutant: errorMessage lets the DB constraint text through. Red today: not a function',
    async () => {
      const f = await fixture('w5m');
      const target = await insertItem(f, 'Target', 'TGTX-001');
      const id = await insertItem(f, 'Merged one', 'MRGX-001');
      await sql`update items set status = 'merged', merged_into_id = ${target} where id = ${id}`;
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'inactive' })));
      expect(param(to, 'error')).toBe(MERGED_SENTENCE);
      expect(await statusOf(id)).toBe('merged');
    },
    60_000,
  );

  for (const who of ['manager', 'admin'] as const) {
    it(
      `W5b (${who}): retire and restore both get exactly the combined super-admin sentence; status unchanged, no audit. Killing mutant: drop the AuthorizationError mapping (generic approve_item sentence). Red today: not a function`,
      async () => {
        const f = await fixture(`w5b${who}`);
        expect(await holdsApproveItem(f, f[who])).toBe(false);
        const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
        ACTOR_HOLDER.actor = f[who];
        const retire = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'inactive' })));
        expect(param(retire, 'error')).toBe(NOT_SUPER_ADMIN);
        await sql`update items set status = 'inactive' where id = ${id}`;
        const restore = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, status: 'active' })));
        expect(param(restore, 'error')).toBe(NOT_SUPER_ADMIN);
        expect(await statusOf(id)).toBe('inactive');
        expect(await retireAudit(id)).toHaveLength(0);
      },
      60_000,
    );
  }
});

describe('W5c - a malformed status is refused, never coerced', () => {
  for (const [label, fields] of [
    ['missing', {}],
    ['empty', { status: '' }],
    ['garbage', { status: 'garbage' }],
  ] as const) {
    it(
      `W5c (${label}): a super-admin posting status ${label} -> a plain-words error, status unchanged, no audit row. Killing mutant: coerce anything that is not "active" to inactive. Red until the builder's fix`,
      async () => {
        const f = await fixture(`w5c${label}`);
        const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
        ACTOR_HOLDER.actor = f.superAdmin;
        const to = await redirectOf(() => actions.setItemStatusAction(form({ itemId: id, ...fields })));
        const err = param(to, 'error') ?? '';
        expect(err, 'an error banner').not.toBe('');
        expect(err).not.toMatch(/violates|constraint|undefined|TypeError/i);
        expect(param(to, 'ok')).toBeNull();
        expect(await statusOf(id)).toBe('active');
        expect(await retireAudit(id)).toHaveLength(0);
      },
      60_000,
    );
  }
});

describe('W4c - the other readout lines', () => {
  it(
    'W4c: an item used by one active recipe and two active POS maps shows "1 live recipe still use it" and the plural "2 live POS maps still use it". Killing mutants: break either line in page.tsx (drop the recipe line; singular-only wording). Red today only if page.tsx is broken',
    async () => {
      const f = await fixture('w4c2');
      const id = await insertItem(f, 'Coke 1.5', 'CK15-001');
      const other = await insertItem(f, 'Other', 'OTHR-001');
      await liveMap(f, id);
      await liveMap(f, id);
      const [r] = await sql<{ id: string }[]>`
        insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
        values (${f.orgId}, ${uid('recipe')}, ${other}, 1, ${f.superAdmin.personId}) returning id`;
      await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${id}, 1, 'kg')`;
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      expect(html).toMatch(/1 live recipes? still use it\./);
      expect(html).toMatch(/2 live POS maps still use it\./);
    },
    60_000,
  );
});

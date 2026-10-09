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

// Until S2 lands managers can still retire (deactivateItem), so the sentence names only the rename.
const NOT_SUPER_ADMIN = 'Only a super-admin can rename an item.';
const DUP_NAME =
  'An item with that name already exists — names are one per organisation, ignoring case. To reuse the name, rename the existing item on its page first.';
const DUP_CODE = "That item code is already in use. To reuse it, change the existing item's code on its page first.";
// Shared by createItem and the request actions: the readers are not all super-admins, so no 'on its page' hint.
const SHARED_DUP_NAME =
  'An item with that name already exists — names are one per organisation, ignoring case. To reuse the name, ask a super-admin to rename the existing item first.';
const SHARED_DUP_CODE = "That item code is already in use. To reuse it, ask a super-admin to change the existing item's code first.";
/** The taken-code refusal before and after T-386 S3: the unique-index sentence, or the domain's 'cannot be used' sentence. */
const codeTaken = (legacy: string, got: string | null) => got === legacy || /cannot be used: /.test(got ?? '');
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
let actions: typeof import('../../src/app/items/actions') & { renameItemAction: (fd: FormData) => Promise<void> };

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
      expect(codeTaken(DUP_CODE, param(byCode, 'error'))).toBe(true);
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
      expect(codeTaken(SHARED_DUP_CODE, param(byCode, 'error'))).toBe(true);
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

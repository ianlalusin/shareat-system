/**
 * T-386 S4 - `docs/tasks/386-item-code-auto-suggest.md` S4, web legs W1-W8. TESTER file.
 *
 * Real Postgres, real `@shareat/auth`, real page renders and real actions. Only `requireSession` / `requireActor`,
 * `next/navigation` and the Next.js path aliases are mocked (the t383-item-rename-retire-web / t378-s4 harness).
 *
 * State at HEAD (red first): the Request form carries a required `code` input for everyone; `requestItemAction` reads it and
 * `createItemAction` demands it; the pending list prints the stored code; the rename section has no adopt tick;
 * `suggestItemCodeAction` and `ItemCodeField.tsx` do not exist. W6 and W7 fail with "not a function" / "Cannot find module".
 *
 * Fixtures create items with raw SQL and SHAPED codes, so the legs depend on neither the S3 allocator nor on the screens under
 * test; migration 0189's trigger (S2) keeps the counters true as the rows go in.
 *
 * The client-side behaviour of `ItemCodeField` (debounce, the amber readout after the server answers) cannot run here: the repo has no
 * DOM environment. What this file pins instead is (a) the server-rendered first paint, (b) the action `ItemCodeField` calls
 * (W6, whose answer carries everything the readout prints), and (c) the strings and wiring in its source (W8).
 */
import { config } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
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

const S_SHAPE = 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.';
const NOT_SUPER_ADMIN = 'Only a super-admin can rename an item.';
const REQUESTED = 'Request submitted for a super-admin to approve.';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Who = { orgId: string; personId: string };
async function fixture(hint: string) {
  const code = uid(`t386w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Store') returning id`;
  const mk = async (name: string, role: string): Promise<Who> => {
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
    staff: await mk('Staff', 'staff'),
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
const rowOf = async (id: string) => (await sql<{ name: string; code: string }[]>`select name, code from items where id = ${id}`)[0]!;
const byName = async (f: Fixture, name: string) =>
  (await sql<{ id: string; code: string }[]>`select id, code from items where org_id = ${f.orgId} and name = ${name}`)[0];
const requestByName = async (f: Fixture, name: string) =>
  (await sql<{ id: string; code: string; status: string }[]>`select id, code, status from item_requests where org_id = ${f.orgId} and name = ${name}`)[0];

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
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const inputTag = (html: string, name: string): string | null => new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? null;
const formsWith = (html: string, needle: string): string[] => (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).filter((x) => x.includes(needle));
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const REQ = { kind: 'raw_material', baseUnit: 'kg', reason: '' } as const;

let ItemsPage: typeof import('../../src/app/items/page').default;
let ItemDetailPage: typeof import('../../src/app/items/[id]/page').default;
// New exports are read loosely so each leg fails on its BEHAVIOUR, not at import.
let actions: typeof import('../../src/app/items/actions') & {
  suggestItemCodeAction: (name: string, forItemId?: string) => Promise<{ stem: string | null; code: string | null; full: boolean; sameStem: { id: string; code: string; name: string; status: string }[] }>;
};

beforeAll(async () => {
  ItemsPage = (await import('../../src/app/items/page')).default;
  ItemDetailPage = (await import('../../src/app/items/[id]/page')).default;
  actions = (await import('../../src/app/items/actions')) as never;
}, 60_000);

async function itemsHtmlAs(actor: Who): Promise<string> {
  ACTOR_HOLDER.actor = actor;
  const el = await ItemsPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}
async function detailHtmlAs(actor: Who, id: string): Promise<string> {
  ACTOR_HOLDER.actor = actor;
  const el = await ItemDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}

describe('W1 - the Request form: locked code for managers, an override only for a super-admin', () => {
  it(
    'W1 (manager): the Request form has the read-only code display ("Filled in from the name...") and NO input named code. Killing mutant: draw the override for everyone. Red today: a required code input for all',
    async () => {
      const f = await fixture('w1m');
      const html = decode(await itemsHtmlAs(f.manager));
      expect(inputTag(html, 'code'), 'a manager must not get a code input').toBeNull();
      expect(html).toContain('Filled in from the name. The number is fixed when the item is saved.');
      expect(html).not.toContain('Use a different code (super-admin)');
    },
    60_000,
  );

  it(
    'W1 (admin): same as the manager - an admin lacks approve_item, so no override. Killing mutant: gate on manage_items instead of approve_item. Red today: a required code input for all',
    async () => {
      const f = await fixture('w1a');
      const html = decode(await itemsHtmlAs(f.admin));
      expect(inputTag(html, 'code')).toBeNull();
      expect(html).toContain('Filled in from the name. The number is fixed when the item is saved.');
    },
    60_000,
  );

  it(
    'W1 (super-admin): an input name="code" labelled "Use a different code (super-admin)", OPTIONAL (not required), with pattern [A-Za-z0-9]{4}-[0-9]{3}; the read-only display is still there. Killing mutants: required kept; pattern dropped. Red today: a required, unlabelled code input',
    async () => {
      const f = await fixture('w1s');
      const html = decode(await itemsHtmlAs(f.superAdmin));
      const code = inputTag(html, 'code');
      expect(code, 'an override input').not.toBeNull();
      expect(code).not.toMatch(/\brequired\b/);
      expect(code).toContain('pattern="[A-Za-z0-9]{4}-[0-9]{3}"');
      expect(html).toContain('Use a different code (super-admin)');
      expect(html).toContain('Filled in from the name. The number is fixed when the item is saved.');
    },
    60_000,
  );
});

describe('W1b - the override sits with the direct add, not with the request', () => {
  it(
    'W1b: for a super-admin the "Use a different code" input is drawn AFTER the "Request item" button and before / with "Add directly (super-admin)", with no Request button between, so it is not among the request fields. Killing mutant: override drawn above the Request button, among the request fields. Red if the override is drawn among the request fields',
    async () => {
      const f = await fixture('w1b');
      const html = decode(await itemsHtmlAs(f.superAdmin));
      const requestBtn = html.indexOf('>Request item<');
      const overrideAt = html.indexOf('Use a different code (super-admin)');
      const directAt = html.indexOf('Add directly (super-admin)');
      expect(requestBtn, 'Request item button').toBeGreaterThan(-1);
      expect(directAt, 'Add directly button').toBeGreaterThan(-1);
      expect(overrideAt, 'override label').toBeGreaterThan(-1);
      expect(overrideAt, 'after the Request item button').toBeGreaterThan(requestBtn);
      expect(overrideAt, 'before / with the Add directly button').toBeLessThan(directAt);
      expect(html.slice(overrideAt, directAt), 'no Request item button between').not.toContain('>Request item<');
    },
    60_000,
  );
});

describe('W2 - requestItemAction takes no code', () => {
  it(
    'W2: formData code=ZZZZ-001 as a manager -> ok flash, and the request\'s stored code is the preview CHWN-001, not ZZZZ-001. Killing mutant: the action still reads str(fd,"code"). Red today: ZZZZ-001 is stored',
    async () => {
      const f = await fixture('w2');
      ACTOR_HOLDER.actor = f.manager;
      const to = await redirectOf(() => actions.requestItemAction(form({ name: 'Chicken wings', code: 'ZZZZ-001', ...REQ })));
      expect(param(to, 'error')).toBeNull();
      expect(param(to, 'ok')).toBe(REQUESTED);
      expect((await requestByName(f, 'Chicken wings'))?.code).toBe('CHWN-001');
    },
    60_000,
  );

  it(
    'W2b: no code field at all (what the new form posts for a manager) -> ok flash; a name with no letters or numbers -> the stem sentence and no request row. Killing mutant: the action still demands a code. Red today: "an item needs a code"',
    async () => {
      const f = await fixture('w2b');
      ACTOR_HOLDER.actor = f.manager;
      const ok = await redirectOf(() => actions.requestItemAction(form({ name: 'Soy sauce', ...REQ })));
      expect(param(ok, 'error')).toBeNull();
      expect(param(ok, 'ok')).toBe(REQUESTED);
      expect((await requestByName(f, 'Soy sauce'))?.code).toBe('SYSC-001');
      const bad = await redirectOf(() => actions.requestItemAction(form({ name: '--', ...REQ })));
      expect(param(bad, 'error')).toBe('Give the item a name with letters or numbers in it.');
      expect(await requestByName(f, '--')).toBeUndefined();
    },
    60_000,
  );
});

describe('W3 - createItemAction: blank code allocates, a typed one is an override', () => {
  it(
    'W3: super-admin with a blank code -> item coded CHWN-001; code "ck15-005" -> CK15-005; code "bad" -> the shape sentence and no row. Killing mutants: the action passes "" through (the HEAD behaviour: "needs a code"); no upper-case. Red today: needs a code / stored as typed',
    async () => {
      const f = await fixture('w3');
      ACTOR_HOLDER.actor = f.superAdmin;
      const a = await redirectOf(() => actions.createItemAction(form({ name: 'Chicken wings', code: '', ...REQ })));
      expect(param(a, 'error')).toBeNull();
      expect((await byName(f, 'Chicken wings'))?.code).toBe('CHWN-001');
      const b = await redirectOf(() => actions.createItemAction(form({ name: 'Coke 1.5', code: 'ck15-005', ...REQ })));
      expect(param(b, 'error')).toBeNull();
      expect((await byName(f, 'Coke 1.5'))?.code).toBe('CK15-005');
      const c = await redirectOf(() => actions.createItemAction(form({ name: 'Soy sauce', code: 'bad', ...REQ })));
      expect(param(c, 'error')).toBe(S_SHAPE);
      expect(await byName(f, 'Soy sauce')).toBeUndefined();
    },
    60_000,
  );

  it(
    'W3b: no code field at all (the field is absent unless the override is drawn) behaves as blank. Killing mutant: `str(fd,"code")` without `|| undefined` on a missing field. Red today: needs a code',
    async () => {
      const f = await fixture('w3b');
      ACTOR_HOLDER.actor = f.superAdmin;
      const to = await redirectOf(() => actions.createItemAction(form({ name: 'Chicken winglets', ...REQ })));
      expect(param(to, 'error')).toBeNull();
      expect((await byName(f, 'Chicken winglets'))?.code).toBe('CHWN-001');
    },
    60_000,
  );

  it(
    'W3c: a manager posting the override anyway (hand-made form) is refused by authorize, not by the screen: no row, an error flash. Control for I3. Green today and after',
    async () => {
      const f = await fixture('w3c');
      ACTOR_HOLDER.actor = f.manager;
      const to = await redirectOf(() => actions.createItemAction(form({ name: 'Sneaky', code: 'SNKY-001', ...REQ })));
      expect(param(to, 'error')).toBeTruthy();
      expect(await byName(f, 'Sneaky')).toBeUndefined();
    },
    60_000,
  );
});

describe('W4 - the pending list and approval', () => {
  it(
    'W4: with CHWN-001 "Chicken wings" existing, a pending request for "Chicken winglets" renders "Will be coded CHWN-002 on approval" and names CHWN-001 Chicken wings; the super-admin\'s approve form has an optional code input whose placeholder is CHWN-002; an admin sees no code input in the approve form. Killing mutants: render the stored preview; override for everyone. Red today: the stored code is printed, no such input',
    async () => {
      const f = await fixture('w4');
      await insertItem(f, 'Chicken wings', 'CHWN-001');
      ACTOR_HOLDER.actor = f.manager;
      await redirectOf(() => actions.requestItemAction(form({ name: 'Chicken winglets', ...REQ })));
      const html = decode(await itemsHtmlAs(f.superAdmin));
      expect(html).toContain('Will be coded CHWN-002 on approval');
      expect(html).toContain('CHWN-001 Chicken wings');
      const approve = formsWith(html, 'name="requestId"').filter((x) => x.includes('name="baseUnit"'));
      expect(approve.length, 'an approve form').toBeGreaterThan(0);
      const tag = inputTag(approve[0]!, 'code');
      expect(tag, 'the super-admin gets an optional code input').not.toBeNull();
      expect(tag).not.toMatch(/\brequired\b/);
      expect(tag).toContain('placeholder="CHWN-002"');
      const asAdmin = decode(await itemsHtmlAs(f.admin));
      for (const x of formsWith(asAdmin, 'name="requestId"')) expect(inputTag(x, 'code'), 'an admin cannot override').toBeNull();
    },
    90_000,
  );

  it(
    'W4b: the stored preview is NOT shown as the code: a request for "Soy sauce" (preview SYSC-001) after SYSC-007 was issued renders "Will be coded SYSC-008 on approval" and SYSC-001 appears nowhere on the page. Killing mutant: print r.code. Red today: the stored code is printed',
    async () => {
      const f = await fixture('w4b');
      ACTOR_HOLDER.actor = f.manager;
      await redirectOf(() => actions.requestItemAction(form({ name: 'Soy sauce', ...REQ })));
      expect((await requestByName(f, 'Soy sauce'))?.code).toBe('SYSC-001');
      await insertItem(f, 'Soy sauce.', 'SYSC-007');
      const html = decode(await itemsHtmlAs(f.superAdmin));
      expect(html).toContain('Will be coded SYSC-008 on approval');
      expect(html).not.toContain('SYSC-001');
    },
    90_000,
  );

  it(
    'W4c: approveItemRequestAction with a blank code -> flash "Approved as CHWN-002."; with code=CHWX-001 on a second request -> "Approved as CHWX-001."; code=bad -> the shape sentence and the request stays open. Killing mutants: the old flash text; the action drops the override. Red today: the old flash, the code is ignored',
    async () => {
      const f = await fixture('w4c');
      await insertItem(f, 'Chicken wings', 'CHWN-001');
      ACTOR_HOLDER.actor = f.manager;
      await redirectOf(() => actions.requestItemAction(form({ name: 'Chicken winglets', ...REQ })));
      await redirectOf(() => actions.requestItemAction(form({ name: 'Chicken wing tips', ...REQ })));
      const r1 = (await requestByName(f, 'Chicken winglets'))!;
      const r2 = (await requestByName(f, 'Chicken wing tips'))!;
      ACTOR_HOLDER.actor = f.superAdmin;
      const bad = await redirectOf(() => actions.approveItemRequestAction(form({ requestId: r2.id, code: 'bad' })));
      expect(param(bad, 'error')).toBe(S_SHAPE);
      expect((await requestByName(f, 'Chicken wing tips'))?.status).toBe('requested');
      const a = await redirectOf(() => actions.approveItemRequestAction(form({ requestId: r1.id, code: '' })));
      expect(param(a, 'error')).toBeNull();
      expect(param(a, 'ok')).toBe('Approved as CHWN-002.');
      const b = await redirectOf(() => actions.approveItemRequestAction(form({ requestId: r2.id, code: 'CHWX-001' })));
      expect(param(b, 'ok')).toBe('Approved as CHWX-001.');
      expect((await byName(f, 'Chicken wing tips'))?.code).toBe('CHWX-001');
    },
    90_000,
  );
});

describe('W5 - the rename section: the "adopt the suggested code" tick', () => {
  it(
    'W5 (super-admin): the rename section holds a checkbox name="adoptSuggestedCode" labelled "Use the suggested code for the new name", UNTICKED, inside the locked EditableRecord (fieldset disabled before Edit); the code input is still there. Killing mutants: ticked by default; drawn outside the record. Red today: no such checkbox',
    async () => {
      const f = await fixture('w5');
      const id = await insertItem(f, 'Chicken wings', 'CHWN-001');
      const html = decode(await detailHtmlAs(f.superAdmin, id));
      const box = inputTag(html, 'adoptSuggestedCode');
      expect(box, 'the adopt tick').not.toBeNull();
      expect(box).toMatch(/type="checkbox"/);
      expect(box).not.toMatch(/\bchecked\b/);
      expect(html).toContain('Use the suggested code for the new name');
      expect(inputTag(html, 'code'), 'the typed code input stays').not.toBeNull();
      const disabledAt = html.indexOf('<fieldset disabled');
      expect(disabledAt, 'locked until Edit').toBeGreaterThan(-1);
      expect(html.indexOf('name="adoptSuggestedCode"'), 'inside the locked record').toBeGreaterThan(disabledAt);
    },
    90_000,
  );

  it(
    'W5 (action): renameItemAction with the tick ("on") and a new name -> code CHWT-001, flash "Renamed."; unticked -> the code stays CHWN-001. Killing mutants: the action does not pass the flag; the flag is always true. Red today: the code never changes without a typed one',
    async () => {
      const f = await fixture('w5a');
      const id = await insertItem(f, 'Chicken wings', 'CHWN-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const off = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Chicken wing tips', code: 'CHWN-001' })));
      expect(param(off, 'ok')).toBe('Renamed.');
      expect(await rowOf(id)).toEqual({ name: 'Chicken wing tips', code: 'CHWN-001' });
      const on = await redirectOf(() => actions.renameItemAction(form({ itemId: id, name: 'Chicken tips', code: 'CHWN-001', adoptSuggestedCode: 'on' })));
      expect(param(on, 'ok')).toBe('Renamed.');
      expect(await rowOf(id)).toEqual({ name: 'Chicken tips', code: 'CHTP-001' });
    },
    90_000,
  );

  it(
    'W5 (manager): no rename form and no adopt tick - the sentence instead (T-383 W1, unchanged). Control. Green today and after',
    async () => {
      const f = await fixture('w5m');
      const id = await insertItem(f, 'Chicken wings', 'CHWN-001');
      const html = decode(await detailHtmlAs(f.manager, id));
      expect(inputTag(html, 'adoptSuggestedCode')).toBeNull();
      expect(inputTag(html, 'name')).toBeNull();
      expect(html).toContain(NOT_SUPER_ADMIN);
    },
    90_000,
  );
});

describe('W6 - suggestItemCodeAction (what ItemCodeField calls)', () => {
  it(
    'W6: as a manager, ("Chicken winglets") with CHWN-001 existing -> { stem CHWN, code CHWN-002, full false, sameStem [CHWN-001 Chicken wings] }; as a person without manage_items (staff) -> the empty answer, NO throw. Killing mutants: the action lets AuthorizationError escape; returns ids of other orgs. Red today: not a function',
    async () => {
      const f = await fixture('w6');
      const id = await insertItem(f, 'Chicken wings', 'CHWN-001');
      ACTOR_HOLDER.actor = f.manager;
      const s = await actions.suggestItemCodeAction('Chicken winglets');
      expect(s).toMatchObject({ stem: 'CHWN', code: 'CHWN-002', full: false });
      expect(s.sameStem).toEqual([{ id, code: 'CHWN-001', name: 'Chicken wings', status: 'active' }]);
      ACTOR_HOLDER.actor = f.staff;
      expect(await actions.suggestItemCodeAction('Chicken winglets')).toEqual({ stem: null, code: null, full: false, sameStem: [] });
    },
    90_000,
  );

  it(
    'W6b: the second argument (forItemId) reaches the domain: the CHWN-001 item asked about its own name gets its own code back and no sameStem. Killing mutant: the action drops forItemId. Red today: not a function',
    async () => {
      const f = await fixture('w6b');
      const id = await insertItem(f, 'Chicken wings', 'CHWN-001');
      ACTOR_HOLDER.actor = f.superAdmin;
      const s = await actions.suggestItemCodeAction('Chicken wings', id);
      expect(s).toMatchObject({ stem: 'CHWN', code: 'CHWN-001', sameStem: [] });
    },
    90_000,
  );
});

describe('W7 - ItemCodeField, server-rendered', () => {
  type Props = { nameInputId: string; mode: 'new' | 'rename'; canOverride: boolean; currentCode?: string; itemId?: string; suggestAction: (name: string, forItemId?: string) => Promise<unknown> };
  const FIELD_PATH = '../../src/app/items/ItemCodeField';
  async function render(props: Props): Promise<string> {
    const mod = (await import(/* @vite-ignore */ FIELD_PATH)) as { default?: unknown; ItemCodeField?: unknown };
    const Component = (mod.ItemCodeField ?? mod.default) as (p: Props) => unknown;
    expect(Component, 'ItemCodeField must be exported (named or default)').toBeTypeOf('function');
    return decode(renderToStaticMarkup(createElement(Component as never, props as never)));
  }
  const suggestAction = async () => ({ stem: null, code: null, full: false, sameStem: [] });

  it(
    'W7: mode "new", no override: the no-JS line "Filled in when saved." is inside a <noscript>, the read-only explanation is there, and NO input named code. Killing mutants: the no-JS line outside noscript (shown to everyone); an editable input for non-super-admins. Red today: the file does not exist',
    async () => {
      const html = await render({ nameInputId: 'name', mode: 'new', canOverride: false, suggestAction });
      expect(html).toMatch(/<noscript>[^]*Filled in when saved\.[^]*<\/noscript>/);
      expect(html.replace(/<noscript>[^]*?<\/noscript>/g, '')).not.toContain('Filled in when saved.');
      expect(html).toContain('Filled in from the name. The number is fixed when the item is saved.');
      expect(inputTag(html, 'code')).toBeNull();
    },
    30_000,
  );

  it(
    'W7b: mode "new" with canOverride: an optional input name="code", labelled "Use a different code (super-admin)", pattern [A-Za-z0-9]{4}-[0-9]{3}. Killing mutant: required. Red today: the file does not exist',
    async () => {
      const html = await render({ nameInputId: 'name', mode: 'new', canOverride: true, suggestAction });
      const code = inputTag(html, 'code');
      expect(code).not.toBeNull();
      expect(code).not.toMatch(/\brequired\b/);
      expect(code).toContain('pattern="[A-Za-z0-9]{4}-[0-9]{3}"');
      expect(html).toContain('Use a different code (super-admin)');
    },
    30_000,
  );

  it(
    'W7c: mode "rename": a checkbox name="adoptSuggestedCode", unticked, labelled "Use the suggested code for the new name"; it draws no override input of its own (the section\'s existing code input stays on the page). Killing mutant: ticked by default. Red today: the file does not exist',
    async () => {
      const html = await render({ nameInputId: 'name', mode: 'rename', canOverride: true, currentCode: 'CHWN-001', itemId: '11111111-1111-4111-8111-111111111111', suggestAction });
      const box = inputTag(html, 'adoptSuggestedCode');
      expect(box).not.toBeNull();
      expect(box).toMatch(/type="checkbox"/);
      expect(box).not.toMatch(/\bchecked\b/);
      expect(html).toContain('Use the suggested code for the new name');
      expect(inputTag(html, 'code')).toBeNull();
    },
    30_000,
  );
});

describe('W8 - ItemCodeField source and wiring', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const fieldPath = `${root}apps/erp/src/app/items/ItemCodeField.tsx`;
  const read = (p: string) => readFileSync(p, 'utf8');

  it(
    'W8: ItemCodeField.tsx is a client component that imports the stem rule from the client-safe subpath (never @shareat/db or the barrel), debounces 300 ms, prints the amber readout strings of R10, and the domain package exports the subpath. Killing mutants: a second copy of the rule in the component (I5); importing the barrel (drags postgres into the browser). Red today: the file does not exist',
    () => {
      expect(existsSync(fieldPath), 'apps/erp/src/app/items/ItemCodeField.tsx').toBe(true);
      const src = read(fieldPath);
      expect(src.trimStart().startsWith("'use client'") || src.trimStart().startsWith('"use client"')).toBe(true);
      expect(src).toMatch(/from\s+['"]@shareat\/domain\/item-code['"]/);
      expect(src).not.toMatch(/from\s+['"]@shareat\/db/);
      expect(src).not.toMatch(/from\s+['"]@shareat\/domain['"]/);
      expect(src).toMatch(/\b300\b/);
      expect(src).toContain('Already coded');
      expect(src).toContain('Is this the same thing?');
      expect(src).toContain('Filled in when saved.');
      expect(src).toContain('Use a different code (super-admin)');
      expect(src).toContain('Use the suggested code for the new name');
      // I5: one implementation of the rule. The component must not carry its own stop-word list.
      expect(src).not.toMatch(/STOP_WORDS|['"]WITH['"]/);
      const pkg = JSON.parse(read(`${root}packages/domain/package.json`)) as { exports: Record<string, string> };
      expect(pkg.exports['./item-code']).toBe('./src/items/code.ts');
    },
  );

  it(
    'W8b: the vitest root config resolves @shareat/domain/item-code (an exact alias BEFORE the bare @shareat/domain one, the money-lines rule), or the component cannot be imported by any test. Red today: no alias',
    () => {
      const cfg = read(`${root}vitest.config.mts`);
      const at = cfg.indexOf("'@shareat/domain/item-code'");
      expect(at, "alias '@shareat/domain/item-code' in vitest.config.mts").toBeGreaterThan(-1);
      expect(at).toBeLessThan(cfg.indexOf("'@shareat/domain':"));
    },
  );

  it(
    'W8c: both forms use the component: /items (mode new) and /items/[id] (mode rename); the Request form no longer has a literal required code input. Killing mutant: the old input left beside the new component. Red today: the old input is there',
    () => {
      const items = read(`${root}apps/erp/src/app/items/page.tsx`);
      const detail = read(`${root}apps/erp/src/app/items/[id]/page.tsx`);
      expect(items).toContain('ItemCodeField');
      expect(items).not.toMatch(/<input name="code" required/);
      expect(detail).toContain('ItemCodeField');
      expect(detail).toMatch(/mode=["']?\{?['"]?rename/);
    },
  );
});

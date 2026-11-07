// ASSUMED API (T-530a): none.
// ASSUMED API: apps/erp/src/app/sign-in/landing.ts gains a third, optional argument on BOTH landingForActor and landingForToken:
//   opts?: { tabletStoreId?: string | null }   - the store of the live pairing when (and only when) the sign-in came through signInWithTabletPinAction.
//   Absent or null = not a paired-tablet sign-in = today's landing, unchanged.
//   The POS question goes through `can(tx, actor, cap, { storeId })` from @shareat/auth (the same decision authorize() makes), faked below.
// ASSUMED API: signInWithTabletPinAction (sign-in/actions.ts) passes `tabletStoreId` to landingForToken; no other sign-in action does.
/**
 * T-526 R2 / R6 - where a sign-in lands: a paired tablet sends a cashier to /pos, else a kitchen person to /pos/kitchen, else a refill person to
 * /pos/refills; an explicit safe `next` still wins; a laptop sign-in by email is never sent to /pos. Written BEFORE the code (tester lane).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { H } = vi.hoisted(() => ({ H: { held: new Set<string>() } }));
// held entries are `${personId}|${capability}|${storeId}` ; a missing store means "at no store".
vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<typeof import('@shareat/auth')>()),
  can: vi.fn(async (_tx: unknown, actor: { personId: string }, cap: string, scope?: { storeId?: string }) =>
    H.held.has(`${actor.personId}|${cap}|${scope?.storeId ?? ''}`),
  ),
}));
vi.mock('../src/lib/session', () => ({ actorForToken: async (token: string) => ({ personId: token, orgId: 'org' }) }));
vi.mock('../src/app/expenses/lib', () => ({ withOrgPrincipal: async (_o: string, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../src/app/reports/lib', () => ({ scopedStores: vi.fn(async () => ({ stores: [{ id: 'S1' }, { id: 'S2' }], coversWholeOrg: false })) }));

import { STAFF_HOME, landingForActor, landingForToken } from '../src/app/sign-in/landing';

const actor = (personId: string) => ({ personId, orgId: 'org' });
const grant = (p: string, cap: string, store: string) => H.held.add(`${p}|${cap}|${store}`);
const TABLET = { tabletStoreId: 'S1' };

describe('T-526 R2 - the three POS landings on a paired tablet', () => {
  beforeEach(() => H.held.clear());

  it('holds record_sale at the pairing store -> /pos', async () => {
    grant('cashier', 'record_sale', 'S1');
    expect(await landingForActor(actor('cashier'), '', TABLET)).toBe('/pos');
    expect(await landingForToken('cashier', '', TABLET)).toBe('/pos');
  });

  it('no record_sale but serve_pos_ticket -> /pos/kitchen', async () => {
    grant('cook', 'serve_pos_ticket', 'S1');
    expect(await landingForActor(actor('cook'), '', TABLET)).toBe('/pos/kitchen');
  });

  it('only request_pos_refill -> /pos/refills', async () => {
    grant('runner', 'request_pos_refill', 'S1');
    expect(await landingForActor(actor('runner'), '', TABLET)).toBe('/pos/refills');
  });

  it('precedence: record_sale beats serve_pos_ticket beats request_pos_refill', async () => {
    grant('all', 'record_sale', 'S1');
    grant('all', 'serve_pos_ticket', 'S1');
    grant('all', 'request_pos_refill', 'S1');
    expect(await landingForActor(actor('all'), '', TABLET)).toBe('/pos');
    grant('kr', 'serve_pos_ticket', 'S1');
    grant('kr', 'request_pos_refill', 'S1');
    expect(await landingForActor(actor('kr'), '', TABLET)).toBe('/pos/kitchen');
  });

  it('a tablet sign-in beats the manager landing: a manager who can submit a sales day AND sell lands on /pos', async () => {
    grant('mgr', 'record_sale', 'S1');
    grant('mgr', 'submit_sales_day', 'S1');
    expect(await landingForActor(actor('mgr'), '', TABLET)).toBe('/pos');
  });

  it('the capability must be held AT THE PAIRING STORE: record_sale at S2 only does not send an S1 tablet to /pos (falls to today\'s landing)', async () => {
    grant('other', 'record_sale', 'S2');
    expect(await landingForActor(actor('other'), '', TABLET)).toBe(STAFF_HOME);
    grant('other2', 'serve_pos_ticket', 'S2');
    expect(await landingForActor(actor('other2'), '', TABLET)).toBe(STAFF_HOME);
  });

  it('a person with no POS capability on the tablet keeps today\'s landing (staff home, or /sales-days with the grant)', async () => {
    expect(await landingForActor(actor('nobody'), '', TABLET)).toBe(STAFF_HOME);
    grant('clerk', 'submit_sales_day', 'S1');
    expect(await landingForActor(actor('clerk'), '', TABLET)).toBe('/sales-days');
  });
});

describe('T-526 R2 - what must NOT land on /pos', () => {
  beforeEach(() => H.held.clear());

  it('a cashier signing in by email on a laptop (no tablet pairing) is not sent to /pos, /pos/kitchen or /pos/refills', async () => {
    grant('cashier', 'record_sale', 'S1');
    grant('cashier', 'serve_pos_ticket', 'S1');
    grant('cashier', 'request_pos_refill', 'S1');
    for (const opts of [undefined, {}, { tabletStoreId: null }]) {
      const to = await landingForActor(actor('cashier'), '', opts);
      expect(to, JSON.stringify(opts)).toBe(STAFF_HOME);
      expect(to.startsWith('/pos')).toBe(false);
    }
    expect(await landingForToken('cashier', '')).toBe(STAFF_HOME);
  });

  it('a manager on a laptop who can submit a sales day still lands on /sales-days (unchanged)', async () => {
    grant('mgr', 'record_sale', 'S1');
    grant('mgr', 'submit_sales_day', 'S1');
    expect(await landingForActor(actor('mgr'), '')).toBe('/sales-days');
  });
});

describe('T-526 R2 - an explicit safe next still wins', () => {
  beforeEach(() => H.held.clear());

  it('on a tablet, a safe next beats /pos, /pos/kitchen and /pos/refills', async () => {
    grant('cashier', 'record_sale', 'S1');
    grant('cook', 'serve_pos_ticket', 'S1');
    grant('runner', 'request_pos_refill', 'S1');
    for (const p of ['cashier', 'cook', 'runner']) {
      expect(await landingForActor(actor(p), '/inventory', TABLET), p).toBe('/inventory');
      expect(await landingForToken(p, '/expenses?month=2026-11', TABLET), p).toBe('/expenses?month=2026-11');
    }
  });

  it('an unsafe next does not win: the tablet landing applies', async () => {
    grant('cashier', 'record_sale', 'S1');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      expect(await landingForActor(actor('cashier'), bad, TABLET), bad).toBe('/pos');
    }
  });
});

describe('T-526 R2 - only the tablet action passes the pairing store', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'sign-in', 'actions.ts'), 'utf8');
  const fnBody = (name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\nexport async function ', start + 10);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it('signInWithTabletPinAction hands the pairing store to the landing', () => {
    expect(fnBody('signInWithTabletPinAction')).toMatch(/landingFor(Token|Actor)\([\s\S]*?tabletStoreId/);
  });
  it('the email and terminal-PIN actions never do (control)', () => {
    expect(fnBody('signInWithTerminalPinAction')).not.toContain('tabletStoreId');
    expect(src.includes('tabletStoreId')).toBe(true);
    expect(fnBody('signInWithEmailAction')).not.toContain('tabletStoreId');
  });
});

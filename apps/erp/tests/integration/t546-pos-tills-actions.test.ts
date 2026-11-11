import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-546 R5 "Screen" - the Tills server actions on `/admin/pos-tablets`, end to end against Postgres through the REAL domain, session and
 * flash helpers (the global flash-jar setup fakes `next/headers`). docs/tasks/546-pos-terminal-printer-settings.md.
 * ASSUMED API (apps/erp/src/app/admin/pos-tablets/actions.ts, form actions that redirect back with a flash):
 *   createTillAction(fd: storeId, terminalNo)
 *   linkTillAction(fd: storeId, terminalId, pairingId)          pairingId '' = no tablet
 *   setTillPrinterAction(fd: storeId, terminalId, receiptPaperMm, receiptCopies)
 *
 *   - the store's manager and an admin run all three; each lands in the database and in the audit log, and the page is told "ok";
 *   - a refusal is shown in the domain's own sentence (duplicate number, a tablet that already acts as a till, another store's tablet);
 *   - a cashier and a manager of ANOTHER store are refused with a sentence: nothing is written.
 * Runs on ANY `_test` database; every row uses fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: the database name must contain "_test".');

import { currentJar, RedirectSignal } from '../../../../tests/helpers/flash-jar-core';
import { outcomeOf } from '../../../../tests/helpers/flash-jar';
import { closeDb } from '@shareat/db';
import { hashPin, pinLookupHash, signInWithPin } from '@shareat/auth';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => {
  const core = await import('../../../../tests/helpers/flash-jar-core');
  return {
    redirect: (to: string) => {
      throw new core.RedirectSignal(to);
    },
    notFound: () => {
      throw new Error('notFound() called');
    },
  };
});

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;

async function fixture() {
  const code = uid('t546e');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const store = async (n: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${n}) returning id`)[0]!.id;
  const storeA = await store('Lipa');
  const storeB = await store('Malvar');
  const person = async (name: string, role: string, scope: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scope}, 'manual')`;
    const pin = String(546100 + ++pinSeq);
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${id}, 'pin', ${scope}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { id, pin, scope };
  };
  const managerA = await person('Manager A', 'manager', storeA);
  const managerB = await person('Manager B', 'manager', storeB);
  const admin = await person('Admin', 'admin', storeA);
  const staffA = await person('Staff A', 'staff', storeA);
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeA}, ${staffA.id}, 'SE-001', 'regular', '2026-01-01')`;
  const pairing = async (store: string, label: string, revoked = false) =>
    (await sql<{ id: string }[]>`
      insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at, revoked_by)
      values (${orgId}, ${store}, ${label}, ${uid('digest')}, ${managerA.id}, ${revoked ? new Date() : null}, ${revoked ? managerA.id : null}) returning id`)[0]!.id;
  // pos_tablet_pairings allows ONE live pairing per store (0212), so store A has one live tablet and one revoked.
  const tablet1 = await pairing(storeA, 'Counter tablet');
  const tabletB = await pairing(storeB, 'Malvar tablet');
  const tabletRevoked = await pairing(storeA, 'Old tablet', true);
  const signedInAs = async (who: { pin: string; scope: string }) => {
    const s = await signInWithPin(null, { orgId, storeId: who.scope, pin: who.pin });
    currentJar().set('shareat_session', s.token, {});
    return s.token;
  };
  return { orgId, storeA, storeB, managerA, managerB, admin, staffA, tablet1, tabletB, tabletRevoked, signedInAs };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
async function run(action: (fd: FormData) => Promise<void>, fd: FormData) {
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return outcomeOf(e);
    throw e;
  }
  throw new Error('expected a redirect');
}
const actions = () => import('../../src/app/admin/pos-tablets/actions');
const tills = (f: Fx) => sql<{ id: string; terminal_no: number; pairing_id: string | null; receipt_paper_mm: number; receipt_copies: number }[]>`
  select id, terminal_no, pairing_id, receipt_paper_mm, receipt_copies from pos_terminals where org_id = ${f.orgId} order by terminal_no`;
const audited = async (f: Fx, action: string) => (await sql`select 1 from audit_log where org_id = ${f.orgId} and action = ${action}`).length;

beforeEach(() => {
  currentJar().store.clear();
});

describe('the whole round trip as the store manager', () => {
  it('add till 1, choose its tablet, set 80 mm and 2 copies: each lands, each is audited, each says ok, and each returns to the page for that store', async () => {
    const { createTillAction, linkTillAction, setTillPrinterAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);

    const a = await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    expect(a.path).toBe('/admin/pos-tablets');
    expect(a.flash.ok, 'a sentence of success').toBeTruthy();
    expect(a.flash.error).toBeUndefined();
    const [t] = await tills(f);
    expect(t).toMatchObject({ terminal_no: 1, pairing_id: null, receipt_paper_mm: 58, receipt_copies: 1 });

    const b = await run(linkTillAction, form({ storeId: f.storeA, terminalId: t!.id, pairingId: f.tablet1 }));
    expect(b.flash.ok).toBeTruthy();
    expect((await tills(f))[0]!.pairing_id).toBe(f.tablet1);

    const c = await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t!.id, receiptPaperMm: '80', receiptCopies: '2' }));
    expect(c.flash.ok).toBeTruthy();
    expect((await tills(f))[0]).toMatchObject({ receipt_paper_mm: 80, receipt_copies: 2 });

    expect(await audited(f, 'pos.terminal_created')).toBe(1);
    expect(await audited(f, 'pos.terminal_linked')).toBe(1);
    expect(await audited(f, 'pos.terminal_printer_set')).toBe(1);
  });

  it('"No tablet" (an empty pairingId) un-links the tablet', async () => {
    const { createTillAction, linkTillAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '3' }));
    const t = (await tills(f))[0]!;
    await run(linkTillAction, form({ storeId: f.storeA, terminalId: t.id, pairingId: f.tablet1 }));
    const out = await run(linkTillAction, form({ storeId: f.storeA, terminalId: t.id, pairingId: '' }));
    expect(out.flash.ok).toBeTruthy();
    expect((await tills(f))[0]!.pairing_id).toBeNull();
  });

  it('an admin may run them too', async () => {
    const { createTillAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.admin);
    expect((await run(createTillAction, form({ storeId: f.storeA, terminalNo: '5' }))).flash.ok).toBeTruthy();
  });
});

describe('refusals show the domain\'s own sentence and write nothing', () => {
  it('a number already used: "Till 1 already exists at this store."', async () => {
    const { createTillAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    const out = await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    expect(out.flash.error).toBe('Till 1 already exists at this store.');
    expect(await tills(f)).toHaveLength(1);
  });

  it('a number that is not 1 to 99, or not a number, is refused in words (no database error reaches the page)', async () => {
    const { createTillAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    for (const bad of ['0', '100', 'abc', '', '2.5']) {
      const out = await run(createTillAction, form({ storeId: f.storeA, terminalNo: bad }));
      expect(out.flash.error, `terminalNo "${bad}"`).toBeTruthy();
      expect(out.flash.error).not.toMatch(/violates|constraint|SQL|syntax/i);
    }
    expect(await tills(f)).toHaveLength(0);
  });

  it('a tablet that already acts as another till: "That tablet already acts as till 1."; another store\'s tablet and a revoked one: "That tablet is not paired to this store."', async () => {
    const { createTillAction, linkTillAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '2' }));
    const [t1, t2] = await tills(f);
    await run(linkTillAction, form({ storeId: f.storeA, terminalId: t1!.id, pairingId: f.tablet1 }));
    expect((await run(linkTillAction, form({ storeId: f.storeA, terminalId: t2!.id, pairingId: f.tablet1 }))).flash.error).toBe('That tablet already acts as till 1.');
    expect((await run(linkTillAction, form({ storeId: f.storeA, terminalId: t2!.id, pairingId: f.tabletB }))).flash.error).toBe('That tablet is not paired to this store.');
    expect((await run(linkTillAction, form({ storeId: f.storeA, terminalId: t2!.id, pairingId: f.tabletRevoked }))).flash.error).toBe('That tablet is not paired to this store.');
    expect((await tills(f))[1]!.pairing_id).toBeNull();
  });

  it('paper 70 or copies 4, and a forged non-uuid till id, are refused in words', async () => {
    const { createTillAction, setTillPrinterAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    const t = (await tills(f))[0]!;
    expect((await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t.id, receiptPaperMm: '70', receiptCopies: '1' }))).flash.error).toBe('Paper width must be 58 mm or 80 mm.');
    expect((await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t.id, receiptPaperMm: '80', receiptCopies: '4' }))).flash.error).toBe('Copies must be a whole number from 1 to 3.');
    const forged = await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: 'not-a-uuid', receiptPaperMm: '80', receiptCopies: '1' }));
    expect(forged.flash.error).toBeTruthy();
    expect(forged.flash.error).not.toMatch(/invalid input syntax|uuid/i);
    expect((await tills(f))[0]).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
  });
});

describe('who may not', () => {
  it('a cashier and a manager of ANOTHER store are refused with a sentence: no till, no change, no audit row', async () => {
    const { createTillAction, setTillPrinterAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1' }));
    const t = (await tills(f))[0]!;
    for (const who of [f.staffA, f.managerB]) {
      await f.signedInAs(who);
      const make = await run(createTillAction, form({ storeId: f.storeA, terminalNo: '2' }));
      expect(make.flash.error, 'a refusal in words').toBeTruthy();
      const set = await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t.id, receiptPaperMm: '80', receiptCopies: '3' }));
      expect(set.flash.error).toBeTruthy();
    }
    expect(await tills(f)).toHaveLength(1);
    expect((await tills(f))[0]).toMatchObject({ receipt_paper_mm: 58, receipt_copies: 1 });
    expect(await audited(f, 'pos.terminal_created')).toBe(1);
    expect(await audited(f, 'pos.terminal_printer_set')).toBe(0);
  });
});

describe('from /settings/pos-tablet (the manager page)', () => {
  it('a store manager adds a till, links the tablet and sets the printer with returnTo = /settings/pos-tablet: each lands and returns there; an unknown returnTo falls back to /admin/pos-tablets', async () => {
    const { createTillAction, linkTillAction, setTillPrinterAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    const back = { returnTo: '/settings/pos-tablet' };
    const a = await run(createTillAction, form({ storeId: f.storeA, terminalNo: '1', ...back }));
    expect(a.path).toBe('/settings/pos-tablet');
    expect(a.flash.ok).toBeTruthy();
    const t = (await tills(f))[0]!;
    expect((await run(linkTillAction, form({ storeId: f.storeA, terminalId: t.id, pairingId: f.tablet1, ...back }))).path).toBe('/settings/pos-tablet');
    const c = await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t.id, receiptPaperMm: '80', receiptCopies: '3', ...back }));
    expect(c.path).toBe('/settings/pos-tablet');
    expect((await tills(f))[0]).toMatchObject({ pairing_id: f.tablet1, receipt_paper_mm: 80, receipt_copies: 3 });
    const odd = await run(setTillPrinterAction, form({ storeId: f.storeA, terminalId: t.id, receiptPaperMm: '58', receiptCopies: '1', returnTo: 'https://evil.example/x' }));
    expect(odd.path).toBe('/admin/pos-tablets');
  });

  it('a manager of ANOTHER store and a cashier are refused from that page too: nothing is written', async () => {
    const { createTillAction } = await actions();
    const f = await fixture();
    for (const who of [f.managerB, f.staffA]) {
      await f.signedInAs(who);
      const out = await run(createTillAction, form({ storeId: f.storeA, terminalNo: '4', returnTo: '/settings/pos-tablet' }));
      expect(out.flash.error, 'a refusal in words').toBeTruthy();
    }
    expect(await tills(f)).toHaveLength(0);
  });
});

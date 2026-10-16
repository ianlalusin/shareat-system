import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-380 S2 - money does not move, and a refused form comes back with what was typed (DEF-476).
 * docs/tasks/380-no-typed-values-in-urls.md, S2: M1, M2, M3, M4, M4b, W-S2 (R10, I2, R8, REV-8).
 *
 * Every leg reads the action's result through `outcomeOf` / `pageParamsOf` (S1b), so it is the SAME
 * test before and after the screen converts. What each one asserts that HEAD does not yet do:
 * "the redirect URL carries no typed value / no banner text" (the action still builds `?error=...`).
 * What is already true on HEAD stays green and is labelled so: the posted journal lines, and the
 * M4b guard (HEAD's `back()` is typed `never`, so the write is skipped; M4b exists to catch the
 * converted form losing its `return await`).
 *
 * Spec correction found by the tester (reported): M1 says `refundAmount '1,000.50'` posts 100050
 * centavos. It cannot: `parseMoneyInput` refuses a comma ("1,000" is refused, DEF-460, S5.5p), so M1
 * posts `'1000.50'`. The comma value is what M2 round-trips, because it is a REFUSED amount.
 *
 * Mutants (each leg names its own):
 *  - M1: put `ok` (or any figure) back in the query -> the URL assertions go red.
 *  - M2: put `keep` in the query; drop `await` on the catch-path call (the success redirect or
 *    `ok` wins, so `flash.error` is gone and the journal count is 1); encode the refill through
 *    `Number()` ('1,000.50' -> 1000.5, byte-for-byte assertion red).
 *  - M3: leave `confirm`/`plan`/`reason` in the URL; drop `await` -> the confirm step is skipped.
 *  - M4/M4b: drop `await` on the `:199` call -> `setStoreOpeningDate` runs on '2026-13-40'.
 *  - W-S2: leave the net total in the `ok=` URL.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/flash-jar-core')).nextNavigationMock(),
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('../../src/lib/page-access', () => ({
  requirePageAccess: async () => ({ actor: ACTOR_HOLDER.actor!, refusal: null }),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/DetailLayout', () => ({
  DetailLayout: ({ summary, children }: { summary: unknown; children: unknown }) => [summary, children],
}));

import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createAsset,
  createPrepaidItem,
  amortisePrepaidItem,
  runDepreciationAsSystem,
  setAssetInService,
  setPayRate,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { captureRedirect, outcomeOf, pageParamsOf } from '../helpers/flash-jar';
import { givePin } from '../helpers/approval-pin';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function monthlyPeriods(orgId: string, fromYear: number, fromMonth: number, toYear: number, toMonth: number) {
  let y = fromYear;
  let m = fromMonth;
  while (y < toYear || (y === toYear && m <= toMonth)) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${orgId}, ${`${y}-${String(m).padStart(2, '0')}-01`}, ${end}, 'open')`;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

/** One org, chart of accounts, one store, one admin scoped to it. `opening` sets stores.opening_date. */
async function orgFixture(hint: string, opening: string | null = null) {
  const code = uid(`t380s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${opening}) returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  // T-412: a prepaid write-off is Tier P; the administrator approves with their own PIN.
  const pin = await givePin(sql, { orgId, storeId: store!.id, personId: admin!.id });
  return { orgId, storeId: store!.id, adminId: admin!.id, admin: actor(orgId, admin!.id), pin };
}

const UNICODE_PESO = '₱';

// =================================================================================================
// M1 / M2 - prepaid write-off (A1, B2)
// =================================================================================================

async function prepaidFixture(hint: string) {
  const f = await orgFixture(hint);
  await monthlyPeriods(f.orgId, 2026, 1, 2026, 4);
  const item = await asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId,
      name: 'Fire insurance 2026',
      category: 'insurance',
      coverageStartDate: '2026-01-01',
      coverageMonths: 12,
      totalCost: '12000.00',
    }),
  );
  // 3 of 12 months released -> 3,000.00 expensed, 9,000.00 left.
  await asOrg(f.orgId, (tx) => amortisePrepaidItem(tx, f.admin, { prepaidItemId: item.id, asOfPeriod: '2026-03' }));
  return { ...f, itemId: item.id };
}

async function writeOffLegs(itemId: string) {
  return sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, jl.debit::text as debit, jl.credit::text as credit
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.source_type = 'prepaid_write_off' and je.source_id = ${itemId}
    order by a.code`;
}
async function writeOffEntryCount(itemId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries where source_type = 'prepaid_write_off' and source_id = ${itemId}`;
  return row!.n;
}
async function prepaidStatus(itemId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from prepaid_items where id = ${itemId}`;
  return row!.status;
}

function writeOffForm(f: { itemId: string; pin?: string }, over: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('prepaidItemId', f.itemId);
  if (f.pin) fd.set('adminPin', f.pin);
  fd.set('writtenOffOn', '2026-04-10');
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

describe('M1 (I2, R10) - a prepaid write-off with a refund posts the same lines, and none of it is in the URL', () => {
  it(
    'refund 1000.50 to 1110 on 9,000.00 remaining: lines 6750 Dr 7999.50 / 1110 Dr 1000.50 / 1400 Cr 9000.00; ' +
      'URL is /prepaid/<id>?f=... with no peso sign, amount, centavos or reason; flash.ok is the unchanged sentence. ' +
      'Red on HEAD for the URL legs (it carries ?ok=...); the journal lines are green on HEAD. Mutant: any figure back in the query',
    async () => {
      const f = await prepaidFixture('m1');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const reason = 'Cancelled, insurer refunded part';
      const signal = await captureRedirect(() =>
        writeOffAction(writeOffForm(f, { reason, refundAmount: '1000.50', refundAccountCode: '1110' })),
      );

      // The money, read back from the database: identical to what a direct domain call posts.
      expect(await writeOffLegs(f.itemId)).toEqual([
        { code: '1110', debit: '1000.50', credit: '0.00' },
        { code: '1400', debit: '0.00', credit: '9000.00' },
        { code: '6750', debit: '7999.50', credit: '0.00' },
      ]);
      expect(await prepaidStatus(f.itemId)).toBe('written_off');

      // The address: only the page and the one-time token.
      expect(signal.url, `redirect URL was: ${signal.url}`).toMatch(new RegExp(`^/prepaid/${f.itemId}\\?f=[\\w-]+$`));
      for (const forbidden of [UNICODE_PESO, '1,000', '1000', '100050', '7999', '9000', 'Cancelled', 'Written']) {
        expect(signal.url, `URL leaked ${forbidden}`).not.toContain(forbidden);
      }

      // The banner: the same words, on the same page, now from the flash.
      const out = outcomeOf(signal);
      expect(out.path).toBe(`/prepaid/${f.itemId}`);
      expect(out.flash.ok).toBe(`Written off. ${UNICODE_PESO}7999.50 recognised as expense, ${UNICODE_PESO}1000.50 refunded to the books.`);
      expect(out.flash.error).toBeUndefined();
    },
    60_000,
  );
});

describe('M2 (R8) - a refused write-off writes nothing and the form comes back byte for byte', () => {
  async function renderItem(itemId: string, to: string): Promise<string> {
    const PrepaidItemPage = (await import('../../src/app/prepaid/[id]/page')).default;
    const element = await PrepaidItemPage({
      params: Promise.resolve({ id: itemId }),
      searchParams: Promise.resolve(pageParamsOf(to)),
    });
    return renderToStaticMarkup(element as never);
  }
  /** The <input> named `name` inside the write-off form (the page has other forms with a `reason` box). */
  const tagOf = (html: string, name: string) => {
    const form = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []).find((f) => f.includes('name="refundAmount"')) ?? '';
    return new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`).exec(form)?.[0] ?? '';
  };

  it(
    'refund "1,000.50" (a comma: refused by parseMoneyInput): zero entries, status active, no typed value in the URL, ' +
      'flash.refundAmount === "1,000.50", the page renders value="1,000.50" and the reason as typed. ' +
      'Red on HEAD: the URL carries every refill. Mutants: keep in the query; Number() on the refill; drop await on the catch-path call',
    async () => {
      const f = await prepaidFixture('m2a');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const reason = 'Cancelled early, per Ms. Reyes call';
      const signal = await captureRedirect(() =>
        writeOffAction(writeOffForm(f, { reason, refundAmount: '1,000.50', refundAccountCode: '1110' })),
      );

      expect(await writeOffEntryCount(f.itemId), 'a refusal posts nothing').toBe(0);
      expect(await prepaidStatus(f.itemId)).toBe('active');

      expect(signal.url).toMatch(new RegExp(`^/prepaid/${f.itemId}\\?f=[\\w-]+$`));
      for (const forbidden of ['1,000', '1000', 'Cancelled', 'Reyes', '1110', '2026-04-10', 'not a valid']) {
        expect(signal.url, `URL leaked ${forbidden}`).not.toContain(forbidden);
      }

      const out = outcomeOf(signal);
      expect(out.flash.error).toBe('The refund amount — "1,000.50" is not a valid amount. Use at most two decimal places.');
      expect(out.flash.refundAmount, 'byte for byte, never reformatted').toBe('1,000.50');
      expect(out.flash.reason).toBe(reason);
      expect(out.flash.refundAccountCode).toBe('1110');
      expect(out.flash.writtenOffOn).toBe('2026-04-10');

      const html = await renderItem(f.itemId, signal.url);
      expect(tagOf(html, 'refundAmount')).toMatch(/value="1,000\.50"/);
      expect(tagOf(html, 'reason')).toContain(`value="${reason}"`);
      // The refund account is a <select> (a pick list of cash/e-wallet accounts), not a text <input>: the refill shows as the
      // <option> carrying `selected`.
      expect(html).toMatch(/<select[^>]*name="refundAccountCode"[^>]*>[\s\S]*?<option[^>]*value="1110"[^>]*selected=""|<select[^>]*name="refundAccountCode"[^>]*>[\s\S]*?<option[^>]*selected=""[^>]*value="1110"/);
      expect(tagOf(html, 'writtenOffOn')).toMatch(/value="2026-04-10"/);

      // The page must read through withFlash: hand it ONLY the nav keys and the `f` token (no banner or refill
      // key in searchParams at all). A page reading searchParams directly renders blank here.
      const PrepaidItemPage = (await import('../../src/app/prepaid/[id]/page')).default;
      const onlyToken: Record<string, string> = { ...Object.fromEntries(out.nav.entries()), f: out.f! };
      const html2 = renderToStaticMarkup(
        (await PrepaidItemPage({ params: Promise.resolve({ id: f.itemId }), searchParams: Promise.resolve(onlyToken) })) as never,
      );
      expect(tagOf(html2, 'refundAmount')).toMatch(/value="1,000\.50"/);
      expect(tagOf(html2, 'reason')).toContain(`value="${reason}"`);
      expect(html2).toContain('is not a valid amount');
    },
    60_000,
  );

  it(
    'a refund account the domain refuses (unknown code, valid amount): zero entries, URL clean, refill intact. ' +
      'Mutant: drop await on the catch-path call -> the success redirect wins and the entry count is not the proof, flash.error is',
    async () => {
      const f = await prepaidFixture('m2b');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const signal = await captureRedirect(() =>
        writeOffAction(writeOffForm(f, { reason: 'Wrong account test', refundAmount: '1000.50', refundAccountCode: '9999' })),
      );
      expect(await writeOffEntryCount(f.itemId)).toBe(0);
      expect(await prepaidStatus(f.itemId)).toBe('active');
      expect(signal.url).toMatch(new RegExp(`^/prepaid/${f.itemId}\\?f=[\\w-]+$`));
      expect(signal.url).not.toContain('1000.50');
      const out = outcomeOf(signal);
      expect(out.flash.error, 'a refusal, not the success banner').toBeTruthy();
      expect(out.flash.ok).toBeUndefined();
      expect(out.flash.refundAmount).toBe('1000.50');
      expect(out.flash.reason).toBe('Wrong account test');
    },
    60_000,
  );
});

// =================================================================================================
// M3 - fixed-asset in-service confirm step (A2)
// =================================================================================================

async function assetFixture(hint: string) {
  const f = await orgFixture(hint, '2026-01-01');
  await monthlyPeriods(f.orgId, 2026, 3, 2026, 10);
  const { id } = await withOrgPrincipal(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId: f.storeId,
      name: 'Chiller',
      category: 'equipment',
      acquiredOn: '2026-03-15',
      cost: '24000.00',
      salvageValue: '0',
      usefulLifeMonths: 24,
      interval: 'monthly',
    } as Parameters<typeof createAsset>[2]),
  );
  await runDepreciationAsSystem(f.orgId, { through: '2026-10' }); // 03..10 posted, 1,000.00 each
  return { ...f, assetId: id };
}

/** The reversal entries' lines, as comparable rows (amounts only; ids and dates differ per org). */
async function reversalAmounts(orgId: string): Promise<string[]> {
  const rows = await sql<{ code: string; debit: string; credit: string; memo: string }[]>`
    select a.code, jl.debit::text as debit, jl.credit::text as credit, je.memo
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.reversal_of_entry_id is not null`;
  return rows.map((r) => `${r.code} ${r.debit} ${r.credit}`).sort();
}

describe('M3 (A2) - the in-service confirm step keeps the reason and the plan out of the URL, and posts the same entries', () => {
  it(
    'first submit: URL has no reason, no peso amount, no confirm text; flash holds confirm + plan + refills; the page renders ' +
      'the sentence, the hidden confirmedPlan and the reason; resubmitting what the page rendered reverses exactly the entries a ' +
      'direct domain call with the same plan does. Red on HEAD: the URL carries confirm=, plan=, reason=. ' +
      'Mutant: confirm/plan/reason left in the URL; plan not carried through the page',
    async () => {
      const f = await assetFixture('m3');
      const direct = await assetFixture('m3-direct');
      ACTOR_HOLDER.actor = f.admin;
      const { setAssetInServiceAction } = await import('../../src/app/fixed-assets/actions');

      const reason = 'Typo fixed, bought in October';
      const submit = (extra: Record<string, string> = {}) => {
        const fd = new FormData();
        fd.set('assetId', f.assetId);
        fd.set('mode', 'set');
        fd.set('inServiceOn', '2026-10-01');
        fd.set('reason', reason);
        fd.set('filterStore', f.storeId);
        for (const [k, v] of Object.entries(extra)) fd.set(k, v);
        return setAssetInServiceAction(fd);
      };

      const first = await captureRedirect(() => submit());
      for (const forbidden of ['Typo', 'October', UNICODE_PESO, '7,000', 'reverses', 'confirm', 'plan=', '2026-10-01', 'mode=']) {
        expect(first.url, `URL leaked ${forbidden}`).not.toContain(forbidden);
      }
      const o1 = outcomeOf(first);
      expect(o1.path).toBe(`/fixed-assets/${f.assetId}`);
      expect(o1.nav.get('store'), 'the store filter is navigation and stays').toBe(f.storeId);
      expect(o1.flash.confirm).toMatch(/^Chiller — moving the in-service date reverses 7 depreciation entries \(2026-03–2026-09\), ₱7,000\.00; confirm to proceed$/);
      expect(o1.flash.plan).toMatch(/^[0-9a-f]{16}$/);
      expect(o1.flash.reason).toBe(reason);
      expect(o1.flash.mode).toBe('set');
      expect(o1.flash.inServiceOn).toBe('2026-10-01');
      expect(o1.flash.error).toBeUndefined();

      // Nothing reversed yet.
      expect(await reversalAmounts(f.orgId)).toEqual([]);

      // The page: sentence, hidden plan, reason (what the person sees and resubmits).
      const Page = (await import('../../src/app/fixed-assets/[id]/page')).default;
      const html = renderToStaticMarkup(
        (await Page({ params: Promise.resolve({ id: f.assetId }), searchParams: Promise.resolve(pageParamsOf(first.url)) })) as never,
      );
      expect(html).toContain(o1.flash.confirm!);
      const plan = /<input[^>]*name="confirmedPlan"[^>]*value="([0-9a-f]{16})"|<input[^>]*value="([0-9a-f]{16})"[^>]*name="confirmedPlan"/.exec(html);
      const renderedPlan = plan?.[1] ?? plan?.[2];
      expect(renderedPlan, 'the page must carry the plan into the hidden confirmedPlan input').toBe(o1.flash.plan);
      expect(new RegExp(`<input[^>]*name="reason"[^>]*value="${reason}"`).test(html)).toBe(true);

      // Resubmit with the plan the PAGE carried: it posts the same reversals as a direct domain call with that plan.
      const second = await captureRedirect(() => submit({ confirmedPlan: renderedPlan! }));
      const o2 = outcomeOf(second);
      expect(o2.flash.ok).toBe('inservice');
      expect(o2.flash.error).toBeUndefined();

      const directPlan = await (async () => {
        try {
          await withOrgPrincipal(direct.orgId, (tx) =>
            setAssetInService(tx, direct.admin, direct.assetId, { mode: 'set', inServiceOn: '2026-10-01', reason } as never),
          );
        } catch (err) {
          return (err as { planToken?: string }).planToken;
        }
        return undefined;
      })();
      expect(directPlan, 'the direct call must refuse once and hand back a plan token').toBeTruthy();
      await withOrgPrincipal(direct.orgId, (tx) =>
        setAssetInService(tx, direct.admin, direct.assetId, { mode: 'set', inServiceOn: '2026-10-01', reason, confirmedPlan: directPlan } as never),
      );

      const viaAction = await reversalAmounts(f.orgId);
      expect(viaAction.length).toBeGreaterThan(0);
      expect(viaAction).toEqual(await reversalAmounts(direct.orgId));
    },
    120_000,
  );
});

// =================================================================================================
// M4 / M4b - admin store opening date (A3, B1)
// =================================================================================================

describe('M4 / M4b (A3, B1, REV-8) - an invalid opening date is refused before any write, and not echoed into the URL', () => {
  it(
    'M4: "2026-13-40" -> URL has no 2026-13-40; the flash carries the refusal and the refill; the page re-renders the box with it. ' +
      'Red on HEAD: the refusal sentence quotes the typed date in ?error= and no refill is kept. Mutant: date left in the query',
    async () => {
      const f = await orgFixture('m4', '2026-01-01');
      ACTOR_HOLDER.actor = f.admin;
      const { setStoreOpeningDateAction } = await import('../../src/app/admin/stores/actions');

      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('openingDate', '2026-13-40');
      const signal = await captureRedirect(() => setStoreOpeningDateAction(fd));

      expect(signal.url).not.toContain('2026-13-40');
      expect(signal.url).toMatch(new RegExp(`^/admin/stores/${f.storeId}\\?f=[\\w-]+$`));
      const out = outcomeOf(signal);
      expect(out.flash.error).toBe('"2026-13-40" is not a valid date. Use the date picker, or type it as YYYY-MM-DD.');
      // T-389 ruling (2026-10-10): the typed slot supersedes the T-380 keep key for record forms. The date rides the
      // signed cookie's typed slot (bound to the actor), never the address; the server draws only the STORED date.
      const { decodeFlash } = await import('../../src/lib/flash');
      const { currentJar } = await import('../helpers/flash-jar');
      const payload = decodeFlash(currentJar().get('shareat_flash')!.value) as { t?: unknown } | null;
      expect(payload?.t, 'the typed slot carries the bad date').toEqual({
        form: 'store.openingDate',
        record: f.storeId,
        fields: { openingDate: '2026-13-40' },
        actor: f.admin.personId,
      });

      const StorePage = (await import('../../src/app/admin/stores/[id]/page')).default;
      const html = renderToStaticMarkup(
        (await StorePage({ params: Promise.resolve({ id: f.storeId }), searchParams: Promise.resolve(pageParamsOf(signal.url)) })) as never,
      );
      expect(/<input[^>]*name="openingDate"[^>]*value="2026-01-01"/.test(html), 'the server-drawn box holds the STORED date').toBe(true);
      expect(/<input[^>]*name="openingDate"[^>]*value="2026-13-40"/.test(html), 'the server never draws the typed date').toBe(false);
    },
    60_000,
  );

  it(
    'M4b (money does not move): the same refusal leaves stores.opening_date as it was and writes no journal entry. ' +
      'Green on HEAD (back() is typed never). Mutant: drop the await on the :199 call -> the action falls through to ' +
      'setStoreOpeningDate with the bad date: the date changes or the domain throws, and this goes red (G1b too)',
    async () => {
      const f = await orgFixture('m4b', '2026-01-01');
      ACTOR_HOLDER.actor = f.admin;
      const { setStoreOpeningDateAction } = await import('../../src/app/admin/stores/actions');
      const read = async () =>
        (await sql<{ opening_date: string | null }[]>`select opening_date::text as opening_date from stores where id = ${f.storeId}`)[0]!.opening_date;
      const entriesBefore = (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId}`)[0]!.n;

      expect(await read()).toBe('2026-01-01');
      const fd = new FormData();
      fd.set('storeId', f.storeId);
      fd.set('openingDate', '2026-13-40');
      const signal = await captureRedirect(() => setStoreOpeningDateAction(fd));
      const out = outcomeOf(signal);

      expect(await read(), 'opening date unchanged after the refusal').toBe('2026-01-01');
      expect(out.flash.error, 'the refusal, not the success banner').toContain('is not a valid date');
      expect(out.flash.ok).toBeUndefined();
      expect(
        (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId}`)[0]!.n,
      ).toBe(entriesBefore);
    },
    60_000,
  );
});

// =================================================================================================
// W-S2 - payroll post (B2)
// =================================================================================================

describe('W-S2 (B2) - posting a pay run keeps the net total out of the URL; the sentence is unchanged', () => {
  it(
    '2 days at 540.00 post Dr 6100 / Cr 1130 1080.00; the URL has the store and the token, no total; flash.ok is the same sentence. ' +
      'Red on HEAD for the URL (it carries ?ok=Posted 1 payslip(s), 1080.00 net...). Mutant: net total left in the query',
    async () => {
      const code = uid('t380s2-pay');
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
      const orgId = org!.id;
      await seedChartOfAccounts(sql, orgId);
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('pay')}, 'Store pay') returning id`;
      const storeId = store!.id;
      await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
      const [cfg] = await sql<{ id: string }[]>`
        insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier, overtime_mode, overtime_fixed_hourly)
        values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10', 'multiplier', null) returning id`;
      const mk = async (name: string, role: string) => {
        const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
        await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
        await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
        return p!.id;
      };
      const adminId = await mk('Admin', 'admin');
      const workerId = await mk('Worker', 'staff');
      const [emp] = await sql<{ id: string }[]>`
        insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
        values (${orgId}, ${workerId}, ${storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${adminId}) returning id`;
      const [office] = await sql<{ id: string }[]>`
        select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
      const admin = actor(orgId, adminId);
      await asOrg(orgId, (tx) =>
        setPayRate(tx, admin, { employmentId: emp!.id, storeId, basis: 'daily', amount: '540.00', effectiveFrom: '2026-01-01' }),
      );
      for (const day of ['2026-01-05', '2026-01-06']) {
        await sql`
          insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status,
            computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
          values (${orgId}, ${storeId}, ${workerId}, ${emp!.id}, ${day}, ${cfg!.id}, 'exact', 'verified', 540, false, 0, 0, 0, false, null)`;
      }

      ACTOR_HOLDER.actor = admin;
      const { postPayRunAction } = await import('../../src/app/payroll/actions');
      const fd = new FormData();
      fd.set('storeId', storeId);
      fd.set('periodStart', '2026-01-01');
      fd.set('periodEnd', '2026-01-15');
      fd.set('moneyAccountId', office!.id);
      const signal = await captureRedirect(() => postPayRunAction(fd));

      const legs = await sql<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.debit::text as debit, l.credit::text as credit from journal_lines l
        join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
        where e.org_id = ${orgId} and e.source_type = 'payrollpayslip' order by a.code`;
      expect(legs).toEqual([
        { code: '1130', debit: '0.00', credit: '1080.00' },
        { code: '6100', debit: '1080.00', credit: '0.00' },
      ]);

      expect(signal.url, `redirect URL was: ${signal.url}`).not.toContain('1,080');
      expect(signal.url).not.toContain('1080');
      expect(signal.url).not.toContain('Posted');
      const out = outcomeOf(signal);
      expect(out.path).toBe('/payroll');
      expect(out.nav.get('store'), 'the store is navigation').toBe(storeId);
      expect(UUID_RE.test(out.nav.get('store') ?? '')).toBe(true);
      expect(out.flash.ok).toBe(`Posted 1 payslip(s), ${UNICODE_PESO}1,080.00 net. The days they paid are now frozen.`);
    },
    90_000,
  );
});

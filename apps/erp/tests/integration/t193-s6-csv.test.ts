import { afterAll, describe, expect, it, vi } from 'vitest';

import { session, sessionMock } from './t435-fixture';
import { closeDb } from '@shareat/db';
import { mkPerson, mkRun } from '../../../../packages/db/tests/integration/_fixtures/t193-s2-world';
import { mkWorld, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import postgres from 'postgres';
import { config } from 'dotenv';
import type { Actor } from '@shareat/auth';

/**
 * T-193 S6 (TESTER) - the month detail CSV, called as the app calls it: the real route handler, the session mocked to a real actor.
 * Spec: old spec "Reports" 2 (plain columns, NOT the agency's upload format, never labelled "BIR-ready"; gated by remit_statutory IN THE LOADER,
 * not only the menu, row 353), case 16, DEF-800 (every CSV cell goes through the shared escaper in @shareat/core/csv).
 *
 * NAMES FIXED BY THIS FILE (apps/erp/src/app/payroll/statutory-payments/):
 *   month/export/route.ts   GET(request) with ?agency=sss&month=2026-10-01. Takes the actor from requireActor(); reads through the same
 *                           lib.monthDetailFor the screen uses (so the capability is checked in the loader).
 *     200: Content-Type text/csv (charset utf-8), Content-Disposition attachment; filename="statutory-<agency>-<YYYY-MM>.csv",
 *          Cache-Control private (personal data), CRLF lines through the shared `toCsv` (apps/erp/src/lib/csv.ts) => escapeCsvCell.
 *     Header row EXACTLY: Store,Person,Government number,Employee share,Employer share,EC,Total,Note
 *     One row per payslip of the month (posted runs), store NAME, person name, the agency's government number ('' when none), then the four
 *     figures as PLAIN decimals (1585.00 - no peso sign, no thousands comma), Note = '' or "Not deducted: no <AGENCY> no." for a skipped agency.
 *     No total row, no payment rows, no "BIR-ready" / "ready for filing" wording anywhere in the file.
 *     Refused (not remit_statutory), unknown agency, or a month that is not 'YYYY-MM-01': a non-2xx Response (or the loader's
 *     AuthorizationError propagating) whose body has no row, no name, no figure.
 *
 * MUTANTS (named per leg): CSV gated by the menu only; manager/staff get the rows; hand-rolled join (a comma in a name breaks the row;
 * "=SUM(1)" stays live); money formatted with peso/thousand separators; another organization's rows; skipped payslip dropped; wrong
 * agency's number; wrong filename; params unvalidated.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
void sessionMock;

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const exportRoute = () => import('../../src/app/payroll/statutory-payments/month/export/route');
const HEADER = 'Store,Person,Government number,Employee share,Employer share,EC,Total,Note';

interface Got {
  status: number;
  body: string;
  headers: Headers;
  thrown: { name?: string; capability?: string; message: string } | null;
}
async function get(who: Actor, agency: string | null, month: string | null): Promise<Got> {
  session.actor = who;
  const { GET } = await exportRoute();
  const u = new URL('http://localhost/payroll/statutory-payments/month/export');
  if (agency !== null) u.searchParams.set('agency', agency);
  if (month !== null) u.searchParams.set('month', month);
  try {
    const res = await GET(new Request(u));
    return { status: res.status, body: await res.text(), headers: res.headers, thrown: null };
  } catch (e) {
    const x = e as { name?: string; capability?: string; message?: string };
    return { status: 0, body: '', headers: new Headers(), thrown: { name: x.name, capability: x.capability, message: String(x.message ?? e) } };
  }
}
/** Parses CSV text the way a spreadsheet does (quotes, doubled quotes, CRLF). */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const org = (w: World) => ({ orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice });
const refusedNoData = (g: Got, what: string, ...leaks: string[]) => {
  if (g.thrown) {
    expect(g.thrown.name, `${what}: a thrown refusal must be the authorization refusal (got ${g.thrown.name}: ${g.thrown.message})`).toBe('AuthorizationError');
    expect(g.thrown.capability).toBe('remit_statutory');
    return;
  }
  expect([401, 403, 404], `${what}: status ${g.status}`).toContain(g.status);
  expect(g.body, `${what}: no header row of data`).not.toContain(HEADER);
  for (const l of leaks) expect(g.body.includes(l), `${what}: body leaks "${l}"`).toBe(false);
};

describe('the file', () => {
  it('SSS October: headers, filename, content type, and every payslip row exact (kills: wrong columns; money formatted with peso/commas; skipped payslip dropped)', async () => {
    const w = await mkWorld(sql, 's6csv');
    const cora = await mkPerson(sql, org(w), 'Cora Nosssno', w.malvar);
    await mkRun(sql, org(w), { storeId: w.malvar, start: '2026-10-26', end: '2026-10-31', status: 'posted', slips: [{ who: cora, skipped: ['sss'] }] });
    await sql`update persons set sss_no = '3412345678', philhealth_no = '120987654321' where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    const g = await get(w.admin, 'sss', '2026-10-01');
    expect(g.thrown).toBeNull();
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toMatch(/^text\/csv;\s*charset=utf-8$/i);
    expect(g.headers.get('content-disposition')).toBe('attachment; filename="statutory-sss-2026-10.csv"');
    expect(g.headers.get('cache-control') ?? '', 'personal data is not cached').toMatch(/private|no-store/);
    expect(g.body.split('\r\n')[0]).toBe(HEADER);
    expect(g.body.endsWith('\r\n')).toBe(true);
    const rows = parse(g.body).filter((r) => r.length > 1).slice(1).map((r) => r.join('|')).sort();
    expect(rows).toEqual(
      [
        'Lipa|Ana Lipa|3412345678|525.00|1035.00|25.00|1585.00|',
        'Lipa|Ana Lipa|3412345678|525.00|1045.00|25.00|1595.00|',
        'Malvar|Cora Nosssno||0.00|0.00|0.00|0.00|Not deducted: no SSS no.',
        'Malvar|Ben Malvar||525.00|1035.00|25.00|1585.00|',
        'Malvar|Ben Malvar||525.00|1045.00|25.00|1595.00|',
        'Rosario|Rita Rosario||300.00|650.00|50.00|1000.00|',
      ].sort(),
    );
    expect(g.body, 'plain columns: no peso sign').not.toContain(String.fromCharCode(0x20b1));
    expect(g.body, 'never labelled as an agency filing').not.toMatch(/BIR-ready|ready for filing|upload format/i);
  });

  it("each agency's file carries that agency's own number and the withholding for BIR (kills: the SSS number in every file)", async () => {
    const w = await mkWorld(sql, 's6csvagency');
    await sql`update persons set sss_no = '3412345678', philhealth_no = '120987654321', pagibig_no = '121122334455', tin = '987654321012'
              where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    const ph = parse((await get(w.admin, 'philhealth', '2026-10-01')).body).filter((r) => r[1] === 'Ana Lipa');
    expect(ph.map((r) => r.join('|'))).toEqual(['Lipa|Ana Lipa|120987654321|260.00|260.00|0.00|520.00|', 'Lipa|Ana Lipa|120987654321|260.00|260.00|0.00|520.00|']);
    const bir = parse((await get(w.admin, 'bir', '2026-10-01')).body).filter((r) => r[1] === 'Ana Lipa').map((r) => r.join('|')).sort();
    expect(bir).toEqual(['Lipa|Ana Lipa|987654321012|0.00|0.00|0.00|0.00|', 'Lipa|Ana Lipa|987654321012|125.50|0.00|0.00|125.50|'].sort());
    const pi = (await get(w.admin, 'pagibig', '2026-10-01')).body;
    expect(pi).toContain('121122334455');
    expect(pi).not.toContain('120987654321');
  });

  it("a name that is a formula is made inert and a name with a comma and quotes stays one cell (DEF-800; kills: hand-rolled join / escaper bypassed)", async () => {
    const w = await mkWorld(sql, 's6csvinj');
    const names = ['=SUM(1)', '+1+1', '-2+3', '@HYPERLINK("x")', 'Reyes, "Jun" Jr.'];
    const run = (n: string, d: string) => mkPerson(sql, org(w), n, w.malvar).then((who) =>
      mkRun(sql, org(w), { storeId: w.malvar, start: d, end: d, status: 'posted', slips: [{ who, sss: ['525.00', '1035.00', '25.00'] }] }));
    let day = 0;
    for (const n of names) await run(n, `2026-10-${26 + day++}`);
    const g = await get(w.admin, 'sss', '2026-10-01');
    expect(g.status).toBe(200);
    const cells = parse(g.body).map((r) => r[1]);
    expect(cells, 'formula starts get a leading apostrophe').toEqual(expect.arrayContaining(["'=SUM(1)", "'+1+1", "'-2+3", `'@HYPERLINK("x")`]));
    expect(cells).toContain('Reyes, "Jun" Jr.');
    expect(cells.some((c) => /^[=+\-@]/.test(c ?? '')), 'no cell in the Person column starts like a formula').toBe(false);
    for (const r of parse(g.body).filter((r) => r.length > 1)) expect(r.length, `every row has the 8 columns: ${r.join('|')}`).toBe(8);
    expect(g.body).toContain('"Reyes, ""Jun"" Jr."');
  });

  it('this organization only (kills: org filter dropped)', async () => {
    const a = await mkWorld(sql, 's6csvA');
    const b = await mkWorld(sql, 's6csvB');
    await sql`update persons set display_name = 'Zzyx ' || display_name where org_id = ${b.orgId}`;
    const g = await get(a.admin, 'sss', '2026-10-01');
    expect(g.body).not.toContain('Zzyx');
    expect(parse(g.body).filter((r) => r.length > 1).length - 1).toBe(5);
  });
});

describe('who may download it (case 16; kills: gated by the menu only)', () => {
  it('a manager and staff get no row, no name, no figure; an admin and a super admin get the file', async () => {
    const w = await mkWorld(sql, 's6csvgate');
    await sql`update persons set sss_no = '3412345678' where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    for (const who of ['manager', 'staff'] as const) {
      const g = await get(w[who], 'sss', '2026-10-01');
      refusedNoData(g, who, 'Ana Lipa', 'Ben Malvar', 'Rita Rosario', '3412345678', '1585.00', '1595.00');
    }
    for (const who of ['admin', 'superAdmin'] as const) {
      const g = await get(w[who], 'sss', '2026-10-01');
      expect(g.status, who).toBe(200);
      expect(g.body).toContain('3412345678');
    }
  });
});

describe('what the address may say', () => {
  it('an unknown agency, a bad month or a missing parameter is refused with no data and never reaches the database as text (kills: params unvalidated)', async () => {
    const w = await mkWorld(sql, 's6csvparams');
    const cases: [string | null, string | null][] = [
      ['gsis', '2026-10-01'], ['sss', '2026-10-15'], ['sss', 'October'], ['sss', "2026-10-01'; drop table payslips;--"], ['sss', null], [null, '2026-10-01'], [null, null],
    ];
    for (const [agency, month] of cases) {
      const g = await get(w.admin, agency, month);
      const failed = g.thrown !== null || g.status >= 400;
      expect(failed, `${agency}/${month}: refused (status ${g.status})`).toBe(true);
      expect(g.body).not.toContain('Ana Lipa');
    }
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from payslips where org_id = ${w.orgId}`;
    expect(Number(row!.n)).toBeGreaterThan(0);
  });
});

describe('T-193 S6 - every download is audited, without the personal data (kills: no audit row; government numbers in the audit; refused requests audited)', () => {
  const exportRows = (orgId: string) =>
    sql<{ after: unknown; actor_person_id: string }[]>`
      select after, actor_person_id from audit_log where org_id = ${orgId} and action = 'statutory_payment.export' order by id`;
  it('one successful download writes exactly one statutory_payment.export row (agency, month, row count) and no government number, name or figure appears in it', async () => {
    const w = await mkWorld(sql, 's6csvaudit');
    await sql`update persons set sss_no = '3412345678', philhealth_no = '120987654321' where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    expect((await exportRows(w.orgId)).length).toBe(0);
    const g = await get(w.admin, 'sss', '2026-10-01');
    expect(g.status).toBe(200);
    const after = await exportRows(w.orgId);
    expect(after.length, 'exactly one audit row per download').toBe(1);
    expect(after[0]!.actor_person_id).toBe(w.adminId);
    const text = JSON.stringify(after[0]!.after);
    expect(text).toContain('sss');
    expect(text).toContain('2026-10-01');
    expect(text, 'the row count (5 payslips)').toMatch(/\b5\b/);
    for (const leak of ['3412345678', '120987654321', 'Ana Lipa', 'Ben Malvar', 'Rita Rosario', '1585.00', '3180']) expect(text.includes(leak), `audit row leaks ${leak}`).toBe(false);
    await get(w.admin, 'sss', '2026-10-01');
    expect((await exportRows(w.orgId)).length, 'a second download is a second row').toBe(2);
  });

  it('a refused request (manager, staff, bad agency, bad month) writes no audit row', async () => {
    const w = await mkWorld(sql, 's6csvauditno');
    for (const who of [w.manager, w.staff]) await get(who, 'sss', '2026-10-01');
    await get(w.admin, 'gsis', '2026-10-01');
    await get(w.admin, 'sss', '2026-10-15');
    expect((await exportRows(w.orgId)).length).toBe(0);
  });
});

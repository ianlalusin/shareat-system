import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PeriodChargeView, ReviewDayDetail } from '@shareat/domain';

/**
 * T-511 S7b (BUILDER, 11 Nov 2026) - the day detail as a person sees it, rendered with a made-up detail (no database): when Approve shows, when it does not, the reason form
 * that shows only for a question the books asked, the charges of an invoice, the carrier note, the sentence of a booked day. Plus the source of the actions and the page,
 * because their shape is judged by several repo guards (redirect-in-catch, authorize first, no throw).
 */
vi.mock('../src/app/channel-settlements/review/actions', () => {
  const noop = async (): Promise<void> => undefined;
  return { approveDayAction: noop, bookChargeAction: noop, rejectDayAction: noop, reopenDayAction: noop, overrideLoanAllocationAction: noop };
});
vi.mock('@/lib/flash', () => ({ redirectWithFlash: async () => undefined }));

const SRC = resolve(__dirname, '..', 'src');
const DIR = join(SRC, 'app', 'channel-settlements', 'review');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LINE = '00000000-0000-4000-8000-0000000000a1';
const base: ReviewDayDetail = {
  lineId: LINE, storeId: 's1', storeName: 'Lipa', platform: 'foodpanda', salesDate: '2026-10-14', reviewState: 'pending', decisionReason: null, changedSinceBooked: false,
  fileFigure: '10000.00', staffFigure: '10000.00', difference: '0.00', differenceLarge: false, orders: [], salesCorrection: null, loan: { check: null, lines: [] },
  charges: { commission: '2000.00', marketing: '0.00', platformFee: '0.00', vendorDiscount: '0.00', grossInfo: '10000.00' }, otherLines: [], vatOnFees: '0.00', vatOnFeesUnreadable: false,
  feeMonthNote: null, blockers: [], willPostOn: null, postNote: null, canApprove: true, approveWhy: null, isCarrier: false, carrierNote: null, invoiceCharges: [], bookedOn: null, undoNote: null,
};
const charge = (over: Partial<PeriodChargeView> = {}): PeriodChargeView => ({
  otherLineId: '00000000-0000-4000-8000-0000000000c1', invoiceNumber: '200777000001', chargeDate: '2026-10-14', description: 'Admin Adjustment Fee', net: '100.00', vat: '12.00', total: '112.00',
  state: 'not_booked', why: null, canBook: true, ...over,
});

async function render(detail: Partial<ReviewDayDetail>, ack: { sign: 'short' | 'over'; difference: string } | null = null, access = { canReject: true, canReopen: false, canOverrideLoans: false }): Promise<string> {
  const { DayDetail } = await import('../src/app/channel-settlements/review/DayDetail');
  return renderToStaticMarkup(h(DayDetail, { detail: { ...base, ...detail }, access, loans: [], backHref: '/channel-settlements/review', filters: { platform: 'foodpanda' }, ack }));
}
/** How many text buttons carry this label (Approve and Book this charge keep their words: no round icon). */
const count = (html: string, label: string): number => html.split(`>${label}<`).length - 1;

describe('Approve on the day detail', () => {
  it('a waiting day with nothing stopping it and an allowed person has ONE Approve and book form, with the day id and the filters as hidden boxes [kills: no way to approve; a button that is a link; the filters lost]', async () => {
    const html = await render({});
    expect(count(html, 'Approve and book')).toBe(1);
    expect(html).toContain(`name="lineId" value="${LINE}"`);
    expect(html).toContain('name="platform" value="foodpanda"');
    expect(html).toContain('Approving puts this day&#x27;s payout on the books');
    expect(html).not.toContain('name="confirmedDifference"');
  });

  it('a day with something stopping it shows NO button, only the muted line [kills: an Approve button on a blocked day]', async () => {
    const html = await render({ blockers: [{ code: 'not_paid', sentence: 'Not paid yet: Grab still shows this payout as processing.' }] });
    expect(html).not.toContain('Approve and book');
    expect(html).toContain('Fix the items above first.');
    expect(html).toContain('Not paid yet: Grab still shows this payout as processing.');
  });

  it('the person who uploaded a file of the day gets the plain sentence and no button [kills: the uploader offered a button the domain then refuses]', async () => {
    const html = await render({ canApprove: false, approveWhy: 'You uploaded a file this day comes from, so someone else must approve it.' });
    expect(html).not.toContain('Approve and book');
    expect(html).toContain('You uploaded a file this day comes from, so someone else must approve it.');
  });

  it('a booked day and a rejected day have no Approve; the booked day says when and how to undo it [kills: approving twice; a booked day with no way back]', async () => {
    const booked = await render({ reviewState: 'booked', canApprove: false, bookedOn: '2026-10-14', undoNote: 'To undo it, an administrator cancels the settlement on the Overview tab. The day then comes back here as waiting.' });
    expect(booked).not.toContain('Approve and book');
    expect(booked).toContain('booked on 14 Oct 2026');
    expect(booked).toContain('administrator cancels the settlement on the Overview tab');
    const rejected = await render({ reviewState: 'rejected', canApprove: false, decisionReason: 'Wrong file' });
    expect(rejected).not.toContain('Approve and book');
  });

  it('nothing on the screen still says that no money is booked from it [kills: the old "Nothing on this screen books money" copy]', async () => {
    const html = await render({});
    expect(html).not.toMatch(/Nothing on this screen books money/);
    expect(html).not.toMatch(/comes in a later step/);
    expect(html).not.toMatch(/Nothing is booked from this screen/);
  });
});

describe('the reason question (a payout past tolerance)', () => {
  it('a SHORT payout: while the question is open ONLY the reason form shows (one Approve and book, no plain form), with the figure, a hidden confirmed figure and a reason box [kills: no way to give the reason; the confirmed figure missing; a plain Approve that just asks again; a wrong direction]', async () => {
    const html = await render({}, { sign: 'short', difference: '3000.00' });
    expect(count(html, 'Approve and book')).toBe(1);
    expect(count(html, 'Approving puts this day')).toBe(0);
    expect(html).toContain('name="confirmedDifference" value="3000.00"');
    expect(html).toMatch(/<textarea[^>]*name="reason"/);
    expect(html).toContain('short of the day');
    expect(html).toContain('3,000.00');
    expect(html).toContain('That is more than the allowed difference.');
    expect(html).toContain('It is booked as a loss.');
    expect(html).toContain('Why do you accept this difference?');
    expect(html.indexOf('name="confirmedDifference"'), 'the one button is inside the reason form').toBeLessThan(html.lastIndexOf('Approve and book'));
  });

  it('an OVER payout says more than the day and a gain [kills: the two directions swapped]', async () => {
    const html = await render({}, { sign: 'over', difference: '1250.50' });
    expect(html).toContain('more than the day');
    expect(html).toContain('It is booked as a gain.');
    expect(html).not.toContain('short of the day');
    expect(html).not.toContain('booked as a loss');
  });

  it('the reason question uses no accounting jargon: no tolerance, no settlement variance, no settlement gain, no expense or income label [kills: words a beginner cannot read]', async () => {
    for (const sign of ['short', 'over'] as const) {
      const html = await render({}, { sign, difference: '3000.00' });
      expect(html).not.toMatch(/tolerance|settlement variance|settlement gain|an expense|income \(/i);
    }
    expect(read('DayDetail.tsx')).not.toMatch(/tolerance|settlement variance|settlement gain/i);
  });

  it('the reason form is never offered on a blocked day or to a person who may not approve, whatever the address says [kills: a forged ack opening a form]', async () => {
    const blocked = await render({ blockers: [{ code: 'earlier_day_open', sentence: 'An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.' }] }, { sign: 'short', difference: '3000.00' });
    expect(blocked).not.toContain('confirmedDifference');
    const uploader = await render({ canApprove: false, approveWhy: 'You uploaded a file this day comes from, so someone else must approve it.' }, { sign: 'short', difference: '3000.00' });
    expect(uploader).not.toContain('confirmedDifference');
  });

  it('no reason box is filled in: the typed text is not carried back [kills: a refilled reason]', async () => {
    const html = await render({}, { sign: 'short', difference: '3000.00' });
    expect(html).toMatch(/<textarea[^>]*>\s*<\/textarea>/);
  });
});

describe('the charges of an invoice and the carrier note', () => {
  it('a charge that can be booked has its own Book this charge form; a booked one has none and says Booked [kills: booking a booked charge; no way to book]', async () => {
    const open = await render({ invoiceCharges: [charge()] });
    expect(count(open, 'Book this charge')).toBe(1);
    expect(open).toContain('name="otherLineId" value="00000000-0000-4000-8000-0000000000c1"');
    expect(open).toContain(`name="lineId" value="${LINE}"`);
    expect(open).toContain('Admin Adjustment Fee');
    expect(open).toContain('Not booked yet');
    const done = await render({ invoiceCharges: [charge({ state: 'booked', canBook: false })] });
    expect(done).not.toContain('Book this charge');
    expect(done).toContain('Booked');
  });

  it('a charge that cannot be booked shows its plain reason and no button; the state is a phrase, never the stored word [kills: raw not_booked / cannot_book on the page]', async () => {
    const why = 'This file was replaced by a newer upload; book the charge from the newer file.';
    const html = await render({ invoiceCharges: [charge({ state: 'replaced', canBook: false, why }), charge({ otherLineId: '00000000-0000-4000-8000-0000000000c2', state: 'cannot_book', canBook: false, why: 'x' })] });
    expect(html).toContain(why);
    expect(html).not.toContain('Book this charge');
    for (const raw of ['not_booked', 'cannot_book', 'period_charge', 'notBooked']) expect(html).not.toContain(raw);
  });

  it('the carrier note is printed as the domain wrote it [kills: a second copy of the wording]', async () => {
    const note = "This payout also settles 1 charge of this invoice. The bank deposit is the file's net minus 112.00.";
    const html = await render({ isCarrier: true, carrierNote: note });
    expect(html).toContain('This payout also settles 1 charge of this invoice. The bank deposit is the file&#x27;s net minus 112.00.');
  });
});

describe('plain words and the look', () => {
  it('no slice, task number, code or stored word on the screen in any state [kills: jargon on a screen for a beginner]', async () => {
    const pages = [
      await render({}),
      await render({}, { sign: 'short', difference: '3000.00' }),
      await render({ invoiceCharges: [charge()], isCarrier: true, carrierNote: 'This payout also settles 1 charge of this invoice. The bank deposit is the file\'s net minus 112.00.' }),
      await render({ reviewState: 'booked', canApprove: false, bookedOn: '2026-10-14', undoNote: 'x' }),
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/\bslice\b|\bT-\d{3}\b|\bmigration\b|\bS7[ab]?\b|\bDEF-\d+|\btolerance\b|settlement variance|settlement gain/i);
      expect(html).not.toMatch(/\b(NEEDS_REASON|DAY_BLOCKED|UPLOADER_CANNOT_APPROVE|reviewState|confirmedDifference_)\b/);
    }
  });

  it('no pale-grey text class on the screen (T-514: text-neutral-300 and 400 fail contrast) [kills: unreadable muted text]', () => {
    for (const f of ['page.tsx', 'DayDetail.tsx', 'words.ts']) expect(read(f), f).not.toMatch(/text-neutral-[34]00/);
  });
});

describe('the sources of the actions and the page', () => {
  const actions = (): string => read('actions.ts');
  const fn = (name: string): string => {
    const text = actions();
    const at = text.indexOf(`export async function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    const rest = text.slice(at + 10);
    const next = rest.search(/\nexport /);
    return next === -1 ? text.slice(at) : text.slice(at, at + 10 + next);
  };

  it('both actions take requireActor first, call their domain function in withOrgPrincipal, and never read the actor from the form [kills: authorize-after; a client-supplied actor]', () => {
    for (const [name, domain] of [['approveDayAction', 'approveDay('], ['bookChargeAction', 'bookPeriodCharge(']] as const) {
      const body = fn(name);
      expect(body, name).toMatch(/\{\s*const actor = await requireActor\(/);
      expect(body, name).toMatch(/withOrgPrincipal\(\s*actor\.orgId/);
      expect(body, name).toContain(domain);
      expect(body, name).not.toMatch(/(get|text)\(\s*\w*\s*,?\s*['"](actor|actorId|personId|orgId)['"]/);
    }
  });

  it('the NEEDS_REASON branch sits INSIDE the catch, before the plain error redirect, and the success redirect (with the POSTED stamp) comes after the try [kills: a question shown as an error; a redirect that throws inside the try]', () => {
    const body = codeOnly(fn('approveDayAction'));
    const catchAt = body.indexOf('catch');
    const reasonAt = body.indexOf("'NEEDS_REASON'");
    const errorAt = body.indexOf('error: errorMessage(err)');
    const successAt = body.lastIndexOf('redirectWithFlash(');
    expect(catchAt).toBeGreaterThan(-1);
    expect(reasonAt).toBeGreaterThan(catchAt);
    expect(errorAt).toBeGreaterThan(reasonAt);
    expect(successAt).toBeGreaterThan(errorAt);
    expect(body.slice(successAt)).toMatch(/stamp:\s*'POSTED'/);
    expect(body.slice(successAt)).toMatch(/\bok:/);
    const book = codeOnly(fn('bookChargeAction'));
    expect(book.lastIndexOf('redirectWithFlash(')).toBeGreaterThan(book.indexOf('catch') + 10);
    expect(book.slice(book.lastIndexOf('redirectWithFlash('))).toMatch(/stamp:\s*'POSTED'/);
  });

  it('no throw, no new Error and no field-rule assertion in the actions: the domain judges [kills: validation duplicated in the action; the throw ratchet]', () => {
    const text = codeOnly(actions());
    expect(text).not.toMatch(/new Error\(/);
    expect(text).not.toMatch(/\bthrow\b/);
    expect(text).not.toMatch(/assertFieldRules/);
  });

  it('the page loads the charges in the SAME read as the day and the list, parses ack, and has the section [kills: a second transaction for the charges; ack believed without its shape]', () => {
    const page = codeOnly(read('page.tsx'));
    const readAt = page.indexOf('withOrgPrincipal(actor.orgId, async (tx) =>');
    expect(readAt).toBeGreaterThan(-1);
    const readEnd = page.indexOf('\n  });', readAt);
    expect(page.slice(readAt, readEnd)).toContain('listPeriodCharges(tx, actor)');
    expect(page.slice(readAt, readEnd)).toContain('getReviewDayDetail(tx, actor');
    expect(page).toContain('parseAck(sp.ack)');
    expect(page).toContain('Charges not tied to a day');
    expect(page).not.toMatch(/Nothing is booked from this screen/);
  });

  it('the screen reads through the domain: no drizzle, no sql, no repo [kills: SQL in a page]', () => {
    for (const f of ['page.tsx', 'DayDetail.tsx']) {
      const text = codeOnly(read(f));
      expect(text).not.toMatch(/from 'drizzle-orm/);
      expect(text).not.toMatch(/\bsql`/);
      expect(text).not.toMatch(/import \{[^}]*Repo[^}]*\} from '@shareat\/db'/);
    }
  });
});

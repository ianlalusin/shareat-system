import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ROUTE_CAPABILITY, capabilitiesForRoute, navHrefAllowed } from '../src/lib/route-capability';

/**
 * T-193 S5 (TESTER) - the static wiring of the statutory-payments screens. No database.
 *   W1 the route is gated by remit_statutory, and the LONGER prefix wins over /payroll for /new and /<id> too
 *      (kills: no entry, so /payroll's run_payroll decides and a payroll clerk reads government numbers)
 *   W2 the payroll nav group links /payroll/statutory-payments, shown to remit_statutory holders only (kills: no link; link shown to run_payroll)
 *   W3 every statutory-payments page asks requirePageAccess('/payroll/statutory-payments...') BEFORE reading (kills: page reads, menu hides)
 *   W4 the record form mints its id server-side per render with crypto.randomUUID() and posts it as a hidden paymentId (kills: fixed or absent id)
 *   W5 the actions take the actor from requireActor() and call the domain functions (kills: actor from the form; a SQL write in the action)
 *   W6 the constraint messages know the three new constraints, so a database refusal is still a sentence (kills: raw constraint text)
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', 'src');
const BASE = 'app/payroll/statutory-payments';
const read = (rel: string): string => readFileSync(resolve(src, rel), 'utf8').replace(/\r\n/g, '\n');
const codeOnly = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.indexOf('//') === -1 ? l : l.slice(0, l.indexOf('//'))))
    .join('\n');

describe('W1 route capability', () => {
  it('/payroll/statutory-payments is gated by remit_statutory, and its sub-routes inherit it, not /payroll\'s run_payroll', () => {
    expect(capabilitiesForRoute('/payroll/statutory-payments')).toEqual(['remit_statutory']);
    expect(capabilitiesForRoute('/payroll/statutory-payments/new')).toEqual(['remit_statutory']);
    expect(capabilitiesForRoute(`/payroll/statutory-payments/${crypto.randomUUID()}`)).toEqual(['remit_statutory']);
    expect(Object.keys(ROUTE_CAPABILITY)).toContain('/payroll/statutory-payments');
    // /payroll itself is unchanged
    expect(capabilitiesForRoute('/payroll')).toEqual(['run_payroll']);
  });
});

describe('W2 the payroll menu', () => {
  it('links the screen, and only a remit_statutory holder is shown it', () => {
    const nav = codeOnly(read('components/nav.tsx'));
    expect(nav).toMatch(/href:\s*'\/payroll\/statutory-payments'/);
    expect(navHrefAllowed('/payroll/statutory-payments', new Set(['remit_statutory']))).toBe(true);
    expect(navHrefAllowed('/payroll/statutory-payments', new Set(['run_payroll', 'manage_payroll_rates']))).toBe(false);
    expect(navHrefAllowed('/payroll/statutory-payments', new Set())).toBe(false);
  });
});

describe('W3-W5 the pages and actions', () => {
  const pages = [`${BASE}/page.tsx`, `${BASE}/new/page.tsx`, `${BASE}/[id]/page.tsx`];
  for (const p of pages) {
    it(`${p} exists and asks requirePageAccess for a /payroll/statutory-payments route before it reads`, () => {
      expect(existsSync(resolve(src, p)), `${p} exists`).toBe(true);
      const code = codeOnly(read(p));
      const call = code.search(/requirePageAccess\(\s*['"`]\/payroll\/statutory-payments/);
      expect(call, `${p} calls requirePageAccess('/payroll/statutory-payments...')`).toBeGreaterThanOrEqual(0);
      expect(code, `${p} returns the refusal`).toMatch(/if\s*\(\s*refusal\s*\)\s*return\s+refusal/);
      const firstRead = code.search(/\b(monthsFor|reconciliationFor|paymentFor|payFromAccountsFor)\(/);
      if (firstRead >= 0) expect(call, `${p}: the gate comes before the first read`).toBeLessThan(firstRead);
    });
  }

  it('the detail page turns a bad id into notFound()', () => {
    const code = codeOnly(read(`${BASE}/[id]/page.tsx`));
    expect(code).toMatch(/notFound\(\)/);
  });

  it('the record form mints crypto.randomUUID() per render and posts it as a hidden paymentId; the picker comes from payFromAccountsFor', () => {
    const code = codeOnly(read(`${BASE}/new/page.tsx`));
    expect(code).toMatch(/crypto\.randomUUID\(\)/);
    expect(code).toMatch(/name=["']paymentId["']/);
    expect(code).toMatch(/payFromAccountsFor\(/);
  });

  it('the actions take the actor from requireActor(), call the domain, never take an actor or org from the form, and write no SQL', () => {
    const code = codeOnly(read(`${BASE}/actions.ts`));
    expect(code).toMatch(/requireActor\(\)/);
    expect(code).toMatch(/recordStatutoryPayment\(/);
    expect(code).toMatch(/voidStatutoryPayment\(/);
    expect(code).not.toMatch(/get\(\s*['"](actor|orgId|personId)['"]\s*\)/);
    expect(code).not.toMatch(/\bsql`|\.execute\(|insert\(|\.update\(/);
    expect(code).toMatch(/^'use server'|^"use server"/m);
  });

  it('the lib authorizes through the domain\'s capability or the page gate; it reads only through withOrgPrincipal', () => {
    const code = codeOnly(read(`${BASE}/lib.ts`));
    expect(code).toMatch(/remit_statutory/);
    expect(code).toMatch(/withOrgPrincipal/);
    expect(code).not.toMatch(/\btransaction\(/);
  });
});

describe('W6 constraint messages', () => {
  it('knows the three statutory constraints by name so a database refusal is still a sentence', () => {
    const code = read('lib/constraint-messages.ts');
    expect(code).toContain('statutory_payments_posted_reference_unique');
    // the two trigger names of 0222 (the history guard and the line-freeze trigger)
    expect(code).toContain('statutory_payments_history_guard');
    expect(code).toContain('statutory_payment_lines_parent_open');
  });
});

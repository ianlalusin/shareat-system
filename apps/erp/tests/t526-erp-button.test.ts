/**
 * T-526 R3 (planner ruling, 7 Nov) - the ERP button shows only for a person who can open a capability-GATED ERP screen outside /pos.
 * A cashier with only POS words sees none; a manager does. Open screens (every signed-in person can open them) never count.
 */
import { describe, expect, it } from 'vitest';
import { canOpenGatedErpScreen } from '@/app/pos/_shell/erp-access';
import { GROUPS } from '@/components/nav';
import { capabilitiesForRoute } from '@/lib/route-capability';

describe('T-526 - the ERP button', () => {
  it('a cashier holding only POS capabilities gets no ERP button', () => {
    expect(canOpenGatedErpScreen(new Set(['record_sale', 'serve_pos_ticket', 'request_pos_refill']))).toBe(false);
    expect(canOpenGatedErpScreen(new Set())).toBe(false);
  });
  it('a manager (one gated ERP capability is enough) does', () => {
    expect(canOpenGatedErpScreen(new Set(['record_sale', 'view_financial_reports']))).toBe(true);
    expect(canOpenGatedErpScreen(new Set(['manage_users']))).toBe(true);
  });
  it('the control for "open routes do not count": at least one nav link is open to everyone, and it alone does not show the button', () => {
    const open = GROUPS.flatMap((g) => g.links).filter((l) => capabilitiesForRoute(l.href).length === 0);
    expect(open.length).toBeGreaterThan(0);
    expect(canOpenGatedErpScreen(new Set())).toBe(false);
  });
  it('the layout uses it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/erp/src/app/pos/layout.tsx', 'utf8');
    expect(src).toContain('canOpenGatedErpScreen(');
  });
});

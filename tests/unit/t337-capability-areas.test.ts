import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFERABLE_TO_POSITIONS } from '../../packages/domain/src/people/position-defaults';
import { CAPABILITIES, CAPABILITY_AREA, CAPABILITY_AREAS, type Capability, type CapabilityArea } from '@shareat/auth';

/**
 * T-337 — U1, U2, U3. `docs/tasks/337-access-defaults-grouped-collapsible.md` §1, §7.
 * ⛔ Written against the not-yet-built export — `CAPABILITY_AREA`/`CAPABILITY_AREAS` don't exist
 * on `@shareat/auth` yet. RED until the builder adds them, same posture as T-336's U-series.
 */

// -------------------------------------------------------------------------------------
// U1 — CAPABILITY_AREA's keys are exactly CAPABILITIES; every area is used at least once.
// The NEGATIVE half is a compile-time proof: the exhaustiveness guard is the excess-property
// check on the object literal's type, so it can only be tested by trying to violate it and
// watching tsc refuse — a runtime `expect` cannot observe a type error.
// -------------------------------------------------------------------------------------

describe('U1 — CAPABILITY_AREA is keyed on exactly the 109 capabilities; every area is used', () => {
  it('keys set-equal CAPABILITIES', () => {
    expect([...Object.keys(CAPABILITY_AREA)].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('every CAPABILITY_AREAS member is used at least once', () => {
    const used = new Set(Object.values(CAPABILITY_AREA));
    for (const area of CAPABILITY_AREAS) {
      expect(used.has(area), `area "${area}" is declared but never assigned to a capability`).toBe(true);
    }
  });

  it('NEGATIVE (compile-time): a table missing one capability, or naming a bogus one, fails typecheck', () => {
    // ⚠️ Audit finding 1 (2026-09-24): the original version of this test assigned
    // `Object.fromEntries(...)` — typed `{ [k: string]: CapabilityArea }` — directly to
    // `Record<Capability, CapabilityArea>`. An index-signature type is never assignable to a
    // Record of specific literal keys REGARDLESS of which keys are actually present, so the
    // `@ts-expect-error` fired even on the UNMUTATED entries — the negative was vacuous, proving
    // nothing about the exhaustiveness guard it claimed to pin. Rebuilt so the only difference
    // between a passing and a failing case is one missing key.

    // Positive control — the unmutated shape, spread from the real export, must satisfy the
    // exhaustive type. If this line itself failed to compile, every `@ts-expect-error` below would
    // be "correct" for the same vacuous reason as before.
    const _control = { ...CAPABILITY_AREA } satisfies Record<Capability, CapabilityArea>;

    // Object-rest destructuring narrows the TYPE (not just the value) to a Record missing exactly
    // 'close_period' — so `missingOne` differs from `_control` by precisely one key.
    const { close_period: _omitted, ...missingOne } = CAPABILITY_AREA;
    // @ts-expect-error — missingOne's type lacks 'close_period', the exhaustiveness guard U1 pins.
    const _missingOne = missingOne satisfies Record<Capability, CapabilityArea>;

    // An excess/invented key must not satisfy the type either — a fresh literal property, so the
    // object literal's excess-property check still applies here.
    // @ts-expect-error — 'bogus_cap' is not a Capability, the excess-property check U1 relies on.
    const _bogusKey: Readonly<Record<Capability, CapabilityArea>> = { ...CAPABILITY_AREA, bogus_cap: 'sales' };

    // ⛔ T-345 RED — today CAPABILITY_AREA still has 97 keys, so these are 97/96/98 until the
    // builder adds `book_missed_month`.
    // ⭐ 98 -> 99 (T-350/DEF-477): `set_channel_payout` joins CAPABILITY_AREA.
    // ⭐ 99 -> 100 (T-382 S1, A4): `unlink_store_from_pos` joins CAPABILITY_AREA.
    // ⭐ 100 -> 101 (T-385 S3): `verify_own_sales_day` joins CAPABILITY_AREA.
    expect(Object.keys(_control).length, 'positive control: unmutated form has all 109 keys').toBe(109);
    expect(Object.keys(_missingOne).length, 'exactly one key removed').toBe(108);
    expect(Object.keys(_bogusKey).length, 'one excess key added').toBe(110);
  });
});

// -------------------------------------------------------------------------------------
// U2 — a literal, independently-typed-out oracle matches CAPABILITY_AREA exactly.
// -------------------------------------------------------------------------------------

/** Typed out from §1's table directly — NOT built by importing/inverting CAPABILITY_AREA. */
const ORACLE: Readonly<Record<CapabilityArea, readonly string[]>> = {
  sales: [
    'record_sale', 'submit_sales_day', 'verify_sales_day', 'void_sales_day', 'record_statutory_discount',
    'void_statutory_discount', 'accept_remittance', 'record_till_count', 'resolve_till_variance',
    'transfer_funds', 'record_order_wastage', 'resolve_order_wastage', 'charge_staff_for_wastage',
    'reverse_auto_charge',
    // ⭐ T-382 S1 (A4): the unlink sits with the other sales-day / POS-link acts, area `sales`.
    'unlink_store_from_pos',
    // ⭐ T-385 S3: the super-admin exception to "the submitter may not verify" sits beside verify_sales_day.
    'verify_own_sales_day',
    // T-401 S2: the seven menu capabilities sit in sales.
    'view_menu', 'add_menu_item', 'manage_menu', 'request_menu_item', 'set_menu_price', 'set_menu_depletion', 'switch_usage_source',
  ],
  expenses: [
    'create_expense', 'edit_own_expense', 'edit_any_expense', 'void_expense', 'approve_expense',
    'manage_expense_budgets', 'manage_recurring_expenses',
  ],
  inventory: [
    'record_stock_movement', 'adjust_inventory', 'record_wastage', 'charge_staff_for_discrepancy',
    'transfer_stock', 'void_transfer', 'manage_locations', 'post_usage', 'void_usage_record',
    'open_count_session', 'commit_count', 'manage_items', 'approve_item',
  ],
  production: [
    'post_production', 'edit_posted_production', 'void_production', 'manage_pos_map', 'manage_recipes',
    'request_pos_map', 'decide_pos_map_request', 'finalize_pos_usage_pull',
  ],
  commissary: [
    'confirm_receipt', 'resolve_trade_discrepancy', 'set_item_threshold', 'post_order_message',
    'place_branch_order', 'fulfil_branch_order', 'dispatch_branch_order', 'manage_commissary_offerings',
    'manage_commissary_map',
  ],
  suppliers: [
    'record_supplier_return', 'void_supplier_return', 'apply_supplier_credit', 'receive_delivery',
    'allow_over_receipt', 'approve_supplier', 'record_ap_payment', 'record_supplier_invoice',
    'verify_supplier_invoice', 'void_supplier_invoice',
  ],
  customers: [
    'record_customer_return', 'void_customer_return', 'apply_customer_credit', 'refund_customer',
    'approve_buyer', 'set_credit_limit', 'override_credit_limit', 'record_ar_collection',
    'write_off_receivable', 'create_wholesale_order', 'dispatch_wholesale_order',
  ],
  staff: ['enrol_staff', 'manage_attendance', 'set_pay_rate', 'run_payroll', 'provision_clock_terminal'],
  books: [
    'run_cutover', 'view_financial_reports', 'view_trial_balance', 'reverse_entry', 'close_period',
    'override_period_lock', 'post_journal_entry', 'manage_fixed_assets', 'run_depreciation',
    'manage_prepaid_items', 'run_amortisation', 'manage_chart_of_accounts', 'create_missing_period',
    // ⛔ T-345 RED — not in CAPABILITY_AREA until the builder lands `book_missed_month`.
    'book_missed_month',
  ],
  admin: [
    'manage_users', 'manage_stores', 'grant_capability', 'manage_store_settings', 'set_cash_policy',
    'manage_price_lists',
    // ⭐ T-350/DEF-477: `set_channel_payout` — same area as `set_cash_policy` directly above
    // (packages/auth/src/capabilities.ts:721, matching :720), same reasoning: admin-only routing
    // of an existing resource, not a new one.
    'set_channel_payout',
  ],
  franchise: ['cross_org_access', 'view_franchise_sales'],
};

describe('U2 — the literal per-area table matches CAPABILITY_AREA exactly', () => {
  it('every capability inverts to the oracle\'s area, and the counts match §1 (109 total)', () => {
    const inverted: Record<string, string[]> = {};
    for (const [cap, area] of Object.entries(CAPABILITY_AREA)) (inverted[area] ??= []).push(cap);
    const sortedInverted = Object.fromEntries(Object.entries(inverted).map(([k, v]) => [k, [...v].sort()]));
    const sortedOracle = Object.fromEntries(Object.entries(ORACLE).map(([k, v]) => [k, [...v].sort()]));
    expect(sortedInverted).toEqual(sortedOracle);

    // ⛔ T-345 RED — CAPABILITY_AREA still totals 97 until the builder adds `book_missed_month`.
    // ⭐ 98 -> 99 (T-350/DEF-477): `set_channel_payout`.
    const total = Object.values(ORACLE).reduce((sum, caps) => sum + caps.length, 0);
    // ⭐ 100 -> 101 (T-385 S3): `verify_own_sales_day`.
    // ⭐ 101 -> 108 (T-401 S2): the seven menu capabilities, area sales.
    expect(total).toBe(109);
    // ⭐ 108 -> 109 (T-403): `manage_recipes` joins production.
  });

  it('NEGATIVE: the oracle is itself a partition — no capability id appears in two areas', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [area, caps] of Object.entries(ORACLE)) {
      for (const cap of caps) {
        if (seen.has(cap)) dupes.push(`${cap}: ${seen.get(cap)} and ${area}`);
        seen.set(cap, area);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('NEGATIVE: the five non-offered-to-a-position capabilities still carry a real area', () => {
    const nonOffered: Readonly<Record<string, CapabilityArea>> = {
      approve_item: 'inventory',
      close_period: 'books',
      post_journal_entry: 'books',
      cross_org_access: 'franchise',
      view_franchise_sales: 'franchise',
    };
    for (const [cap, expectedArea] of Object.entries(nonOffered)) {
      expect(CAPABILITY_AREA[cap as Capability], `${cap} should carry an area even though it is not offerable to a position`).toBe(expectedArea);
    }
  });
});

// -------------------------------------------------------------------------------------
// U3 — CAPABILITY_AREA never touches authorize() — presentation only, never an access decision.
// -------------------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '..', '..');

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function countTokenHits(rel: string, token: string): number {
  const abs = path.join(repoRoot, rel);
  const raw = readFileSync(abs, 'utf8');
  return (codeOnly(raw).match(new RegExp(token, 'g')) ?? []).length;
}

describe('T-382 A4 — unlink_store_from_pos: area sales, and NOT offerable to a position', () => {
  const CAP = 'unlink_store_from_pos' as string as Capability;

  it('is in area `sales`', () => {
    expect(CAPABILITY_AREA[CAP]).toBe('sales');
  });

  it('is NOT offerable to a position (it is super_admin-only, so the derivation excludes it)', () => {
    expect(OFFERABLE_TO_POSITIONS as readonly string[]).not.toContain(CAP);
  });
});

describe('T-385 A4 - verify_own_sales_day: area sales, and NOT offerable to a position', () => {
  const CAP = 'verify_own_sales_day' as string as Capability;

  it('is in area `sales`', () => {
    expect(CAPABILITY_AREA[CAP]).toBe('sales');
  });

  it('is NOT offerable to a position (it is super_admin-only, so the derivation excludes it)', () => {
    expect(OFFERABLE_TO_POSITIONS as readonly string[]).not.toContain(CAP);
  });
});

describe('U3 — CAPABILITY_AREA is presentation-only: authorize.ts never references it', () => {
  it('authorize.ts has 0 CAPABILITY_AREA tokens, and the scan actually read bytes (floor)', () => {
    const authorizeSrc = readFileSync(path.join(repoRoot, 'packages/auth/src/authorize.ts'), 'utf8');
    expect(authorizeSrc.length, 'authorize.ts read 0 bytes — the scan is vacuous').toBeGreaterThan(0);
    expect(countTokenHits('packages/auth/src/authorize.ts', 'CAPABILITY_AREA')).toBe(0);
  });

  it('NEGATIVE: the identical scan finds >= 1 hit in capabilities.ts — proves the scan can see a real hit', () => {
    expect(countTokenHits('packages/auth/src/capabilities.ts', 'CAPABILITY_AREA')).toBeGreaterThanOrEqual(1);
  });
});


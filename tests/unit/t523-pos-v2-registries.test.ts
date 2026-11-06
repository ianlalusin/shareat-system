import { describe, expect, it } from 'vitest';
import { CUTOVER_CLASSIFICATION } from '../../packages/db/src/cutover/classification';
import { RLS_REGISTRY } from '../../packages/db/src/rls/registry';
import { TRIGGER_REGISTRY } from '../../packages/db/src/triggers/registry';

/**
 * T-523 (docs/tasks/523-pos-v2-schema.md, bible rows 436-437): the fourteen POS v2 tables are classified the
 * day they land. The generic guards (cutover-classification, rls-registry, t354) already fail on an
 * UNLISTED table; this pins the CLASS each one was ruled to have, so a lane cannot satisfy them with
 * the wrong answer. No database needed.
 *
 * R1-R3 and R13 pos_discount_presets are configuration -> keep. R4-R10 and the two R13 discount tables -> purge (row 436: v1 receives Lipa's December day
 * totals through T-531's bridge, so no booked figure lives only in these tables).
 */
const KEEP = ['pos_stores', 'pos_stands', 'pos_terminals', 'pos_discount_presets'];
const PURGE = [
  'table_sessions',
  'table_session_lines',
  'pos_sales_receipts',
  'pos_sales_receipt_lines',
  'pos_sales_receipt_payments',
  'pos_day_closes',
  'pos_day_close_tenders',
  'pos_events',
  'table_session_line_discounts',
  'pos_sales_receipt_line_discounts',
];
/** Every table that carries a history guard (R4-R10, R13 discounts); R1-R3 and the presets have none. */
const GUARDED = PURGE;

describe('T-523 - cutover class of the POS v2 tables', () => {
  it.each(KEEP)('%s is keep (configuration)', (t) => {
    expect(CUTOVER_CLASSIFICATION[t], `${t} is unclassified`).toBeDefined();
    expect(CUTOVER_CLASSIFICATION[t]!.class).toBe('keep');
  });

  it.each(PURGE)('%s is purge', (t) => {
    expect(CUTOVER_CLASSIFICATION[t], `${t} is unclassified`).toBeDefined();
    expect(CUTOVER_CLASSIFICATION[t]!.class).toBe('purge');
  });

  it.each([...KEEP, ...PURGE])('%s has a reason that is a ruling, not an open question', (t) => {
    const reason = CUTOVER_CLASSIFICATION[t]?.reason ?? '';
    expect(reason.length, `${t}: no reason`).toBeGreaterThan(20);
    expect(reason).not.toMatch(/\bOPEN\b/);
  });
});

describe('T-523 - RLS registry', () => {
  it.each([...KEEP, ...PURGE])('%s is registered as org_column scope', (t) => {
    expect(RLS_REGISTRY[t], `${t} is not in the RLS registry`).toBeDefined();
    expect(RLS_REGISTRY[t]!.scope).toBe('org_column');
  });
});

describe('T-523 - trigger registry', () => {
  it.each(GUARDED)('%s has at least one trigger, registered as a history_guard in mode always', (t) => {
    const mine = Object.values(TRIGGER_REGISTRY).filter((e) => e.table === t);
    expect(mine.length, `${t}: no trigger registered`).toBeGreaterThan(0);
    for (const e of mine) {
      expect(e.kind).toBe('history_guard');
      expect(e.mode).toBe('always');
    }
  });
});

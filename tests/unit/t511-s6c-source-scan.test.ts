/**
 * T-511 S6c (TESTER, 7 Nov 2026) - the shape of `packages/domain/src/channel-settlements/charge.ts` and of the settlement change that no behaviour test can see: the gate, the
 * named accounts (Ian's no-hard-coded-business-values rule: the accounts come from the existing constants, the VAT rate from the stored file), no float arithmetic on money,
 * no clock on the public signature, the barrel, and the module README. docs/tasks/511-settlement-upload-s6c-spec.md "Binding" and Design B, D. Source scans, no database.
 *
 * RED TODAY: charge.ts does not exist. Read from the file (not `git ls-files`), so an unstaged new file is seen.
 *
 * Edited by this tester (existing pins, each measured before it was changed):
 *  - tests/unit/domain-actions-have-callers.test.ts: two EXEMPT rows added, `postPlatformCharge` and `postPlatformChargeOnClock` ("S6c ... S7 approve calls it"). The guard is
 *    red ("no longer an action-shaped domain export") until the functions exist.
 *  - packages/db/tests/integration/t354-trigger-registry.test.ts: ALWAYS triggers 41 -> 43 (and the two triggers in its list).
 *  - packages/db/tests/integration/t398-s4-derived-same-org.test.ts: REGISTRY_ADDED_AFTER_S4 54 -> 56 (registry size 209 -> 211).
 *  - packages/db/tests/t402-s1b-catalogue.test.ts and t453-item-audit-catalogue.test.ts: audit ceiling 233 -> 234.
 * The BUILDER still bumps (not tests): the production-caller ratchet if it counts the new zero-caller names, `npm run toc` after the doc headings, the README.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './lib/document-facts';

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const FILE = 'packages/domain/src/channel-settlements/charge.ts';
const INDEX = 'packages/domain/src/channel-settlements/index.ts';

describe('T-511 S6c - charge.ts', () => {
  it('exists and exports postPlatformCharge(tx, actor, input) and the clock seam postPlatformChargeOnClock [kills: a function under another name; a module nobody can find]', () => {
    expect(existsSync(path.join(repoRoot, FILE)), FILE).toBe(true);
    const src = codeOnly(read(FILE));
    expect(src).toMatch(/export\s+async\s+function\s+postPlatformCharge\s*\(\s*tx\s*:\s*Tx\s*,\s*actor\s*:\s*Actor/);
    expect(src).toMatch(/export\s+async\s+function\s+postPlatformChargeOnClock\s*\(\s*tx\s*:\s*Tx\s*,\s*actor\s*:\s*Actor[^)]*today/);
  });

  it('the PUBLIC signature and input type have no `today`: no caller can date an entry in the future [kills: a clock on the production function]', () => {
    const src = codeOnly(read(FILE));
    const sig = /export\s+async\s+function\s+postPlatformCharge\s*\(([^)]*)\)/.exec(src);
    expect(sig, 'public signature found').not.toBeNull();
    expect(sig![1]).not.toMatch(/today/);
    const input = /(?:interface|type)\s+PostPlatformChargeInput\b[^{=]*[{=]\s*([^}]*)}/.exec(src);
    expect(input, 'PostPlatformChargeInput declared').not.toBeNull();
    expect(input![1]).not.toMatch(/today/);
    expect(input![1]).toMatch(/otherLineId/);
  });

  it('authorizes record_ar_collection with the upload\'s store scope BEFORE it posts (authorize( precedes postEntry( and the audit write) [kills: no gate; a gate after the write; a gate without storeId]', () => {
    const src = codeOnly(read(FILE));
    const gate = src.search(/authorize\(\s*tx\s*,\s*actor\s*,\s*'record_ar_collection'\s*,\s*\{\s*storeId/);
    expect(gate, "authorize(tx, actor, 'record_ar_collection', { storeId ... })").toBeGreaterThan(-1);
    const post = src.search(/postEntry\(/);
    expect(post, 'postEntry( call').toBeGreaterThan(-1);
    expect(gate, 'the gate precedes the posting').toBeLessThan(post);
    const audit = src.search(/auditLogRepo\.append\(/);
    expect(audit, 'audit write').toBeGreaterThan(post);
  });

  it('names no account code as a literal: 6400 comes from PLATFORM_FEE_CODE and 1220 from CHANNEL_RECEIVABLE_CODE (Ian\'s rule: reuse the existing constants, add no new literal) [kills: a hard-coded account]', () => {
    const src = codeOnly(read(FILE));
    expect(src, 'no quoted 1220 / 6400 / 6420 / 6410').not.toMatch(/['"`](?:1220|6400|6410|6420)['"`]/);
    expect(src).toMatch(/PLATFORM_FEE_CODE/);
    expect(src).toMatch(/CHANNEL_RECEIVABLE_CODE/);
  });

  it('holds no VAT rate: no 12 percent, 0.12, 1.12 or 112 constant; the VAT is the stored `vat_amount` read from the staged line [kills: a hard-coded rate (Ian\'s rule: the rate comes from the stored file)]', () => {
    const src = codeOnly(read(FILE));
    expect(src).not.toMatch(/(?<![\w.])(?:0?\.12|1\.12|12n|112n|1200n|12\s*\/\s*100)(?![\w])/);
    expect(src).not.toMatch(/\bvatBp\b|\bVAT_RATE\b|\bvatPercent\b/i);
    expect(src).toMatch(/vatAmount|vat_amount/);
  });

  it('dates through firstOpenDateOnOrAfter and keys idempotency on channel_charge:{otherLine}:post [kills: dating on the clock; a different key]', () => {
    const src = codeOnly(read(FILE));
    expect(src).toMatch(/firstOpenDateOnOrAfter/);
    expect(src).toMatch(/channel_charge:\$\{[^}]+\}:post/);
    expect(src).toMatch(/sourceType:\s*'channel_charge'/);
  });

  it('does money with the Money brand, never float arithmetic: no parseFloat, toFixed, Number( or Math.round [kills: 0.08000000000000002]', () => {
    const src = codeOnly(read(FILE));
    expect(src).not.toMatch(/parseFloat|\.toFixed\(|Math\.round\(|\bNumber\(/);
  });

  it('writes the audit action as a literal line the coverage scan can read: `action: \'channel_charge.posted\'` [kills: an action built from a variable the catalogue coverage scan cannot see]', () => {
    expect(read(FILE)).toMatch(/^\s*action:\s*'channel_charge\.posted'/m);
  });

  it('never FOR UPDATE on an append-only table: the lock is taken on the upload row or the channel, and the charge tables are only inserted into and read [kills: SELECT ... FOR UPDATE on channel_period_charges (the append-only trigger and the lock fight)]', () => {
    const src = codeOnly(read(FILE)) + codeOnly(read('packages/db/src/repo/channel-settlements.ts'));
    expect(src).not.toMatch(/channel_period_charges[^;]{0,200}for\s+update/i);
    expect(src).not.toMatch(/channelPeriodCharges[^;]{0,200}\.for\(\s*['"]update['"]/);
  });
});

describe('T-511 S6c - the barrel', () => {
  it('channel-settlements/index.ts re-exports postPlatformCharge from ./charge and NOT the clock seam; the domain barrel reaches it [kills: a function no app can import; a seam on the barrel]', () => {
    const idx = codeOnly(read(INDEX));
    expect(idx).toMatch(/export\s*\{[^}]*\bpostPlatformCharge\b[^}]*\}\s*from\s*'\.\/charge'/);
    expect(idx).not.toMatch(/postPlatformChargeOnClock/);
    expect(codeOnly(read('packages/domain/src/index.ts'))).toMatch(/channel-settlements/);
  });
});

describe('T-511 S6c - the settlement takes the charges it nets (Design D)', () => {
  it('settleChargeIds is read by recordChannelSettlement and previewChannelSettlement and the netting lives in computeSettlement (no second copy of the arithmetic) [kills: the netting done in the posting only (preview and post disagree)]', () => {
    const src = codeOnly(read(INDEX));
    expect(src).toMatch(/settleChargeIds/);
    const compute = src.slice(src.indexOf('function computeSettlement'), src.indexOf('export function settlementConfigBlockers'));
    expect(compute, 'computeSettlement knows the netted total').toMatch(/netted|charge|settleChargeIds/i);
    expect((src.match(/function computeSettlement\(/g) ?? []).length, 'exactly one definition of the arithmetic').toBe(1);
    expect((src.match(/[^n] computeSettlement\(|=\s*figures\s*\?\s*computeSettlement\(/g) ?? []).length, 'the preview and the posting both call it').toBeGreaterThanOrEqual(2);
  });

  it('the charge links are written in the same function that posts the settlement (one transaction) and through the repo, never raw SQL in the domain [kills: a link written after the transaction; SQL in the domain]', () => {
    const src = codeOnly(read(INDEX));
    expect(src).toMatch(/\bR\.\w*[Cc]harge\w*\(|channelSettlementsRepo\.\w*[Cc]harge\w*\(/);
    expect(src).not.toMatch(/channel_settlement_charge_links/);
  });
});

describe('T-511 S6c - the module README', () => {
  it('packages/domain/src/channel-settlements/README.md explains the period charge, the netting and the double-count rule [kills: the model left undocumented]', () => {
    const text = read('packages/domain/src/channel-settlements/README.md');
    expect(text).toMatch(/channel_charge/);
    expect(text).toMatch(/period charge/i);
    expect(text).toMatch(/settleChargeIds/);
    expect(text).toMatch(/6400/);
    expect(text).toMatch(/1220/);
  });
});

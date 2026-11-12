/**
 * T-511 S6c (TESTER, 7 Nov 2026) - dual-run: a `channel_charge` entry (Dr 6400 / Cr 1220, source_type channel_charge) needs NO new class code.
 * docs/tasks/511-settlement-upload-s6c-spec.md Design E: "Dual-run: no new class code; add a test that a `channel_charge` entry is classed by an existing family (V2_ONLY_EVENT)
 * and produces no unclassified item; fix `datedEntries` only if the test shows it must." Pure; no database (the database half is in the domain integration test named below).
 *
 * WHAT IS TRUE TODAY (read from the code, so this file is a CONTROL and passes now): `V2_ONLY_EVENT` is catalogue-only ("A v2 posting with no v1 equivalent (... channel-settlement
 * fees ...)"); the comparator never assigns it. A v2 posting reaches the comparator only if `v2Figures` / `v2Documents` read it, and they read the 1220 tender only from
 * `source_type = 'sale'` entries and a 6400 line only under an expense-payment root. A channel_charge entry is therefore not a line and not a document: it cannot become an
 * item of any class, UNEXPLAINED included. The DATABASE half of that claim (the posted entry really is invisible to v2Figures and v2Documents, nothing dated later) is the last
 * describe of `packages/domain/tests/integration/t511-s6c-post-platform-charge.test.ts`, which is red until the charge can be posted.
 *
 *  K1  the catalogue keeps V2_ONLY_EVENT as a policy class with the channel-settlement wording; no `CHANNEL_CHARGE` (or similar) code is added: the closed list of classes does not grow.
 *  K2  moved (audit LOW, 7 Nov): the old pure test passed no channel_charge to compareStoreWeek, so it proved nothing. The real one runs the real readers and the real comparator against a
 *      database that holds a posted channel_charge entry: `packages/domain/tests/integration/t511-s6c-post-platform-charge.test.ts`, "REAL pipeline".
 */
import { describe, expect, it } from 'vitest';
import { CLASS_CATALOGUE } from '../src/dual-run/classes';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

describe('T-511 S6c - no new dual-run class for a period charge', () => {
  it('V2_ONLY_EVENT is still a policy class that names channel-settlement fees, and no class was added for a charge [kills: a new CHANNEL_CHARGE code the CHECK migration would need]', () => {
    const c = (CLASS_CATALOGUE as Any).V2_ONLY_EVENT;
    expect(c.family).toBe('policy');
    expect(String(c.meaning)).toMatch(/channel-settlement/i);
    expect(Object.keys(CLASS_CATALOGUE).filter((k) => /CHARGE/i.test(k))).toEqual([]);
  });
});

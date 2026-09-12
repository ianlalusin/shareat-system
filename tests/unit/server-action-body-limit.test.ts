import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PURPOSE_LIMITS } from '@shareat/domain';

/**
 * T-282 / DEF-317 — the framework must never be the layer that refuses a file the domain accepts.
 *
 * ## ⭐ Why this test imports both sides instead of restating either
 *
 * The defect was a MISMATCH between two numbers that live in different files and had never been
 * compared: Next's Server Action body cap (absent, therefore 1 MB) and `PURPOSE_LIMITS` (up to
 * 25 MB). A test that hard-codes "26mb" would pass forever while someone raises a purpose limit
 * past it — the same shape as DEF-295/296/304/309/310, a guard whose SCOPE is narrower than its
 * CLAIM. So both sides are read from where they actually live and compared.
 *
 * ⚠️ `next.config.js` is read as TEXT rather than `require`d. Requiring it executes
 * `dotenv.config()` against the repo-root `.env.local`, which mutates `process.env` for every
 * other test sharing this worker. The value is what is being asserted, so text is sufficient and
 * has no side effect.
 */

/** ⚠️ A two-unit parser, not a dependency. `bytes` is not a root dependency here and adding one
 *  for two suffixes would be the larger change. Only the forms this config may hold are accepted;
 *  anything else throws rather than silently returning NaN and passing every comparison below. */
function parseSize(value: string | null): number {
  // ⚠️ An ABSENT key reaches here as null — the defect's own state. It must fail as a stated
  //    refusal, not as a TypeError on `.trim()`: a guard whose failure output is a stack trace
  //    tells the next reader nothing about which invariant broke.
  if (value === null) {
    throw new Error(
      'parseSize: apps/erp/next.config.js declares no experimental.serverActions.bodySizeLimit, ' +
        'so Next enforces its 1 MB default and every file upload in the app fails at 413 (DEF-317).',
    );
  }
  const m = /^(\d+(?:\.\d+)?)(kb|mb)$/i.exec(value.trim());
  if (!m) throw new Error(`parseSize: ${value} is not a size this test understands (kb or mb).`);
  const scale = m[2]!.toLowerCase() === 'mb' ? 1024 * 1024 : 1024;
  return Number(m[1]) * scale;
}

const CONFIG_PATH = path.join(__dirname, '..', '..', 'apps', 'erp', 'next.config.js');

/** The declared value, or `null` when the key is absent — which is the defect's own state. */
function declaredBodySizeLimit(source: string): string | null {
  const match = /bodySizeLimit:\s*['"]([^'"]+)['"]/.exec(source);
  return match?.[1] ?? null;
}

/** ⛔ Next's own fallback, from `action-handler.js:519`. Stated here because the absence of the
 *  key is not visible as a number anywhere in this repo — that invisibility is what the defect
 *  was made of. */
const NEXT_DEFAULT_BYTES = 1024 * 1024;

describe('T-282 / DEF-317 — Server Action body limit vs the domain upload limits', () => {
  const source = readFileSync(CONFIG_PATH, 'utf8');

  it('apps/erp declares a Server Action body limit at all', () => {
    expect(declaredBodySizeLimit(source)).not.toBeNull();
  });

  it('the declared limit is at least the LARGEST declared purpose limit', () => {
    const declared = declaredBodySizeLimit(source);
    const declaredBytes = parseSize(declared);
    const largestPurpose = Math.max(...Object.values(PURPOSE_LIMITS).map((l) => l.maxBytes));

    // ⭐ Bounded by the largest DECLARED purpose, not the largest one with a caller today.
    //    Binding it to the reachable set leaves a green build and a production 413 for whoever
    //    first wires an unused purpose — the spec's own reasoning, asserted rather than trusted.
    expect(declaredBytes).toBeGreaterThanOrEqual(largestPurpose);
  });

  it('⛔ THE PLANT — the pre-fix config (no key) fails this contract', () => {
    // The state that proves the guard works is the one where the OLD configuration is measured
    // against the NEW rule and comes out RED. Without this, the two assertions above only prove
    // that today's value happens to be large enough.
    const preFix = source.replace(/bodySizeLimit:\s*['"][^'"]+['"],?/, '');
    expect(declaredBodySizeLimit(preFix)).toBeNull();

    const largestPurpose = Math.max(...Object.values(PURPOSE_LIMITS).map((l) => l.maxBytes));
    // What the framework would have enforced with the key absent, against what the domain allows.
    expect(NEXT_DEFAULT_BYTES).toBeLessThan(largestPurpose);
  });

  it('the 1 MB default would have refused a receipt photo the domain accepts', () => {
    // Ian's actual report, as an executable statement: an ordinary phone photo.
    const ORDINARY_PHONE_PHOTO_BYTES = 3 * 1024 * 1024;
    expect(ORDINARY_PHONE_PHOTO_BYTES).toBeGreaterThan(NEXT_DEFAULT_BYTES);
    expect(ORDINARY_PHONE_PHOTO_BYTES).toBeLessThanOrEqual(PURPOSE_LIMITS.receipt_photo.maxBytes);

    const declaredBytes = parseSize(declaredBodySizeLimit(source));
    expect(ORDINARY_PHONE_PHOTO_BYTES).toBeLessThanOrEqual(declaredBytes);
  });
});

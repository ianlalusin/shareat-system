/**
 * `npm run deploy-preflight` — the gate T-259/DEF-235 exists to close, run in CI immediately
 * before `npm run build` (`.github/workflows/deploy.yml`, ahead of the "Build" step).
 *
 * ## What actually happened (DEF-235)
 *
 * A production deploy shipped with `NEXT_PUBLIC_FIREBASE_API_KEY` empty and
 * `NEXT_PUBLIC_FIREBASE_PROJECT_ID` carrying a trailing `\n` from a web-UI paste. The build
 * inlined both as-is — that is what a build does — the workflow went green, and the only signal
 * was Ian unable to sign in on `erp2.shareat.net`. Nothing between "the build succeeded" and
 * "the app works" asserted anything.
 *
 * ## Why this does NOT just run `publicSchema.safeParse(process.env)`
 *
 * Every field in `packages/core/src/env.ts`'s schemas calls `.trim()` before validating, so
 * `"shareat-hub-v2\n"` parses successfully as `"shareat-hub-v2"` — a schema-based check reports
 * GREEN on exactly the padded-secret case this task exists to catch (DEF-235 reopening inside
 * its own guard). So this script never calls `.safeParse()` on the values it is verifying: it
 * reads `process.env` RAW, before any Zod transform gets a chance to strip the evidence.
 *
 * The schema is still the single source of truth for WHICH keys are required —
 * `REQUIRED_PUBLIC_ENV_KEYS` (pinned by `packages/core/tests/env.test.ts`), derived from
 * `publicSchema` via Zod's own `.isOptional()`, not a second hand-maintained list.
 *
 * ## Scope — read this before assuming it covers more than it does
 *
 * This preflight covers ONLY the five `NEXT_PUBLIC_FIREBASE_*` values CI passes into the Build
 * step (`deploy.yml` — the `env:` block ahead of `npm run build`). Those are the values a Next.js
 * build inlines into the client bundle, which is DEF-235's actual mechanism.
 *
 * It does NOT cover `SESSION_SECRET`, `DATABASE_URL`, `FIREBASE_PROJECT_ID` (server),
 * `FIREBASE_SERVICE_ACCOUNT_KEY(_FILE)` — none of those appear anywhere in `deploy.yml`. They
 * live in `/srv/shareat-shared/.env.local`, applied BY HAND on the droplet (DEF-194 — `docs/ops`
 * does not ship), and are validated only by `loadServerEnv()`'s own `serverSchema.safeParse()`
 * at process start — which carries the identical trim-before-validate blind spot, unaddressed
 * here and logged separately (DEF-267).
 *
 * ⛔ Never logs a value — only a variable NAME and a VERDICT (absent / empty / padded / ok).
 */
import { REQUIRED_PUBLIC_ENV_KEYS } from '@shareat/core/env';

type Verdict = 'absent' | 'empty' | 'padded' | 'ok';

function verdictOf(raw: string | undefined): Verdict {
  if (raw === undefined) return 'absent';
  if (raw === '') return 'empty';
  if (raw.trim() !== raw) return 'padded';
  return 'ok';
}

function main(): void {
  // ⛔ THE ONE CHECK THAT MATTERS MOST. `.isOptional()` is a behavioural probe on the schema —
  // sound, but if it ever answers "everything is optional" (a schema refactor, a typo in the
  // filter), REQUIRED_PUBLIC_ENV_KEYS silently becomes []. A preflight that iterates an empty
  // list checks nothing and exits 0 — green, forever, the exact shape this project has shipped
  // three times before (DEF-225/226/227's "scanned nothing, reported success"). An empty
  // derived list is refused outright, never read as "nothing to check."
  if (REQUIRED_PUBLIC_ENV_KEYS.length === 0) {
    console.error(
      'deploy-preflight: REQUIRED_PUBLIC_ENV_KEYS derived to an EMPTY list — the derivation\n' +
        '  itself is broken (packages/core/src/env.ts), not "nothing to check". Refusing to\n' +
        '  report green on a check that scanned nothing. See DEF-235 / DEF-267.',
    );
    process.exitCode = 1;
    return;
  }

  const failures: string[] = [];

  console.log(`deploy-preflight: checking ${REQUIRED_PUBLIC_ENV_KEYS.length} required value(s)…`);
  for (const key of REQUIRED_PUBLIC_ENV_KEYS) {
    const v = verdictOf(process.env[key]);
    if (v === 'ok') {
      console.log(`  ✓ ${key}: ok`);
    } else {
      failures.push(`${key} (${v})`);
      console.error(`  ✗ ${key}: ${v}`);
    }
  }

  // Optional siblings (NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, _APP_ID today) — never fail on
  // absence or on blank (blankAsAbsent() already treats blank as legitimately unset); only a
  // non-empty, whitespace-padded value is a real fault, so only that is checked.
  const optionalPresentKeys = Object.keys(process.env).filter(
    (k) => k.startsWith('NEXT_PUBLIC_FIREBASE_') && !(REQUIRED_PUBLIC_ENV_KEYS as readonly string[]).includes(k),
  );
  for (const key of optionalPresentKeys) {
    const raw = process.env[key];
    if (raw === undefined || raw === '') continue;
    if (raw.trim() !== raw) {
      failures.push(`${key} (padded)`);
      console.error(`  ✗ ${key}: padded (optional, but present and whitespace-padded)`);
    } else {
      console.log(`  ✓ ${key}: ok (optional)`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\ndeploy-preflight: REFUSING TO BUILD — ${failures.length} value(s) failed: ${failures.join(', ')}.\n` +
        '  A missing, empty, or whitespace-padded value here gets inlined into the production\n' +
        '  bundle as-is (DEF-235) — the build would succeed and the app would ship broken.\n' +
        '  Fix the named GitHub Secret(s). (Value never printed, by contract.)',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    '\ndeploy-preflight: all required NEXT_PUBLIC_FIREBASE_* values present, non-empty, unpadded.',
  );
}

main();

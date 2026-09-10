/**
 * Environment contract — validated once, at import time, and FAIL-CLOSED.
 *
 * PROJECT_BIBLE.md §7 rule 9: "Secrets fail closed. A missing secret aborts startup.
 * It never falls back to a default, a public value, or a dev constant."
 *
 * This exists because of two real production incidents in v1:
 *   - a deploy shipped with blank env vars and went live broken, undetected
 *     (the .env was gitignored and untracked)
 *   - the passcode HMAC secret fell back to a PUBLIC value when unset — it failed OPEN
 *
 * Anything required here must abort the process when missing. Do not add a `.default()`
 * to a secret. Do not add a `||` fallback at a call site.
 */
import { z } from 'zod';

const isServer = typeof window === 'undefined';

/**
 * Not-yet-required config. An unset variable in a .env file arrives as the EMPTY
 * STRING, not `undefined`, so a bare `.optional()` does not accept it — `.min(1)`
 * still rejects `''`. Normalise blank to undefined first, then allow absence.
 * This never substitutes a value; absent stays absent.
 */
const blankAsAbsent = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).optional(),
  );

/** A secret that must be present and non-trivial. No default, ever. */
const requiredSecret = (minLength = 16) =>
  z
    .string({ required_error: 'is required' })
    .trim()
    .min(minLength, `must be at least ${minLength} characters`);

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** IANA zone driving every business-day boundary. See src/lib/datetime.ts. */
  APP_TIMEZONE: z.string().trim().min(1).default('Asia/Manila'),

  DATABASE_URL: z
    .string()
    .trim()
    .min(1, 'is required')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /**
   * The SYSTEM connection `systemTransaction()` uses (T-251a, bible §13 row 185) — optional,
   * same postgres:// shape as `DATABASE_URL`. Unset in every environment this task touches (local
   * dev, CI, every lane DB); `systemTransaction()` falls back to `DATABASE_URL` when absent, so
   * this variable existing changes nothing until something explicitly sets it.
   */
  SYSTEM_DATABASE_URL: blankAsAbsent().refine(
    (v) => v === undefined || v.startsWith('postgres://') || v.startsWith('postgresql://'),
    { message: 'must be a postgres:// or postgresql:// connection string' },
  ),

  /**
   * Firebase Admin credentials — the IdP side of §7.1.
   *
   * REQUIRED IN PRODUCTION, optional in development/test until the auth bridge
   * lands (Phase 0 T-006). Nothing reads these yet, and Phase 1 is schema and the
   * posting engine — no auth on the path. Demanding them now blocks local dev on
   * credentials the code does not use, which is what HANDOFF.md §4 already promised
   * you would not have to supply ("Firebase values can stay blank until T-006").
   *
   * This is NOT a §7 rule 9 fallback: nothing is defaulted, and no insecure value is
   * substituted. The variable is simply not yet required by any code path. In
   * production it stays hard-required, enforced by the superRefine below.
   */
  FIREBASE_PROJECT_ID: blankAsAbsent(),
  FIREBASE_SERVICE_ACCOUNT_KEY: blankAsAbsent(),

  /**
   * The same credential as above, given as a PATH instead of a value — the form `capture.ts`
   * already prefers, for the reason it gives: the key never enters an env var, a shell history, a
   * process listing, or a `printenv` dump. `secrets/` is gitignored.
   *
   * ⛔ Setting BOTH this and `FIREBASE_SERVICE_ACCOUNT_KEY` is rejected where they are consumed,
   * not silently resolved — a precedence rule is a rule nobody remembers under pressure.
   */
  FIREBASE_SERVICE_ACCOUNT_KEY_FILE: blankAsAbsent(),

  /**
   * The PRIVATE bucket holding accounting documents — receipts, proofs, exports. T-141, bible
   * row 155.
   *
   * ⛔ **This is NOT `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, and the two must never hold the same
   * value.** That one is client-visible by construction and names the project's DEFAULT bucket,
   * whose rule is `allow read;` — world-readable, unauthenticated. That is correct for menu photos
   * and catastrophic for supplier invoices, which carry suppliers, prices and volumes and are kept
   * for years. Storage splits by what the FILE is, not by which app wrote it.
   *
   * ⚠️ Server-only on purpose: the bucket is deny-all and reachable only through the Admin SDK,
   * so a browser has no use for its name — and shipping it to one advertises the target.
   *
   * Blank means storage is not configured; `resolveStorageDriver()` then serves the in-memory
   * driver and refuses to do so the moment this IS set.
   */
  FIREBASE_STORAGE_BUCKET: blankAsAbsent(),

  /**
   * T-177. POS's external, key-scoped API (`docs/CROSS-APP-MAP.md` §3) — `GET
   * {POS_API_URL}/api/external/sold-items`, the daily usage pull's snapshot source. Optional for
   * the same reason `FIREBASE_*` is above: nothing calls it outside this one feature, and demanding
   * it blocks local dev on a credential most work does not touch.
   */
  POS_API_URL: blankAsAbsent(),
  POS_API_KEY: blankAsAbsent(),

  /** Signs shared-terminal session tokens (bible §7.1). Never defaulted. */
  SESSION_SECRET: requiredSecret(32),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
})
  .superRefine((cfg, ctx) => {
    // Fail closed in production: the auth bridge is live there, so a missing
    // credential must abort startup rather than degrade silently.
    if (cfg.NODE_ENV !== 'production') return;
    if (!cfg.FIREBASE_PROJECT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_ID'],
        message: 'is required in production',
      });
    }
    // ⚠️ EITHER form satisfies this. Requiring the inline one specifically would mean a production
    // deploy using the safer file form fails to boot — which would push people back to pasting the
    // key into an env var, the exact thing the file form exists to avoid.
    if (!cfg.FIREBASE_SERVICE_ACCOUNT_KEY && !cfg.FIREBASE_SERVICE_ACCOUNT_KEY_FILE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_SERVICE_ACCOUNT_KEY'],
        message: 'is required in production (or FIREBASE_SERVICE_ACCOUNT_KEY_FILE)',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

function loadServerEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    // Deliberately loud, deliberately fatal. A half-configured ERP is worse than
    // one that refuses to start: it will silently write wrong data.
    const message =
      '\n' +
      '='.repeat(72) +
      '\nShareat System REFUSED TO START — environment is incomplete or invalid.\n' +
      '='.repeat(72) +
      '\n' +
      formatIssues(parsed.error) +
      '\n\nFix .env.local (see .env.example for the full contract).\n' +
      'Nothing is defaulted on purpose — see PROJECT_BIBLE.md §7 rule 9.\n' +
      '='.repeat(72) +
      '\n';

    throw new Error(message);
  }

  return parsed.data;
}

let cached: ServerEnv | undefined;

/**
 * Server-only environment. Throws on first access if anything required is missing.
 * Never call this from a Client Component.
 */
export function env(): ServerEnv {
  if (!isServer) {
    throw new Error(
      'env() is server-only. Client code must use publicEnv() — never read secrets in the browser.',
    );
  }
  cached ??= loadServerEnv();
  return cached;
}

/**
 * ⭐ **Three required, two optional, and the split is IDENTITY versus everything else** — T-232
 * slice 1, which gave this function its first caller (`sign-in/EmailSignInForm.tsx`).
 *
 * `signInWithEmailAndPassword` needs an api key, an auth domain and a project id. That is the whole
 * list; Firebase Auth never reads the other two.
 *
 * ⛔ So the other two must not be able to hide the sign-in form, and one of them **belongs to a
 * different project**: identity is v1's Firebase project and storage is `shareat-hub-v2`
 * (T-232 decision 1, `.env.example`). A blank storage bucket describing another project's default
 * bucket is not a reason to refuse a person their own books — it is a reason for whatever wants a
 * bucket to fail, and nothing on this path wants one. `NEXT_PUBLIC_FIREBASE_APP_ID` is optional for
 * the same reason: it identifies the app to Analytics and Installations, neither of which is on any
 * path here (`terminal/firebase.ts` already treats it as absent-able, defaulting it to `'emulator'`).
 *
 * ⚠️ **This is not a §7 rule 9 fallback.** Nothing is defaulted and no insecure value is
 * substituted: absent stays absent, and a consumer that genuinely needs one of the two must demand
 * it at its own call site. The three that identity depends on stay hard-required, so a build with a
 * blank api key fails loudly at the form rather than silently signing in against nothing.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: blankAsAbsent(),
  NEXT_PUBLIC_FIREBASE_APP_ID: blankAsAbsent(),
});

export type PublicEnv = z.infer<typeof publicSchema>;

/**
 * Browser-safe config. These values are public by design (Firebase client keys are
 * not secrets — access is governed by security rules and server-side authorization).
 * Must be referenced statically so Next.js can inline them at build time.
 */
export function publicEnv(): PublicEnv {
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  });

  if (!parsed.success) {
    throw new Error(
      'Public Firebase config is incomplete:\n' + formatIssues(parsed.error),
    );
  }
  return parsed.data;
}

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

  FIREBASE_PROJECT_ID: z.string().trim().min(1, 'is required'),
  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().trim().min(1, 'is required'),

  /** Signs shared-terminal session tokens (bible §7.1). Never defaulted. */
  SESSION_SECRET: requiredSecret(32),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
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
      '\nERPv2 REFUSED TO START — environment is incomplete or invalid.\n' +
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

const publicSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().trim().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().trim().min(1),
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

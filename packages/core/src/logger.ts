/**
 * Structured logging.
 *
 * PROJECT_BIBLE.md §15.6: "v1's defining pathology is SILENT FAILURE — rules that deny
 * quietly, cleanups that report success and change nothing, dead-lettered punches nobody
 * sees. Every swallowed exception is a defect. Every background job reports success WITH
 * COUNTS, never a bare 'done'."
 *
 * Rules:
 *   - Never `catch {}`. If you catch, you log with context and either rethrow or handle.
 *   - Never log a secret, token, password, or biometric template.
 *   - Background jobs use `jobResult()` so "it ran" is always accompanied by "it did N".
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Keys whose values are redacted wherever they appear. Add to this list rather than
 * remembering not to log something.
 *
 * T-495 S2 (DEF-792) - the supported contract: a sensitive key is redacted at the root and at up to
 * FOUR levels of nesting (`k`, `*.k`, `*.*.k`, `*.*.*.k`, `*.*.*.*.k`), in a payload or in a child
 * logger's bindings. Deeper than that, or inside a free-text message, is NOT covered - keep secrets
 * out of those. The paths are generated from this one list so a key cannot be protected at one depth
 * and forgotten at another.
 */
const SENSITIVE_KEYS = [
  'password',
  'passcode',
  'pin',
  'secret',
  'token',
  'accessToken',
  'idToken',
  'sessionToken',
  'authorization',
  'serviceAccount',
  'privateKey',
  'DATABASE_URL',
  'template', // biometric templates - never logged
];

const REDACT_DEPTH = 4;

export const REDACT_CENSOR = '[REDACTED]';
export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) =>
  Array.from({ length: REDACT_DEPTH + 1 }, (_, depth) => `${'*.'.repeat(depth)}${key}`),
);

export const logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  base: { app: 'shareat-system' },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' },
        },
      }
    : {}),
});

/**
 * A logger bound to one request or job, so every line can be traced back.
 * Pass the id through the whole call chain rather than generating a new one per layer.
 */
export function childLogger(bindings: {
  correlationId: string;
  actorId?: string;
  storeId?: string;
  [k: string]: unknown;
}) {
  return logger.child(bindings);
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

/**
 * Report the outcome of a background job. Counts are mandatory.
 *
 * Bad:  logger.info('sync complete')
 * Good: jobResult('mirror-publisher', { processed: 128, skipped: 3, failed: 0 })
 *
 * A job that reports success with zero detail is how v1 hid its dead letters.
 */
export function jobResult(
  job: string,
  counts: Record<string, number>,
  extra?: Record<string, unknown>,
) {
  // T-495 S3 (DEF-793) - bible 15.6 made counts mandatory in a comment; this is the code. A job that cannot say what it did must not look finished.
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    throw new TypeError(`jobResult(${job}): counts are mandatory - report what the job processed, skipped and failed (bible 15.6).`);
  }
  for (const [name, n] of entries) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw new TypeError(`jobResult(${job}): count "${name}" must be a finite number of zero or more, got ${String(n)}.`);
    }
  }
  // `failed` and `errors` are independent indicators: either one above zero makes the line an error (a zero in one must never hide the other).
  const failed = (counts.failed ?? 0) + (counts.errors ?? 0);
  const line = { job, ...counts, ...extra };
  if (failed > 0) {
    logger.error(line, `${job} finished WITH FAILURES`);
  } else {
    logger.info(line, `${job} finished`);
  }
}

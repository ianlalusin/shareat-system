import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db/client';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Error text is returned to the caller ONLY outside production. This endpoint is
 * unauthenticated; in production it must not describe which variables are unset or
 * echo connection-string fragments. The full error always goes to the server log.
 * process.env is read directly here because env() itself may be what failed.
 */
function detailFor(error: unknown): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Liveness, configuration validity, and database reachability.
 *
 * Reports a 503 with the failing subsystem NAMED rather than a generic 500: a health
 * check that cannot say WHAT is wrong is the silent-failure pattern this project exists
 * to remove (PROJECT_BIBLE.md §15.6). Configuration and database are checked and
 * reported separately for the same reason — see bible §13 row 72.
 *
 * Responses:
 *   200  { status: 'ok',       configuration: 'valid',   database: 'reachable'  }
 *   503  { status: 'degraded', configuration: 'invalid', database: 'unknown'    }
 *   503  { status: 'degraded', configuration: 'valid',   database: 'unreachable'}
 */
export async function GET() {
  const startedAt = Date.now();

  // Configuration is checked FIRST and reported separately. env() throws when the
  // environment contract is unmet, and that is not a database fault — collapsing the
  // two sends you to debug the wrong subsystem, which is precisely the failure this
  // route claims to prevent. (It did exactly that once: a missing Firebase variable
  // was reported as "database unreachable" while Postgres was perfectly healthy.)
  try {
    env();
  } catch (error) {
    logger.error({ err: error }, 'health check failed: environment invalid');
    return NextResponse.json(
      {
        status: 'degraded',
        configuration: 'invalid',
        database: 'unknown',
        detail: detailFor(error),
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  try {
    await getSql()`select 1 as ok`;
    return NextResponse.json({
      status: 'ok',
      configuration: 'valid',
      database: 'reachable',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, 'health check failed: database unreachable');
    return NextResponse.json(
      {
        status: 'degraded',
        configuration: 'valid',
        database: 'unreachable',
        detail: detailFor(error),
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}

import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db/client';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Liveness + database reachability.
 *
 * Deliberately reports the DB as unhealthy with a 503 rather than throwing a generic 500:
 * a health check that cannot say WHAT is wrong is the silent-failure pattern this project
 * exists to remove (PROJECT_BIBLE.md §15.6).
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    await getSql()`select 1 as ok`;
    return NextResponse.json({
      status: 'ok',
      database: 'reachable',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, 'health check failed: database unreachable');
    return NextResponse.json(
      {
        status: 'degraded',
        database: 'unreachable',
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}

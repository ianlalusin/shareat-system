/**
 * scripts/capture.ts — the T-114a CLI. docs/tasks/114a-firestore-reader-and-capture.md
 * Contract §4.
 *
 * `npm run capture -- --store <code> --collection journal --collection expenses`
 * `npm run capture -- --store <code> --collection journal --fetch --limit 200`
 *
 * Count-first, always. Every run names its stores and collections EXPLICITLY — there is no
 * "read everything" default and no flag that means it (task's non-negotiable table, row 2).
 * No arguments at all is a usage error, not a default that reads anything (Contract §4).
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { createErpFirestoreClient } from '../packages/etl-firestore/src/client';
import { formatCountTable, planCapture, runPlan, PlanError } from '../packages/etl-firestore/src/plan';

const USAGE = `
Usage:
  npm run capture -- --store <code> [--store <code> ...] --collection <name> [--collection <name> ...] [--fetch] [--limit N]

Examples:
  npm run capture -- --store <code> --collection journal --collection expenses
  npm run capture -- --store <code> --collection journal --fetch --limit 200

Rules:
  - At least one --store and one --collection are required. There is no default.
  - "--store all" is NOT implemented. Name stores explicitly.
  - Without --fetch, this counts only and stops. --fetch is required to read any document.
`.trim();

interface ParsedArgs {
  stores: string[];
  collections: string[];
  fetch: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const stores: string[] = [];
  const collections: string[] = [];
  let fetch = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--store': {
        const value = argv[++i];
        if (!value) throw new PlanError('--store requires a value');
        stores.push(value);
        break;
      }
      case '--collection': {
        const value = argv[++i];
        if (!value) throw new PlanError('--collection requires a value');
        collections.push(value);
        break;
      }
      case '--fetch':
        fetch = true;
        break;
      case '--limit': {
        const value = argv[++i];
        const n = Number(value);
        if (!value || !Number.isFinite(n) || n <= 0) {
          throw new PlanError(`--limit requires a positive number, got ${String(value)}`);
        }
        limit = n;
        break;
      }
      default:
        throw new PlanError(`Unrecognised argument: ${arg}`);
    }
  }

  return { stores, collections, fetch, limit };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(argv);

  const client = createErpFirestoreClient();
  if ('skipped' in client) {
    console.error(client.reason);
    process.exitCode = 1;
    return;
  }

  const plan = planCapture({ storeCodes: args.stores, collections: args.collections });

  console.log(`Plan: ${plan.targets.length} target(s) across ${args.stores.length} store(s), ${args.collections.length} collection(s).`);
  console.log(args.fetch ? `Mode: FETCH (limit ${args.limit ?? 'none'} per target)` : 'Mode: COUNT ONLY');
  console.log('');

  const result = await runPlan(plan, client.firestore, 'erp_v1', {
    fetch: args.fetch,
    limitPerCollection: args.limit,
    startedBy: 'cli:capture',
  });

  console.log(formatCountTable(result.counts));

  if (!result.fetched) {
    console.log('\nCount-only run — no documents were read. Pass --fetch to actually read them.');
    return;
  }

  const capture = result.captureResult!;
  console.log(`\nRun id: ${capture.runId}`);
  console.log('Reconciliation (per collection):');
  for (const row of capture.perCollection) {
    console.log(
      `  ${row.collectionPath}: source=${row.sourceCount} landed=${row.landedCount} newlyLanded=${row.newlyLanded}`,
    );
  }
}

main().catch((err: unknown) => {
  // Never the raw error object verbatim in case it carries anything sensitive up the stack —
  // just its message, matching capture.ts's own discipline (task's "never print key material").
  console.error('capture failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

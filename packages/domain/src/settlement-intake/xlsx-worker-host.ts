/**
 * T-511 S3 - runs read-excel-file in a worker thread. We cannot predict what the library does with a hostile worksheet (it builds a dense
 * grid from cell references, re-scans unfinished tokens quadratically, and one tiny file can ask for gigabytes or minutes), so the
 * library runs in a worker with a memory limit, and the main thread arms a wall-clock timer and terminates the worker. The main thread
 * never blocks and its heap is untouched: a file that hits the limit is refused as XLSX_TOO_HEAVY, one that runs out of time as
 * XLSX_TOO_SLOW. A worker that cannot start at all is XLSX_WORKER_UNAVAILABLE (a deployment problem, not a bad upload). Any other failure
 * (the library's own error, a worker that exits without answering, a malformed message) is FOODPANDA_NO_SHEETS, never a hang.
 *
 * WHAT THE WORKER IS GIVEN: only a workbook that `normalizeXlsx` has re-packed (true sizes, stored). The library walks local headers and
 * allocates what they declare outside the V8 heap, so the original bytes must never reach it (see `zip-repack.ts`).
 *
 * CONCURRENCY: at most WORKER_CONCURRENCY workers run at once (a hostile one costs about 200 MB); further calls wait in a FIFO queue.
 * A slot is released only when its worker is gone, however it ended. The timeout clock starts when the worker starts, not when queued.
 *
 * ASSUMPTION TO PROVE IN SLICE 4 (the ERP server bundle): the worker is started with `new Worker(new URL('./xlsx-worker.mjs',
 * import.meta.url))`. That works under vitest and under plain Node. A Next.js server build may relocate or inline files, so the worker
 * file might not sit next to this module at run time. For slice 4: resolve it at run time outside the bundler (from `process.cwd()` to
 * `packages/domain/src/settlement-intake/xlsx-worker.mjs`, falling back to the `import.meta.url` form), and list `read-excel-file` and
 * `yauzl` in `serverExternalPackages`. This is the ONLY place that resolves the path; pass `workerUrl` or change it here.
 */
import { Worker } from 'node:worker_threads';
import { intakeRefusal } from './refusal';

export const XLSX_WORKER_TIMEOUT_MS = 5000;
export const XLSX_WORKER_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } as const;
export const WORKER_CONCURRENCY = 2;

/** The rows of the two Foodpanda sheets as plain arrays; a sheet that is not in the workbook is null. */
export interface WorkerSheets {
  a: unknown[][] | null;
  b: unknown[][] | null;
}

const unreadable = (): Error => intakeRefusal('FOODPANDA_NO_SHEETS', 'The workbook could not be read as a spreadsheet.');
const tooHeavy = (): Error => intakeRefusal('XLSX_TOO_HEAVY', 'The workbook needs more memory to open than an invoice should, so it was refused.');
const tooSlow = (): Error => intakeRefusal('XLSX_TOO_SLOW', 'The workbook took too long to open, so it was refused.');
const unavailable = (): Error =>
  intakeRefusal('XLSX_WORKER_UNAVAILABLE', 'The workbook reader could not start on the server, so nothing was read. The file itself may be fine; tell an administrator.');

/** Errors that mean the worker could not even be loaded (as opposed to the file making it fail). */
const START_FAILURES = new Set([
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_WORKER_PATH',
  'ERR_WORKER_INIT_FAILED',
  'ERR_WORKER_UNSUPPORTED_EXTENSION',
  'ERR_INVALID_URL',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ENOENT',
  'EACCES',
]);

let running = 0;
const waiting: (() => void)[] = [];
const acquire = (): Promise<void> => {
  if (running < WORKER_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
};
/** Hands the slot straight to the next waiter (the count stays), or frees it. */
const release = (): void => {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
};

function runWorker(workbook: Buffer, options: { workerUrl?: URL; timeoutMs?: number }, onGone: () => void): Promise<WorkerSheets> {
  return new Promise<WorkerSheets>((resolve, reject) => {
    let settled = false;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let worker: Worker | undefined;
    const markGone = (): void => {
      if (gone) return;
      gone = true;
      onGone();
    };
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (worker) worker.terminate().then(markGone, markGone);
      outcome();
    };
    try {
      worker = new Worker(options.workerUrl ?? new URL('./xlsx-worker.mjs', import.meta.url), {
        resourceLimits: { ...XLSX_WORKER_LIMITS },
        workerData: { workbook },
      });
    } catch {
      settled = true;
      markGone();
      reject(unavailable());
      return;
    }
    timer = setTimeout(() => finish(() => reject(tooSlow())), options.timeoutMs ?? XLSX_WORKER_TIMEOUT_MS);
    worker.on('message', (m: unknown) =>
      finish(() => {
        const msg = m as { ok?: unknown; a?: unknown; b?: unknown } | null;
        if (msg && msg.ok === true) resolve({ a: Array.isArray(msg.a) ? (msg.a as unknown[][]) : null, b: Array.isArray(msg.b) ? (msg.b as unknown[][]) : null });
        else reject(unreadable());
      }),
    );
    worker.on('error', (e: Error & { code?: string }) =>
      finish(() => reject(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? tooHeavy() : e.code !== undefined && START_FAILURES.has(e.code) ? unavailable() : unreadable())),
    );
    // A worker that exits without having answered is refused, not waited for.
    worker.on('exit', () => {
      finish(() => reject(unreadable()));
      markGone();
    });
  });
}

/**
 * `workerUrl` and `timeoutMs` exist for tests (a stub worker, a short timer); production callers pass only the (re-packed) workbook.
 */
export async function readSheetsInWorker(workbook: Buffer, options: { workerUrl?: URL; timeoutMs?: number } = {}): Promise<WorkerSheets> {
  await acquire();
  return runWorker(workbook, options, release);
}

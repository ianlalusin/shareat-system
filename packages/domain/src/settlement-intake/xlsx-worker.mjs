/**
 * T-511 S3 - the worker entry that runs read-excel-file (see `xlsx-worker-host.ts`). Plain ESM, no TypeScript, so a worker thread can load it
 * as it stands. It receives the workbook bytes in `workerData`, reads the sheets "Appendix A" and "Appendix B" by name and posts plain
 * arrays back (`{ ok: true, a, b }`, a sheet that is not in the workbook is null) or `{ ok: false, message }` when the library fails.
 * Memory and time are limited by the host, which terminates this thread; nothing here is trusted to stay small.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readSheet } from 'read-excel-file/node';

async function sheetOrNull(workbook, name) {
  try {
    return await readSheet(workbook, name);
  } catch (e) {
    if (e && e.name === 'SheetNotFoundError') return null;
    throw e;
  }
}

try {
  const workbook = Buffer.from(workerData.workbook);
  const a = await sheetOrNull(workbook, 'Appendix A');
  const b = await sheetOrNull(workbook, 'Appendix B');
  parentPort.postMessage({ ok: true, a, b });
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e).slice(0, 200) });
}

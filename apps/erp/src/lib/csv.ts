/**
 * The one shared CSV export path — T-209c. Every report's export route calls `toCsv`/`csvResponse`
 * rather than hand-rolling its own `join(',')`, which gets a value containing a comma, a quote, or
 * a newline wrong.
 * The cell rule (formula-neutralising and quoting) lives in `@shareat/core/csv`, one copy for ERP and the domain.
 */

import { escapeCsvCell } from '@shareat/core/csv';

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/**
 * A CSV download response - `Content-Disposition: attachment` so the browser saves it.
 * `bom` puts a UTF-8 byte-order mark first so Excel reads names with n-tilde or the peso sign correctly; `noStore` keeps the file out of shared caches (personal data).
 */
export function csvResponse(
  filename: string,
  headers: string[],
  rows: (string | number)[][],
  opts: { bom?: boolean; noStore?: boolean } = {},
): Response {
  return new Response((opts.bom ? '\uFEFF' : '') + toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...(opts.noStore ? { 'Cache-Control': 'private, no-store' } : {}),
    },
  });
}

/**
 * The one shared CSV export path — T-209c. Every report's export route calls `toCsv`/`csvResponse`
 * rather than hand-rolling its own `join(',')`, which gets a value containing a comma, a quote, or
 * a newline wrong.
 */

function escapeCell(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** A CSV download response — `Content-Disposition: attachment` so the browser saves it. */
export function csvResponse(filename: string, headers: string[], rows: (string | number)[][]): Response {
  return new Response(toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

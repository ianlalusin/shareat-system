/**
 * The one CSV cell rule — T-498 S2 / DEF-800. Every CSV writer in the tree (the ERP report exports and the leave
 * register) calls `escapeCsvCell`; nobody hand-rolls it.
 *
 * Two jobs, in this order:
 *  1. A STRING cell whose first character is `= + - @ TAB CR` is read by Excel and Google Sheets as a formula, so it
 *     gets a leading `'` (OWASP CSV-injection guidance) and shows as text.
 *  2. Then the usual quoting: a cell with a comma, quote or newline is wrapped in `"` with inner quotes doubled.
 *
 * Exceptions, so numbers stay numbers: a JS `number` is never prefixed, and neither is a string that is a plain
 * number or a peso figure.
 */

/**
 * A plain number or money figure that must NOT be prefixed. Our exports emit money through `formatMoney`
 * (`Intl.NumberFormat('en-PH', PHP)`), which gives `₱1,234.50` and, for a negative, `-₱303.03` (sign before the
 * symbol). Also allowed: the same with the sign after the symbol (`₱-303.03`), and bare `-12` / `-1,234.50`.
 * Only a minus is allowed as a sign: a leading `+` is never a number we emit. `-1+1` and `-1,23` do not match, so
 * they are prefixed.
 */
const PLAIN_NUMBER_OR_PESO = /^(?:-?₱-?|-)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s) && !PLAIN_NUMBER_OR_PESO.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** One record of a parsed CSV file: its cells, and the physical line it STARTS on (1 = the first line of the file). */
export interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * T-502 S4. A small CSV reader (no dependency): comma separated, `"` quotes a cell, `""` inside quotes is one quote, a quoted
 * cell may hold commas and line breaks, CRLF / LF / lone CR end a record, a leading UTF-8 byte-order mark is dropped.
 * Records whose every cell is blank (blank lines, trailing lines) are skipped. Cells are returned exactly as written - trimming
 * and any meaning are the caller's. Throws a plain sentence when a quote is never closed.
 */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let quotedLine = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      quotedLine = line;
    } else if (ch === ',') endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (inQuotes) throw new Error(`A quoted cell that starts on line ${quotedLine} is never closed. Check the quotation marks in the file.`);
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

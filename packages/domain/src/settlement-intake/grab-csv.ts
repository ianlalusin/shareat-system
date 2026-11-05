/**
 * T-511 S3 - what the two Grab readers share: strict decoding, the header check, the cell parsers and the date parser.
 * The CSV itself is parsed by the readers with `@shareat/core/csv` (the one CSV parser); this file only handles what comes back.
 * Internal to the folder: the barrel exports `parseGrabDateTime` through `grab-transactions.ts`.
 */
import type { CsvRecord } from '@shareat/core/csv';
import type { Money } from '@shareat/core/money';
import { parseDecimalInput } from '../shared/money-input';
import { intakeRefusal, megabytes, shown, type SettlementIntakeRefusal } from './refusal';

export const GRAB_MAX_BYTES = 3 * 1024 * 1024;
export const GRAB_MAX_ROWS = 10_000;

/** Manila wall clock exactly as printed: `date` is the business day, `time` is HH:MM on a 24-hour clock. */
export interface GrabDateTime {
  date: string;
  time: string;
}

/** Length 0, over 3 MB, or not valid UTF-8 are refused before any CSV parsing; a BOM is stripped by the decoder. */
export function decodeGrabText(bytes: Buffer): string {
  if (bytes.length === 0) throw intakeRefusal('FILE_EMPTY', 'The file is empty, so there is nothing to read.');
  if (bytes.length > GRAB_MAX_BYTES) {
    throw intakeRefusal('FILE_TOO_BIG', `The file is ${megabytes(bytes.length)} MB, over the ${megabytes(GRAB_MAX_BYTES)} MB limit.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw intakeRefusal('GRAB_BAD_VALUE', 'The file is not plain UTF-8 text, so it cannot be read as a Grab export.');
  }
}

/** `parseCsv` has one failure, a quoted cell that never closes. */
export function csvFailure(e: unknown): SettlementIntakeRefusal {
  const line = e instanceof Error ? /line (\d+)/.exec(e.message)?.[1] : undefined;
  return intakeRefusal('GRAB_BAD_ROW', line ? `A quoted cell that starts on line ${line} is never closed.` : 'A quoted cell in the file is never closed.');
}

export interface GrabTable {
  /** trimmed header text -> column position */
  index: ReadonlyMap<string, number>;
  rows: CsvRecord[];
}

/**
 * The header must be EXACTLY the known set (trimmed text, any order): a missing header or an unknown one stops the file with its name.
 * Then the data rows: none, too many, or a ragged one each refuse.
 */
export function grabTable(records: CsvRecord[], expected: readonly string[]): GrabTable {
  const [head, ...rows] = records;
  if (!head) throw intakeRefusal('FILE_EMPTY', 'The file is empty, so there is nothing to read.');
  const index = new Map<string, number>();
  head.cells.forEach((raw, at) => {
    const name = raw.trim();
    if (index.has(name)) throw intakeRefusal('GRAB_UNKNOWN_COLUMN', `The column "${shown(name)}" appears more than once in the header.`);
    index.set(name, at);
  });
  for (const name of expected) {
    if (!index.has(name)) throw intakeRefusal('GRAB_MISSING_COLUMN', `The column "${name}" is missing from the header.`);
  }
  const known = new Set(expected);
  for (const name of index.keys()) {
    if (!known.has(name)) throw intakeRefusal('GRAB_UNKNOWN_COLUMN', `The column "${shown(name)}" is not one this system knows.`);
  }
  if (rows.length === 0) throw intakeRefusal('GRAB_NO_ROWS', 'The file has a header but no rows, so it is probably the wrong file.');
  if (rows.length > GRAB_MAX_ROWS) {
    throw intakeRefusal('GRAB_TOO_MANY_ROWS', `The file has ${rows.length.toLocaleString('en-US')} rows, over the ${GRAB_MAX_ROWS.toLocaleString('en-US')} row limit.`);
  }
  for (const r of rows) {
    if (r.cells.length !== head.cells.length) {
      throw intakeRefusal('GRAB_BAD_ROW', `Line ${r.line} has ${r.cells.length} values but the header has ${head.cells.length}.`);
    }
  }
  return { index, rows };
}

/** One cell by header name (the header check guarantees the name exists); never trimmed here. */
export function cellOf(table: GrabTable, row: CsvRecord, name: string): string {
  return row.cells[table.index.get(name) as number] ?? '';
}

/** A money cell: empty is null (not applicable, distinct from 0); anything else must be a plain number with at most two decimals. */
export function grabMoney(raw: string, column: string, line: number): Money | null {
  try {
    return parseDecimalInput(raw, '14,2', column, column, { blank: 'null' });
  } catch {
    throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "${column}": "${shown(raw)}" is not a valid amount. Use a plain number with at most two decimal places.`);
  }
}

export function grabMoneyRequired(raw: string, column: string, line: number): Money {
  const value = grabMoney(raw, column, line);
  if (value === null) throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "${column}": an amount is required and the cell is empty.`);
  return value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
// hour is 1-12 and minute 00-59 in the pattern itself (a 12-hour clock has no hour 0); the day is checked against the calendar below.
const DATE_TIME = /^([0-9]{1,2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([1-9]|1[0-2]):([0-5][0-9]) (AM|PM)$/;
const two = (n: number): string => String(n).padStart(2, '0');

function readDateTime(text: string): GrabDateTime | null {
  const m = DATE_TIME.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2] as (typeof MONTHS)[number]);
  const year = Number(m[3]);
  const hour12 = Number(m[4]);
  if (month < 0) return null;
  const calendar = new Date(Date.UTC(year, month, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day) return null;
  const hour = (hour12 % 12) + (m[6] === 'PM' ? 12 : 0);
  return { date: `${m[3]}-${two(month + 1)}-${two(day)}`, time: `${two(hour)}:${m[5]}` };
}

/** `d Mon yyyy h:mm AM/PM` (English month, non-padded day and hour, no seconds, no zone) into the printed Manila date and time. */
export function parseGrabDateTime(text: string): GrabDateTime {
  const parsed = readDateTime(text);
  if (!parsed) throw intakeRefusal('GRAB_BAD_VALUE', `"${shown(text)}" is not a date in the form d Mon yyyy h:mm AM/PM.`);
  return parsed;
}

/** The same, naming the column and the line for a cell. */
export function grabDateTime(raw: string, column: string, line: number): GrabDateTime {
  const parsed = readDateTime(raw);
  if (!parsed) throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "${column}": "${shown(raw)}" is not a date in the form d Mon yyyy h:mm AM/PM.`);
  return parsed;
}

/** One Store ID per file, and it must not be blank; the sentence never prints an id. */
export function checkStore(first: string | null, raw: string, line: number): string {
  const storeId = raw.trim();
  if (storeId === '') throw intakeRefusal('GRAB_BAD_VALUE', `Line ${line}, column "Store ID": the cell is empty.`);
  if (first !== null && storeId !== first) {
    throw intakeRefusal('GRAB_MIXED_STORES', `The file holds more than one store (see line ${line}). Upload one store's file at a time.`);
  }
  return storeId;
}

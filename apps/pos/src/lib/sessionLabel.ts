/** Human labels for a session in cashier dialogs. Ala Carte sessions store tableNumber "N/A". */

type TableFields = {
  sessionMode?: string | null;
  tableDisplayName?: string | null;
  tableNumber?: string | number | null;
};

const isBlankOrNA = (v: string) => v === '' || v.toLowerCase() === 'n/a';

/** "Patio 3" / "Table 3", or null when the session has no real table (Ala Carte, N/A, empty). */
export function sessionTableLabel(s: TableFields): string | null {
  if (s.sessionMode === 'alacarte') return null;
  const number = s.tableNumber == null ? '' : String(s.tableNumber).trim();
  const name = (s.tableDisplayName ?? '').trim();
  if (isBlankOrNA(number) && isBlankOrNA(name)) return null;
  if (!isBlankOrNA(name)) return name;
  return `Table ${number}`;
}

/** Label for link/loyalty dialogs: table label, else the Ala Carte customer name, else undefined. */
export function sessionDialogLabel(
  s: TableFields & { customerName?: string | null; customer?: { name?: string | null } | null },
): string | undefined {
  const table = sessionTableLabel(s);
  if (table) return table;
  if (s.sessionMode === 'alacarte') return s.customer?.name || s.customerName || 'Ala Carte';
  return undefined;
}

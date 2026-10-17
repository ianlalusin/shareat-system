/**
 * T-438 (bible row 360, spec N2 + N4): how a person's name is written and compared. PURE - no imports, so the unit tests run
 * without a database.
 *
 * `formatDisplayName` is the one TypeScript formatter; migration 0207's `persons_name_parts_check` is the one SQL expression, and
 * `t438-person-name-check` case D2 proves they agree. (`personsRepo.insertPerson` / `setPersonName` carry a three-line copy so the
 * db package need not import the domain; the CHECK refuses any drift between the two.)
 */
export interface NameParts {
  lastName: string;
  firstName: string;
  middleName?: string | null;
}

/** Trim, and collapse each inner run of whitespace to one space. */
export function normaliseNamePart(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** The three parts as they are stored: normalised, and a blank middle name is `null` (never ''). */
export function normaliseName(p: NameParts): { lastName: string; firstName: string; middleName: string | null } {
  const middle = normaliseNamePart(p.middleName ?? '');
  return { lastName: normaliseNamePart(p.lastName), firstName: normaliseNamePart(p.firstName), middleName: middle === '' ? null : middle };
}

/** "Last, First M." - the middle name is shown as its upper-cased first letter and a period; none means nothing is added. */
export function formatDisplayName(p: NameParts): string {
  const n = normaliseName(p);
  const initial = n.middleName === null ? '' : ` ${(Array.from(n.middleName)[0] ?? '').toUpperCase()}.`;
  return `${n.lastName}, ${n.firstName}${initial}`;
}

/**
 * Order- and case-insensitive identity of a name: lower-case, apostrophes dropped, other punctuation read as a space, words split,
 * one-letter words dropped (a middle initial does not count), sorted, joined. So legacy `Maria Santos`, `Santos, Maria C.` and a typed
 * `Santos` / `Maria` all share one key.
 */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => Array.from(w).length > 1)
    .sort()
    .join(' ');
}

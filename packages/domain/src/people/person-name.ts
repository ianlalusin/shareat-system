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

/**
 * NFC, trim, collapse each inner run of whitespace to one space, and capitalise the first letter of each word - only when
 * `toUpperCase()` yields exactly one character (so "ß" and ligatures are kept as typed). Locale-free on purpose: the SQL CHECK
 * (migration 0207) compares text with NO upper()/lower(), so the stored initial is already final.
 */
export function normaliseNamePart(s: string): string {
  return s
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => {
      const [first = ''] = Array.from(w);
      const up = first.toUpperCase();
      return first !== '' && Array.from(up).length === 1 ? up + w.slice(first.length) : w;
    })
    .join(' ');
}

/** The three parts as they are stored: normalised, and a blank middle name is `null` (never ''). */
export function normaliseName(p: NameParts): { lastName: string; firstName: string; middleName: string | null } {
  const middle = normaliseNamePart(p.middleName ?? '');
  return { lastName: normaliseNamePart(p.lastName), firstName: normaliseNamePart(p.firstName), middleName: middle === '' ? null : middle };
}

/** "Last, First M." - the middle name is shown as its first character (already capitalised by normalisation) and a period. */
export function formatDisplayName(p: NameParts): string {
  const n = normaliseName(p);
  const initial = n.middleName === null ? '' : ` ${Array.from(n.middleName)[0] ?? ''}.`;
  return `${n.lastName}, ${n.firstName}${initial}`;
}

/**
 * Order- and case-insensitive identity of a name: lower-case, apostrophes dropped, other punctuation read as a space, words split,
 * accents folded (Pena = Peña), hyphens read as spaces, one-letter words dropped (a middle initial does not count), sorted, joined. So legacy `Maria Santos`, `Santos, Maria C.` and a typed
 * `Santos` / `Maria` all share one key.
 */
export function nameKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => Array.from(w).length > 1)
    .sort()
    .join(' ');
}

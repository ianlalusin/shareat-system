/**
 * T-405 — the one place a person is rendered on screen (bible row 229: names, never ids).
 * Pure: no React, no DB.
 */

/** Shown when a person id is present but no usable name is found. */
export const UNKNOWN_PERSON = 'Unknown person';

/** Shown when there is no person at all. */
export const NO_PERSON = '—';

type Lookup = ReadonlyMap<string, string> | ReadonlyArray<{ id: string; displayName: string }>;

/**
 * Returns the person's display name.
 * - no person id (null, undefined, '') -> NO_PERSON
 * - id found with a non-blank name -> the trimmed name
 * - id not found, or found with a blank name -> UNKNOWN_PERSON
 * Never returns the raw person id.
 */
export function personName(lookup: Lookup, personId: string | null | undefined): string {
  if (!personId) return NO_PERSON;
  const found = Array.isArray(lookup)
    ? (lookup as ReadonlyArray<{ id: string; displayName: string }>).find((p) => p.id === personId)?.displayName
    : (lookup as ReadonlyMap<string, string>).get(personId);
  const name = found?.trim();
  return name ? name : UNKNOWN_PERSON;
}

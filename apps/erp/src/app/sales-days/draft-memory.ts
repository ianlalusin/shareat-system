/**
 * T-504 item 10 - the browser-side draft memory for the sales-day form. Pure helpers over a Storage-like object
 * (localStorage in the browser). Every call is wrapped: a missing, full or blocked storage never throws, the form just has
 * no memory. Nothing here talks to the server.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type Draft = { fields: Record<string, string>; savedAt: string };

/** One draft per person + store + business date. */
export function draftKey(personId: string, storeId: string, businessDate: string): string {
  return `shareat:sales-day-draft:${personId}:${storeId}:${businessDate}`;
}

export function saveDraft(storage: StorageLike | null | undefined, key: string, fields: Record<string, string>, now: Date = new Date()): void {
  try {
    storage?.setItem(key, JSON.stringify({ fields, savedAt: now.toISOString() }));
  } catch {
    /* storage unavailable: no memory, no harm */
  }
}

export function loadDraft(storage: StorageLike | null | undefined, key: string): Draft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { fields, savedAt } = parsed as { fields?: unknown; savedAt?: unknown };
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields) || typeof savedAt !== 'string') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'string') return null;
      out[k] = v;
    }
    return { fields: out, savedAt };
  } catch {
    return null;
  }
}

export function clearDraft(storage: StorageLike | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The "I pressed Save / Submit" marker. A refused Save comes back to a page with a sentence and the draft must SURVIVE; only a
 * Save or Submit that worked clears it. The browser cannot see the outcome, so the form leaves this marker when it submits and
 * the day page (which only a success lands on without an error) settles it: draft cleared, marker removed.
 */
const savingKey = (key: string): string => `${key}:saving`;

export function markSaving(storage: StorageLike | null | undefined, key: string): void {
  try {
    storage?.setItem(savingKey(key), '1');
  } catch {
    /* storage unavailable */
  }
}

/** True when the marker was set; it is removed either way. */
export function takeSaving(storage: StorageLike | null | undefined, key: string): boolean {
  try {
    const was = storage?.getItem(savingKey(key)) != null;
    if (was) storage?.removeItem(savingKey(key));
    return was;
  } catch {
    return false;
  }
}

/**
 * What to write when the person edits. A box the person has NOT touched in this visit keeps what the draft already holds (else
 * what the page shows), so a re-render or a hydration reset that blanks a box can never overwrite a remembered figure with an
 * empty one. A box they touched is written exactly as it is now, including cleared to nothing.
 */
export function mergeForSave(stored: Record<string, string> | null, dom: Record<string, string>, touched: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(dom)) {
    out[name] = touched.has(name) || !stored || !(name in stored) ? value : (stored[name] ?? value);
  }
  if (stored) for (const [name, value] of Object.entries(stored)) if (!(name in out) && !touched.has(name)) out[name] = value;
  return out;
}

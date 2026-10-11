/**
 * T-393 R5, I2-I5 — grandfather-father-son retention. Pure: no I/O, the caller deletes whatever lands in `delete`.
 *
 * Keeps every complete dump from the last 35 days, the earliest complete dump of each Manila month for 13 months,
 * and the earliest of each year forever. Deletes at most 10 dumps per run and never leaves fewer than 7 complete.
 * A dump with no manifest is not complete (I2): it is deleted only once it is 2+ days old.
 *
 * I5: only keys of exactly the three shapes below, under `postgres/daily/`, can ever be named in `delete`.
 */
export const DAILY_KEY_RE =
  /^postgres\/daily\/(\d{4}-\d{2}-\d{2})\/(shareat-\d{8}T\d{6}Z)\.(dump|manifest\.json|roles\.sql)$/;

export const KEEP_DAYS = 35;
export const KEEP_MONTHS = 13;
export const MAX_DELETES = 10;
export const MIN_COMPLETE = 7;
export const ORPHAN_MIN_AGE_DAYS = 2;

interface Stem {
  date: string;
  stem: string; // the dated directory plus the file stem, no extension
  dump?: string;
  manifest?: string;
  roles?: string;
}

const DAY_MS = 86_400_000;
function dayNumber(ymd: string): number {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(t) ? NaN : Math.floor(t / DAY_MS);
}

export function planPrune(
  keys: string[],
  todayManila: string,
): { keep: string[]; delete: string[]; reasons: Record<string, string> } {
  const today = dayNumber(todayManila);
  const stems = new Map<string, Stem>();
  for (const key of keys) {
    const m = DAILY_KEY_RE.exec(key);
    if (!m) continue;
    const [, date, file, ext] = m as unknown as [string, string, string, string];
    if (Number.isNaN(dayNumber(date))) continue;
    const id = `postgres/daily/${date}/${file}`;
    const s = stems.get(id) ?? { date, stem: id };
    if (ext === 'dump') s.dump = key;
    else if (ext === 'manifest.json') s.manifest = key;
    else s.roles = key;
    stems.set(id, s);
  }

  const completeStems = [...stems.values()].filter((s) => s.dump && s.manifest).sort((a, b) => a.stem.localeCompare(b.stem));
  const orphans = [...stems.values()].filter((s) => s.dump && !s.manifest).sort((a, b) => a.stem.localeCompare(b.stem));

  const todayMonth = Number(todayManila.slice(0, 4)) * 12 + Number(todayManila.slice(5, 7)) - 1;
  const earliest = new Map<string, Stem>(); // 'M:yyyy-mm' and 'Y:yyyy'
  for (const s of completeStems) {
    for (const k of [`M:${s.date.slice(0, 7)}`, `Y:${s.date.slice(0, 4)}`]) if (!earliest.has(k)) earliest.set(k, s);
  }

  const reasons: Record<string, string> = {};
  const toDelete: Stem[] = [];

  // Crashed nights first: a bare dump is dead weight and never counted as complete.
  for (const s of orphans) {
    if (toDelete.length >= MAX_DELETES) break;
    if (today - dayNumber(s.date) >= ORPHAN_MIN_AGE_DAYS) {
      toDelete.push(s);
      reasons[s.dump!] = 'dump with no manifest, 2+ days old (a crashed night)';
    }
  }

  let remainingComplete = completeStems.length;
  for (const s of completeStems) {
    if (toDelete.length >= MAX_DELETES) break;
    if (remainingComplete <= MIN_COMPLETE) break;
    const age = today - dayNumber(s.date);
    if (age < KEEP_DAYS) continue;
    const monthIdx = Number(s.date.slice(0, 4)) * 12 + Number(s.date.slice(5, 7)) - 1;
    if (earliest.get(`Y:${s.date.slice(0, 4)}`) === s) continue;
    if (todayMonth - monthIdx < KEEP_MONTHS && earliest.get(`M:${s.date.slice(0, 7)}`) === s) continue;
    toDelete.push(s);
    remainingComplete -= 1;
    reasons[s.dump!] = `complete dump aged ${age} days, not the earliest of its month (13 months) or year`;
  }

  const del: string[] = [];
  for (const s of toDelete) for (const k of [s.dump, s.manifest, s.roles]) if (k) del.push(k);
  const delSet = new Set(del);
  return { keep: keys.filter((k) => !delSet.has(k)), delete: del, reasons };
}

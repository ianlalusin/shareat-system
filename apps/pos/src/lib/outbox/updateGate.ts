/**
 * T-425 S5 - update and reinstall safety (Ruling 8, APK-first). Unsent sales live only in this tablet's IndexedDB; uninstalling, clearing data
 * or installing a different build wipes them. Settings shows the count with the warning, and "Check for update" shows its download link only
 * when nothing is unsent.
 */
export function unsentSalesWarningText(unsentCount: number): string {
  return `Unsent sales: ${unsentCount} — do not uninstall, clear data or install a different build until this is 0`;
}

export function canShowUpdateLink(i: { unsentCount: number; currentVersion: string; latestVersion: string | null }): boolean {
  return i.unsentCount === 0 && typeof i.latestVersion === 'string' && i.latestVersion !== '' && i.latestVersion !== i.currentVersion;
}

/** GET `${apiBase}/api/pos2/health`; never throws. `reachable` is true only for a JSON body `{ok: true, ...}`. */
export async function checkForUpdate(d: { fetch: typeof fetch; apiBase: string; currentVersion: string }): Promise<{ latestVersion: string | null; reachable: boolean }> {
  try {
    const res = await d.fetch(`${d.apiBase}/api/pos2/health`, { method: 'GET', cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return { latestVersion: null, reachable: false };
    const body = (await res.json()) as { ok?: unknown; version?: unknown } | null;
    if (!body || body.ok !== true) return { latestVersion: null, reachable: false };
    return { latestVersion: typeof body.version === 'string' && body.version !== '' ? body.version : null, reachable: true };
  } catch {
    return { latestVersion: null, reachable: false };
  }
}

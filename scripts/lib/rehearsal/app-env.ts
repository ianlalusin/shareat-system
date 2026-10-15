/**
 * T-394 R11 / I10c - `app-env-check`: the copy's app env may use Firebase for SIGN-IN only. Returns variable NAMES, never values.
 */
const FORBIDDEN_EXACT = new Set(['FIREBASE_SERVICE_ACCOUNT_KEY', 'FIREBASE_SERVICE_ACCOUNT_KEY_FILE', 'FIREBASE_STORAGE_BUCKET']);

export function isForbiddenAppEnvName(name: string): boolean {
  return FORBIDDEN_EXACT.has(name) || name.startsWith('POS_API_');
}

function valueOf(raw: string): string {
  let v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2) {
    const end = v.indexOf(q, 1);
    v = end === -1 ? v.slice(1) : v.slice(1, end);
  } else {
    const hash = v.startsWith('#') ? 0 : v.search(/\s#/);
    if (hash !== -1) v = v.slice(0, hash);
  }
  return v.trim();
}

export function checkAppEnvText(text: string): { ok: boolean; offending: string[] } {
  const offending: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(t);
    if (!m) continue;
    const name = m[1] as string;
    if (isForbiddenAppEnvName(name) && valueOf(m[2] ?? '') !== '' && !offending.includes(name)) offending.push(name);
  }
  return { ok: offending.length === 0, offending };
}

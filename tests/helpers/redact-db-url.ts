/**
 * DEF-814 — mask a database URL's password in text that may be printed (failing-test output, CI logs).
 *
 * The old inline `url.replace(/:\/\/[^@]*@/, '://***@')` stopped at the FIRST `@`, so a password that
 * itself contains `@` printed everything after it. Here the userinfo ends at the LAST `@` (a host never
 * contains one), and the password is also masked by value — raw, URL-encoded and URL-decoded — wherever it
 * appears in `text`, not only inside a URL shape.
 */
export function redactDbUrl(text: string, url: string = text): string {
  const userinfo = /:\/\/(.*)@/.exec(url)?.[1] ?? '';
  const colon = userinfo.indexOf(':');
  const raw = colon === -1 ? '' : userinfo.slice(colon + 1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded: the raw form is all there is */
  }
  // Longest first, so a form that contains another is masked whole.
  const secrets = [...new Set([raw, decoded, encodeURIComponent(decoded), encodeURIComponent(raw)])]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out.replace(/:\/\/\S*@/g, '://***@');
}

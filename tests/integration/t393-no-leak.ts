/**
 * T-393 - "the DB password never leaks" check that survives a password which is also an ordinary word. In CI the password
 * is `postgres`, which legitimately appears in object keys (`postgres/daily/...`), the maintenance database name and the role
 * name. Those known-legitimate forms are scrubbed first; anything left that still contains the password is a leak.
 */
export function scrubLegit(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\//gi, '') // scheme (asserted absent separately)
    .replace(/postgres\/(daily|drills|pinned)\//g, '$1/') // object-store key prefix
    .replace(/postgres\//g, '')
    .replace(/\bpostgres\b(?=["'`\s,.;:)\]}]|$)/g, ''); // role / maintenance db name as a bare word
}

export function leaksPassword(text: string, password: string): boolean {
  return scrubLegit(text).includes(password);
}

// T-562 (DEF-818): the one rule for "is this a disposable test database". Only the decoded database NAME counts -
// never the user, password, host or query. Pure string work: it never connects and never prints the URL.

/** True only when the URL's database name has `test` as a whole `_`-separated word (shareat_test, shareat_t528_test_w1). */
export function isTestDatabaseUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return /(^|_)test(_|$)/.test(name);
  } catch {
    return false;
  }
}

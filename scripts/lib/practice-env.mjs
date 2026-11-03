// Shared by the PRACTICE starters (apps/pos/scripts/practice-start.mjs, scripts/practice-erp-start.mjs).
// One rule: a practice server never inherits a database address from the shell. Its DATABASE_URL is the practice
// URL, or '' when there is none; every other *DATABASE_URL is deleted; and the start is refused unless the final
// URL is empty, or points at 127.0.0.1/localhost AND a database whose name contains "_test".

/** Parses the database name and host without ever echoing the URL (a password may contain '@'). */
function describeUrl(url) {
  const withoutQuery = url.split('?')[0];
  const name = decodeURIComponent(withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1));
  const afterAt = withoutQuery.slice(withoutQuery.lastIndexOf('@') + 1);
  const hostPort = afterAt.includes('//') ? afterAt.slice(afterAt.indexOf('//') + 2) : afterAt;
  const host = hostPort.split('/')[0].replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return { name, host };
}

/** Throws unless `url` is '' or a local throwaway database. Never prints the URL. */
export function assertPracticeDatabaseUrl(url) {
  if (url === '') return;
  const { name, host } = describeUrl(url);
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`Practice copy refuses a database on host "${host}": only 127.0.0.1 or localhost.`);
  }
  if (!/_test/.test(name)) {
    throw new Error('Practice copy refuses a database whose name does not contain "_test".');
  }
}

/**
 * Builds the child environment: the shell's env, with DATABASE_URL forced to `practiceUrl` (or ''), every other
 * *DATABASE_URL removed, and `extra` laid on top. Throws (via assertPracticeDatabaseUrl) if the result is not safe.
 * @param {Record<string, string | undefined>} inherited
 * @param {string | undefined | null} practiceUrl
 * @param {Record<string, string>} [extra]
 */
export function buildPracticeEnv(inherited, practiceUrl, extra = {}) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL$/i.test(key)) delete env[key];
  }
  Object.assign(env, extra);
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL$/i.test(key)) delete env[key];
  }
  env.DATABASE_URL = practiceUrl ?? '';
  assertPracticeDatabaseUrl(env.DATABASE_URL);
  return env;
}

/** The practice URL: POS_PRACTICE_DATABASE_URL, else TEST_DATABASE_URL's server with the database swapped. '' when neither exists. */
export function resolvePracticeDatabaseUrl(inherited, dbName = 'shareat_test_pospractice') {
  if (inherited.POS_PRACTICE_DATABASE_URL) return inherited.POS_PRACTICE_DATABASE_URL;
  if (inherited.TEST_DATABASE_URL) {
    const u = new URL(inherited.TEST_DATABASE_URL);
    u.pathname = '/' + dbName;
    return u.toString();
  }
  return '';
}

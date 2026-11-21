/**
 * DEF-410: run one unit of work per organisation, and let one org's failure stop nothing else.
 * Returns what failed (by org name) so the caller can print its summary EVEN WHEN something failed and exit non-zero.
 */
export async function forEachOrg<O extends { id: string; name: string }, R>(
  orgs: readonly O[],
  work: (org: O) => Promise<R>,
): Promise<{ done: R[]; failed: { org: O; message: string }[] }> {
  const done: R[] = [];
  const failed: { org: O; message: string }[] = [];
  for (const org of orgs) {
    try {
      done.push(await work(org));
    } catch (err) {
      failed.push({ org, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { done, failed };
}

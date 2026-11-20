/**
 * DEF-423: the one reader of `--name=value` for the ops scripts.
 *
 * Eighteen scripts each carried their own `arg()` that looked only for `--org=<uuid>`. Typing `--org <uuid>` (a space) or `--org=`
 * (nothing) was read as "no org given", and a run meant for ONE organisation acted on EVERY organisation. Both are refused here,
 * by name, before the script does anything.
 */
export class ScriptArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptArgError';
  }
}

export function scriptArg(name: string, argv: readonly string[] = process.argv): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit !== undefined) {
    const value = hit.slice(prefix.length);
    if (value === '') throw new ScriptArgError(`--${name}= has no value. Write --${name}=<value>.`);
    return value;
  }
  if (argv.includes(`--${name}`)) {
    throw new ScriptArgError(`--${name} needs an equals sign: write --${name}=<value>, not --${name} <value>. (Without it the option is ignored and the script runs for everything.)`);
  }
  return undefined;
}

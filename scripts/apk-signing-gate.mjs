// T-417: decides whether the release APK can be signed. Reads four env vars (never prints a value).
//   none set      -> signing=skip (green, with a plain notice)
//   all four set  -> signing=release
//   some set      -> ::error:: naming the missing ones, exit 1 (a half-set key is a mistake)
import { appendFileSync } from 'node:fs';

const VARS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
// GitHub passes an unset secret as an empty string, so empty counts as not set.
const missing = VARS.filter((v) => !process.env[v]);

function out(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

if (missing.length === VARS.length) {
  out('signing=skip');
  console.log(
    '::notice::Release APK skipped: the ANDROID_KEYSTORE secrets are not set yet. Ian adds them in GitHub Settings > Secrets. Web build and typecheck above still ran.',
  );
} else if (missing.length === 0) {
  out('signing=release');
  console.log('Release signing secrets present; building the signed APK.');
} else {
  console.log(`::error::Half-set Android signing secrets. Missing: ${missing.join(', ')}. Set all four or none.`);
  process.exit(1);
}

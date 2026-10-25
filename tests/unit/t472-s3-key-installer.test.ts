import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** T-472 S3 audit: the key installer streams the key over ssh. No scp, no copy in /tmp, never world-readable, nothing left behind. */
const src = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'ops', 'install-pos-bridge-key.sh'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

describe('install-pos-bridge-key.sh', () => {
  it('does not scp and does not stage the key in /tmp', () => {
    expect(src).not.toMatch(/\bscp\b/);
    expect(src).not.toContain('/tmp/');
  });
  it('streams the key on stdin under umask 077 into a mode-600 file owned by shareat', () => {
    expect(src).toContain('umask 077');
    expect(src).toContain('/dev/stdin');
    expect(src).toMatch(/-m 600/);
    expect(src).toMatch(/-o shareat/);
    expect(src).toMatch(/<\s*"\$SRC"/);
  });
});

/**
 * T-398 S7f (TESTER) - the runbook text the refresh pins. docs/tasks/398-s7/S7-REFRESH.md s8 and s10.
 * RED TODAY: neither docs/ops/cutover-runbook.md nor docs/ops/README.md mentions Padre Garcia's purge/opening or the onboarding recipe.
 * Pinned (the refresh names them), nothing else:
 *   cutover-runbook.md s3 : the purge command takes one `--by` per company (Ian's org performer AND the PG person), the opening is per company,
 *                           what PG owes the commissary equals Ian's opening receivable from PG, 3900 = 0 is checked per company,
 *                           and "no real inter-entity trade on production before 1 Jan except on a rehearsal copy".
 *   README.md             : an "Onboarding a franchise" section with the recipe: `onboard-franchise` (dry run, then `--confirm`), the T-391 `master-data`
 *                           dry run then apply for PG, `provision-terminal` with `--org`, the POS link made on PG's first v2 day, and the real data file
 *                           never in git.
 * MUTANTS: a runbook that tells the operator to purge with a single --by (the second company is refused and the 1 Jan window is spent on a
 * refusal); an opening that does not say the two sides of the commissary balance must match; a recipe that omits `--org` (the wrong store gets the terminal).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const section = (text: string, heading: RegExp): string => {
  const m = heading.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = /\n#{2,3} /.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
};

describe('cutover-runbook.md - two companies at the purge and the opening', () => {
  const rb = read('docs/ops/cutover-runbook.md');
  const s3 = section(rb, /\n## 3\. Production[^\n]*\n/);

  it('section 3 has a purge apply line with two `--by` (Ian\'s org performer and the PG person)', () => {
    const lines = s3.split('\n').filter((l) => /cutover:purge/.test(l) && /--apply/.test(l));
    expect(lines.length, 'no `cutover:purge ... --apply` line in section 3').toBeGreaterThan(0);
    expect(lines.some((l) => (l.match(/--by\b/g) ?? []).length >= 2)).toBe(true);
  });
  it('names Padre Garcia / PG in section 3 and says the apply refuses with either --by missing', () => {
    expect(s3).toMatch(/Padre Garcia|\bPG\b/);
    expect(s3).toMatch(/refus\w+[^.\n]*(either|each|both|every)[^.\n]*(--by|person|performer)|(either|each|both|every)[^.\n]*(--by|person|performer)[^.\n]*refus/i);
  });
  it('says PG\'s opening is per company and that what PG owes the commissary must equal Ian\'s opening receivable from PG', () => {
    expect(s3).toMatch(/owes the commissary|owe the commissary/i);
    expect(s3).toMatch(/receivable/i);
    expect(s3).toMatch(/(must )?(equal|match)/i);
  });
  it('says 3900 = 0 is checked per company', () => {
    expect(s3).toMatch(/3900[^.\n]*(per (company|org|organi[sz]ation)|each (company|org|organi[sz]ation)|in each)/i);
  });
  it('forbids a real inter-entity trade on production before 1 Jan (except on a rehearsal copy)', () => {
    expect(s3).toMatch(/inter-entity[^.\n]*before 1 Jan|before 1 Jan[^.\n]*inter-entity/i);
    expect(s3).toMatch(/rehearsal copy/i);
  });
});

describe('README.md - Onboarding a franchise', () => {
  const readme = read('docs/ops/README.md');
  const sec = section(readme, /\n#{2,3} Onboarding a franchise[^\n]*\n/);
  it('has the section', () => {
    expect(sec.length, 'no "Onboarding a franchise" section').toBeGreaterThan(200);
  });
  it('the recipe names onboard-franchise (dry run first, then --confirm), master-data dry run then --apply, provision-terminal with --org', () => {
    expect(sec).toMatch(/onboard-franchise/);
    expect(sec).toMatch(/--confirm/);
    expect(sec).toMatch(/master-data/);
    expect(sec).toMatch(/--apply/);
    expect(sec).toMatch(/provision-terminal[^\n]*--org/);
  });
  it('says the POS link is made on PG\'s first v2 day, and the real data file never enters git', () => {
    expect(sec).toMatch(/POS[^.\n]*link[^.\n]*(first|start)[^.\n]*(v2 )?day|first (v2 )?day[^.\n]*POS[^.\n]*link/i);
    expect(sec).toMatch(/never[^.\n]*(in )?(git|the repo)|not (in|committed to) (git|the repo)/i);
  });
});

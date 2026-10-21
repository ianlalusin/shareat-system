/**
 * T-430 case 16 — the recurring-template screen offers a "Starts from" date and the create action passes it on.
 *
 * Reads the real source (the idiom `remittance-overage-wiring.test.ts` uses): `page.tsx` / `actions.ts` are server code
 * and awkward to render here. Without this, the domain accepts `startsOn` and nothing under `apps/` ever sends it,
 * which is the DEF-129/135 shape: correct domain, unreachable feature.
 */
import { readControlSource } from './helpers/control-source';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'src', 'app', 'expenses', 'recurring');
const page = readControlSource(resolve(dir, 'page.tsx'), 'utf8');
const actions = readControlSource(resolve(dir, 'actions.ts'), 'utf8');

/** The create action's body: from its declaration to the next exported action. */
const createAction = (() => {
  const start = actions.indexOf('export async function createTemplateAction');
  const next = actions.indexOf('export async function', start + 10);
  return actions.slice(start, next === -1 ? undefined : next);
})();

describe('T-430 case 16 — the "Starts from" field', () => {
  it('the template form renders a date input named startsOn', () => {
    const input = /<Input[^>]*name="startsOn"[^>]*>/s.exec(page);
    expect(input, 'no <Input name="startsOn" ...> in page.tsx').not.toBeNull();
    expect(input![0]).toMatch(/type="date"/);
  });

  it('it defaults to today and is labelled "Starts from"', () => {
    expect(page).toMatch(/Starts from/);
    const input = /<Input[^>]*name="startsOn"[^>]*>/s.exec(page);
    expect(input![0]).toMatch(/defaultValue=/);
  });

  it('the screen tells the person that a past date creates catch-up drafts', () => {
    expect(page).toMatch(/catch-up/i);
  });

  it('createTemplateAction reads the field and passes it to the domain as startsOn (not the old "from")', () => {
    expect(createAction).toMatch(/startsOn\s*:[^,\n]*str\(formData,\s*'startsOn'\)/);
    expect(createAction).not.toMatch(/\bfrom\s*:/);
  });
});

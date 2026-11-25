import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_CAPABILITY } from '../src/lib/route-capability';
import { crumbSteps, CRUMB_PAGES } from '../src/components/nav-crumbs';

/**
 * T-640 screen guards (source-level; the page is an async server component that needs a session). Test 1 (the key never reaches the browser) and test 2 (the gate), read from the files.
 */
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'settings', 'ai-hub');
const read = (f: string) => readFileSync(resolve(dir, f), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l)).join('\n');

describe('T-640 /settings/ai-hub', () => {
  const page = code(read('page.tsx'));
  const actions = code(read('actions.ts'));

  it('is gated by the page check and the route key is manage_ai_hub (super admin only) [kills: an open page]', () => {
    expect(page).toContain("requirePageAccess('/settings/ai-hub')");
    expect(page).toContain('if (refusal) return refusal');
    expect(ROUTE_CAPABILITY['/settings/ai-hub']).toBe('manage_ai_hub');
    expect(CRUMB_PAGES).toContain('/settings/ai-hub');
    expect(crumbSteps('/settings/ai-hub').map((s) => s.label)).toEqual(['Settings', 'AI hub']);
  });

  it('neither the page nor the actions can reach a key or its ciphertext: no repo, no table, no envelope [kills: a key in the HTML]', () => {
    for (const src of [page, actions]) {
      for (const bad of ['keyEnvelope', 'getKeyEnvelope', 'aiHubRepo', 'ai_provider_keys', 'decryptSecret', 'AI_KEYS_MASTER_KEY()', '@shareat/db', '@shareat/ai']) expect(src, bad).not.toContain(bad);
    }
  });

  it('the key box is a password box that is never pre-filled, and only the last 4 characters are printed [kills: showing the key back]', () => {
    const at = page.indexOf('<Input {...nativeAttrs(AI_KEY_RULES.key)}');
    expect(at).toBeGreaterThan(-1);
    const tag = page.slice(at, page.indexOf('/>', at));
    expect(tag).toContain('type="password"');
    expect(tag).toContain('autoComplete="off"');
    expect(tag).not.toMatch(/defaultValue|value=/);
    expect(page).toContain('p.last4');
  });

  it('a refused key save keeps nothing for retyping: the key form is not a typed form, and the action never calls keepTyping for it [kills: a key in the one-minute flash]', () => {
    const save = actions.slice(actions.indexOf('export async function saveKeyAction'), actions.indexOf('export async function removeKeyAction'));
    expect(save).not.toContain('keepTyping');
    expect(save).not.toContain('typed:');
    expect(read('typed-forms.ts')).not.toMatch(/'key'/);
    expect(actions.match(/keepTyping\(/g)?.length).toBe(1); // the limits form only
  });

  it('every action redirects AFTER its try, so a redirect is never shown as an error, and none re-checks a right the domain owns [kills: a success shown as a refusal]', () => {
    for (const name of ['saveKeyAction', 'removeKeyAction', 'testModelAction', 'activateModelAction', 'deactivateModelAction', 'moveModelAction', 'saveSettingsAction', 'storeSwitchAction']) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const end = body.indexOf('\nexport async function', 10);
      const fn = end > 0 ? body.slice(0, end) : body;
      const tryEnd = fn.indexOf('catch');
      expect(fn.slice(0, tryEnd), name).not.toMatch(/redirectWithFlash|done\(/);
    }
    expect(actions).not.toMatch(/authorize\(|can\(/);
  });
});

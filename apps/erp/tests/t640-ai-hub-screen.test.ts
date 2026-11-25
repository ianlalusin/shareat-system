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
  const keyEditor = code(read('KeyEditor.tsx'));
  const order = code(read('FallbackOrder.tsx'));

  it('is gated by the page check and the route key is manage_ai_hub (super admin only) [kills: an open page]', () => {
    expect(page).toContain("requirePageAccess('/settings/ai-hub')");
    expect(page).toContain('if (refusal) return refusal');
    expect(ROUTE_CAPABILITY['/settings/ai-hub']).toBe('manage_ai_hub');
    expect(CRUMB_PAGES).toContain('/settings/ai-hub');
    expect(crumbSteps('/settings/ai-hub').map((s) => s.label)).toEqual(['Settings', 'AI hub']);
  });

  it('neither the page nor the actions can reach a key or its ciphertext: no repo, no table, no envelope [kills: a key in the HTML]', () => {
    for (const src of [page, actions, keyEditor, order]) {
      for (const bad of ['keyEnvelope', 'getKeyEnvelope', 'aiHubRepo', 'ai_provider_keys', 'decryptSecret', 'AI_KEYS_MASTER_KEY()', '@shareat/db', '@shareat/ai']) expect(src, bad).not.toContain(bad);
    }
  });

  it('the key box is a password box that is never pre-filled, and only the last 4 characters are printed [kills: showing the key back]', () => {
    const at = keyEditor.indexOf('<Input {...nativeAttrs(AI_KEY_RULES.key)}');
    expect(at).toBeGreaterThan(-1);
    const tag = keyEditor.slice(at, keyEditor.indexOf('/>', at));
    expect(tag).toContain('type="password"');
    expect(tag).toContain('autoComplete="off"');
    expect(tag).not.toMatch(/defaultValue|value=/);
    expect(page).toContain('last4={p.last4}');
    // nothing in the editor holds the typed key: no state for it, no storage, no change handler on the box
    expect(keyEditor.match(/useState\(/g)?.length).toBe(1); // the one editing flag
    expect(keyEditor).not.toMatch(/localStorage|sessionStorage|onChange|onInput/);
  });

  it('a saved key shows the masked preview (four dots and the last 4) and a quiet Edit; the key box, Cancel and Save exist only after Edit [kills: the input always showing, a preview longer than the last 4, no way back]', () => {
    expect(keyEditor).toContain('const [editing, setEditing] = useState(!hasKey)');
    expect(keyEditor).toContain('•••• {last4}');
    const preview = keyEditor.indexOf('if (hasKey && !editing)');
    expect(preview).toBeGreaterThan(-1);
    // the preview branch returns before the form is ever drawn, and it holds the Edit button but no input
    const previewBlock = keyEditor.slice(preview, keyEditor.indexOf('<CheckedForm'));
    expect(previewBlock).toContain('setEditing(true)');
    expect(previewBlock).not.toContain('<Input');
    expect(previewBlock).not.toContain('SubmitButton');
    // the form branch has Cancel (only for a saved key) and Save, with Save last
    const form = keyEditor.slice(keyEditor.indexOf('<CheckedForm'));
    expect(form).toContain('setEditing(false)');
    expect(form.indexOf('Cancel')).toBeLessThan(form.indexOf('Save'));
    // no other place prints key characters
    expect(keyEditor.match(/last4/g)?.length).toBeLessThanOrEqual(4);
    expect(page).not.toMatch(/Key saved, ends in/);
  });

  it('an untouched empty key box does not print the "fix the field" hint: the form is quiet until a touched field fails [kills: a hint under an empty box nobody typed in]', () => {
    expect(keyEditor).toMatch(/<CheckedForm[^>]*quietSummary/);
    expect(keyEditor).toContain('rules={AI_KEY_RULES}'); // the rule itself is untouched
  });

  it('the order is numbered cards, 1 first, then a "Not in use" group holding Test and Switch on [kills: a flat unnumbered list, a model that is off sitting in the order]', () => {
    expect(order).toContain('{i + 1}');
    expect(order).toContain('<ol');
    expect(order).toContain('Tried first');
    expect(page).toContain('Fallback order');
    expect(page).toContain('Not in use');
    const idle = page.slice(page.indexOf('Not in use'));
    expect(idle).toContain('testModelAction');
    expect(idle).toContain('activateModelAction');
    expect(page).toContain('const idle = view.models.filter((m) => !m.active && m.hasKey)');
  });

  it('dragging saves the whole order in one hidden form to setModelOrderAction; every card also has Move earlier / Move later, 44px, as real forms [kills: a drag that saves nothing, a drag-only order that a keyboard or phone cannot change]', () => {
    expect(order).toContain('action={setModelOrderAction}');
    expect(order).toContain('JSON.stringify(live.current)');
    expect(order).toContain('requestSubmit()');
    expect(order).toContain('touch-none'); // a finger on the grip drags instead of scrolling
    expect(order).toContain('min-h-11 min-w-11');
    expect(order).toContain('action={moveModelAction}');
    expect(order).toContain('Move earlier');
    expect(order).toContain('Move later');
  });

  it('two columns from lg with a sticky right column, one column below it in the order spend, fallback, providers, caps, stores [kills: a page that scrolls to the bottom for the order]', () => {
    expect(page).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
    expect(page).toMatch(/lg:sticky lg:top-4/);
    expect(page).toMatch(/lg:max-h-\[calc\(100dvh-2rem\)\][^"]*lg:overflow-y-auto/);
    expect(page).toContain('order-1 lg:order-none');
    expect(page).toContain('order-2 lg:order-none');
    expect(page).toContain('order-3 space-y-3 lg:order-none');
    expect(page).toContain('order-4 space-y-3 lg:order-none');
    expect(page).toContain('order-5 space-y-3 lg:order-none');
  });

  it('a refused key save keeps nothing for retyping: the key form is not a typed form, and the action never calls keepTyping for it [kills: a key in the one-minute flash]', () => {
    const save = actions.slice(actions.indexOf('export async function saveKeyAction'), actions.indexOf('export async function removeKeyAction'));
    expect(save).not.toContain('keepTyping');
    expect(save).not.toContain('typed:');
    expect(read('typed-forms.ts')).not.toMatch(/'key'/);
    expect(actions.match(/keepTyping\(/g)?.length).toBe(1); // the limits form only
  });

  it('every action redirects AFTER its try, so a redirect is never shown as an error, and none re-checks a right the domain owns [kills: a success shown as a refusal]', () => {
    for (const name of ['saveKeyAction', 'removeKeyAction', 'testModelAction', 'activateModelAction', 'deactivateModelAction', 'moveModelAction', 'setModelOrderAction', 'saveSettingsAction', 'storeSwitchAction']) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const end = body.indexOf('\nexport async function', 10);
      const fn = end > 0 ? body.slice(0, end) : body;
      const tryEnd = fn.indexOf('catch');
      expect(fn.slice(0, tryEnd), name).not.toMatch(/redirectWithFlash|done\(/);
    }
    expect(actions).not.toMatch(/authorize\(|can\(/);
  });
});

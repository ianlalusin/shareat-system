// @vitest-environment happy-dom
/**
 * T-548 S0 - DialogActions: a plain right-aligned row outside a dialog, and in a CheckedForm the ONE live check line rides
 * in the band (the form's own line steps aside). Real DOM (happy-dom): the band registers in a layout effect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogActions } from '../src/components/ui';
import { CheckedForm } from '../src/components/forms';
import { defineFieldRules } from '../../../packages/domain/src/field-rules';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rules = defineFieldRules('t548.band', { name: { label: 'The name', kind: 'text', min: 1, max: 40 } });
const field = () => h('input', { name: 'name', defaultValue: '' });
const save = () => h('button', { type: 'submit' }, 'Save');

let host: HTMLElement | null = null;
let root: Root | null = null;
async function mount(node: ReturnType<typeof h>): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  host = root = null;
});

describe('DialogActions', () => {
  it('outside a dialog or a checked form it is a plain right-aligned row, no live region', () => {
    const html = renderToStaticMarkup(h(DialogActions, null, save()));
    expect(html).toMatch(/^<div data-dialog-actions="true" class="[^"]*\bjustify-end\b[^"]*">/);
    expect(html).not.toContain('aria-live');
    expect(html).toContain('<button type="submit">Save</button>');
  });

  it('a CheckedForm with a DialogActions has exactly one aria-live line, inside the band, above the buttons', async () => {
    const el = await mount(h(CheckedForm as never, { rules, action: () => undefined } as never, field(), h(DialogActions, null, save())));
    const live = el.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    const band = el.querySelector('[data-dialog-actions]')!;
    expect(band.contains(live[0]!)).toBe(true);
    expect(band.firstElementChild).toBe(live[0]);
    expect(live[0]!.textContent).toContain('Save is off until');
    expect(el.querySelector('form')!.lastElementChild).toBe(band);
  });

  it('a CheckedForm without one is unchanged: its own line is the form\'s last child', async () => {
    const el = await mount(h(CheckedForm as never, { rules, action: () => undefined } as never, field(), save()));
    const live = el.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(el.querySelector('[data-dialog-actions]')).toBeNull();
    expect(el.querySelector('form')!.lastElementChild).toBe(live[0]);
    expect(live[0]!.textContent).toContain('Save is off until');
  });

  it('removing the band hands the line back to the form (still exactly one)', async () => {
    const tree = (withBand: boolean) =>
      h(CheckedForm as never, { rules, action: () => undefined } as never, field(), withBand ? h(DialogActions, null, save()) : save());
    const el = await mount(tree(true));
    await act(async () => { root!.render(tree(false)); });
    const live = el.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(el.querySelector('form')!.lastElementChild).toBe(live[0]);
  });
});

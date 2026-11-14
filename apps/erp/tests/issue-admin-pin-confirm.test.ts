// @vitest-environment happy-dom
// ⚠️ `.ts` on purpose (unit glob is `*.test.ts`), so `createElement` stands in for JSX.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { STAFF_PIN_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '../src/components/forms';
import { SubmitButton } from '../src/components/feedback/SubmitButton';
import { Field, FormGrid, Input } from '../src/components/ui';
import { IssueAdminPinConfirm } from '../src/app/staff/IssueAdminPinConfirm';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// React 18 (this workspace) has no useFormStatus; the test owns the answer so it can say "in flight".
const formStatus = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async (orig) => ({
  ...(await orig<typeof import('react-dom')>()),
  useFormStatus: () => ({ pending: formStatus.pending, data: null, method: null, action: null }),
}));

let root: Root;
let host: HTMLElement;
// React 18 does not run a function `action`; React 19 (Next) runs it on any submit that was not
// default-prevented. So the test counts submits that reached the document unprevented.
let delivered = 0;
const count = (e: Event) => { if (!e.defaultPrevented) delivered += 1; e.preventDefault(); };
// The same composition staff/page.tsx builds: the confirmation wraps a shared CheckedForm with the PIN rules.
const element = () => h(IssueAdminPinConfirm, {
  displayName: 'Ana',
  hasPin: false,
  children: h(CheckedForm, { rules: STAFF_PIN_RULES, action: () => {} },
    h(FormGrid, { layout: 'fields' }, h(Field, { label: 'PIN (6 digits)', width: 'code', rule: STAFF_PIN_RULES.pin },
      h(Input, { ...nativeAttrs(STAFF_PIN_RULES.pin), type: 'password' }))),
    h(SubmitButton, { variant: 'secondary', icon: null, children: 'Issue PIN' })),
});
const pinInput = () => host.querySelector<HTMLInputElement>('input[name="pin"]')!;
const typePin = (value: string) => act(() => {
  pinInput().value = value;
  pinInput().dispatchEvent(new Event('input', { bubbles: true }));
});

beforeEach(() => {
  delivered = 0;
  formStatus.pending = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.addEventListener('submit', count);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => { root.render(element()); });
  typePin('123456');
});
afterEach(() => {
  act(() => root.unmount());
  document.removeEventListener('submit', count);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const dialog = () => host.querySelector('dialog')!;
const button = (label: RegExp) => [...host.querySelectorAll('button')].find(b => label.test(b.textContent ?? ''))!;
const submit = () => act(() => { host.querySelector('form')!.requestSubmit(); });
const click = (label: RegExp) => act(() => { button(label).click(); });

describe('IssueAdminPinForm confirmation', () => {
  it('asks before EVERY issue on the same mounted form, not only the first', () => {
    submit();
    expect(dialog().open).toBe(true);
    expect(delivered).toBe(0);

    click(/^Yes,/);
    expect(delivered).toBe(1);
    expect(dialog().open).toBe(false);

    submit(); // same instance, e.g. a retry after the server refused
    expect(dialog().open).toBe(true);
    expect(delivered).toBe(1);

    click(/^Yes,/);
    expect(delivered).toBe(2);
  });

  it('asks again after Cancel', () => {
    submit();
    click(/^Cancel$/);
    expect(dialog().open).toBe(false);
    expect(delivered).toBe(0);

    submit();
    expect(dialog().open).toBe(true);
    expect(delivered).toBe(0);
  });

  it('a confirmed submit that never fires (the PIN went invalid) does not leave consent behind', () => {
    submit();
    expect(dialog().open).toBe(true);
    typePin('12'); // the field is edited while the question is open
    click(/^Yes,/); // CheckedForm refuses the submit; nothing is sent
    expect(delivered).toBe(0);

    typePin('654321');
    submit();
    expect(dialog().open).toBe(true); // the NEXT issue asks again
    expect(delivered).toBe(0);
  });

  it('an invalid PIN is refused by the shared rules before any question is asked', () => {
    typePin('12');
    submit();
    expect(dialog().open).toBe(false);
    expect(delivered).toBe(0);
    expect(host.textContent).toContain('A PIN must be exactly 6 digits.');
  });

  it('no second question or send while an issue is in flight', () => {
    formStatus.pending = true;
    act(() => { root.render(element()); });
    submit();
    expect(dialog().open).toBe(false);
    expect(delivered).toBe(0);

    formStatus.pending = false;
    act(() => { root.render(element()); });
    submit();
    expect(dialog().open).toBe(true);
    formStatus.pending = true; // the first send started while the question was still open
    act(() => { root.render(element()); });
    click(/^Yes,/);
    expect(delivered).toBe(0);
  });
});

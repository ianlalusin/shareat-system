// @vitest-environment happy-dom
/**
 * T-570 (DEF-821) — the behaviour itself, in a real DOM: a number box filters what is typed, groups it in threes,
 * keeps the caret on the digit, and submits the plain figure. `NumericEntryBehaviour` is mounted once in the root
 * layout; here it is mounted over fixture forms exactly as the app mounts it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NumericEntryBehaviour } from '../src/components/forms/NumericEntry';
import { changedNames } from '../src/components/forms/EditableRecord';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<() => void> = [];
afterEach(async () => {
  for (const stop of mounted.splice(0)) await act(async () => stop());
  document.body.replaceChildren();
});

async function mount(children: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h('div', null, h(NumericEntryBehaviour), children));
  });
  mounted.push(() => root.unmount());
  return host;
}

/** What a keystroke does: set the value the way typing does, put the caret where it was, and fire `input`. */
function type(el: HTMLInputElement, value: string, caret = value.length): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* not every type exposes a selection */
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * A real Backspace/Delete: `beforeinput` first; if nothing cancels it, the browser deletes the character itself
 * (one char, or the selection) and fires `input`. `type()` above hands over whole values and so cannot see this.
 */
function press(el: HTMLInputElement, key: 'Backspace' | 'Delete'): void {
  const inputType = key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward';
  const go = el.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
  if (!go) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const from = start !== end ? start : key === 'Backspace' ? Math.max(0, start - 1) : start;
  const to = start !== end ? end : key === 'Backspace' ? start : Math.min(el.value.length, start + 1);
  type(el, el.value.slice(0, from) + el.value.slice(to), from);
}

function input(host: HTMLElement): HTMLInputElement {
  const el = host.querySelector('input');
  if (!(el instanceof HTMLInputElement)) throw new Error('fixture has no input');
  return el;
}

describe('focus / the Edit button', () => {
  it('regroups an existing value before the first keystroke, and moves defaultValue with it', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal', defaultValue: '10493.75' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    expect(el.value).toBe('10,493.75');
  });

  it('repairs the deployed screen’s own mis-grouping ("1,0493.75")', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal', defaultValue: '1,0493.75' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    expect(el.value).toBe('10,493.75');
  });

  it('leaves a value that is not a number alone (the server has the sentence for it)', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal', defaultValue: 'not a number' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    expect(el.value).toBe('not a number');
  });
});

describe('typing', () => {
  it('groups as digits are typed and keeps the caret on the same digit', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    await act(async () => {
      type(el, '1049', 2);
    });
    expect(el.value).toBe('1,049');
    expect(el.selectionStart).toBe(3);
  });

  it('drops letters, a peso sign and any other symbol as it is typed or pasted', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal' })));
    const el = input(host);
    await act(async () => {
      type(el, '12a3b4.5');
    });
    expect(el.value).toBe('1,234.5');
    await act(async () => {
      type(el, '₱1,234.50abc');
    });
    expect(el.value).toBe('1,234.50');
  });

  it('keeps one number when a separator is typed by hand', async () => {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal' })));
    const el = input(host);
    await act(async () => {
      type(el, '1698');
    });
    expect(el.value).toBe('1,698');
    await act(async () => {
      type(el, '16,980');
    });
    expect(el.value).toBe('16,980');
  });

  it('whole-number boxes take digits and never group them (a six-digit PIN must not become 123,456)', async () => {
    const host = await mount(h('form', null, h('input', { name: 'pin', inputMode: 'numeric' })));
    const el = input(host);
    await act(async () => {
      type(el, '123456');
    });
    expect(el.value).toBe('123456');
    await act(async () => {
      type(el, '12a3-4');
    });
    expect(el.value).toBe('1234');
  });

  it('⭐ keeps a leading zero in a whole-number box (a PIN with a leading zero must survive)', async () => {
    const host = await mount(h('form', null, h('input', { name: 'pin', inputMode: 'numeric' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    await act(async () => {
      type(el, '012345');
    });
    expect(el.value).toBe('012345');
    await act(async () => {
      type(el, '0123456');
    });
    expect(el.value).toBe('0123456');
  });

  it('leaves a type="number" box to the browser', async () => {
    const host = await mount(h('form', null, h('input', { name: 'year', type: 'number', defaultValue: '1234' })));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    await act(async () => {
      type(el, '1234');
    });
    expect(el.value).toBe('1234');
  });

  it('does not touch a disabled or read-only box', async () => {
    const host = await mount(
      h('form', null, h('input', { name: 'a', inputMode: 'decimal', defaultValue: '1234', disabled: true }), h('input', { name: 'b', inputMode: 'decimal', defaultValue: '1234', readOnly: true })),
    );
    const [a, b] = Array.from(host.querySelectorAll('input'));
    await act(async () => {
      a?.focus();
      b?.focus();
    });
    expect(a?.value).toBe('1234');
    expect(b?.value).toBe('1234');
  });
});

describe('Backspace / Delete next to a grouping comma (audit N-001)', () => {
  async function boxWith(typed: string) {
    const host = await mount(h('form', null, h('input', { name: 'amount', inputMode: 'decimal' })));
    const el = input(host);
    await act(async () => {
      el.focus();
      type(el, typed);
    });
    return el;
  }

  it('Backspace right after the comma deletes the digit before it: 1,234 -> 234', async () => {
    const el = await boxWith('1234');
    expect(el.value).toBe('1,234');
    await act(async () => {
      el.setSelectionRange(2, 2);
      press(el, 'Backspace');
    });
    expect(el.value).toBe('234');
    expect(el.selectionStart).toBe(0);
  });

  it('Delete right before the comma deletes the digit after it: 1,234 -> 134', async () => {
    const el = await boxWith('1234');
    await act(async () => {
      el.setSelectionRange(1, 1);
      press(el, 'Delete');
    });
    expect(el.value).toBe('134');
    expect(el.selectionStart).toBe(1);
  });

  it('keeps going: repeated Backspace across commas keeps deleting digits, never sticks', async () => {
    const el = await boxWith('1234567');
    await act(async () => {
      el.setSelectionRange(6, 6);
    });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await act(async () => press(el, 'Backspace'));
      seen.push(el.value);
    }
    expect(seen).toEqual(['123,567', '12,567', '1,567']);
  });

  it('a Backspace away from a comma still deletes the plain character and regroups', async () => {
    const el = await boxWith('1234567');
    expect(el.value).toBe('1,234,567');
    await act(async () => {
      el.setSelectionRange(9, 9);
      press(el, 'Backspace');
    });
    expect(el.value).toBe('123,456');
  });
});

describe('submit', () => {
  it('strips the grouping before the form is read, then puts the display back', async () => {
    let seen: string | null = null;
    const host = await mount(
      h(
        'form',
        {
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault();
            seen = input(host).value;
          },
        },
        h('input', { name: 'amount', inputMode: 'decimal', defaultValue: '10493.75' }),
      ),
    );
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    expect(el.value).toBe('10,493.75');
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(seen).toBe('10493.75');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(el.value).toBe('10,493.75');
  });
});

describe('a controlled box (MoneyLines)', () => {
  it('keeps React’s own value in step with the grouped text', async () => {
    function Controlled() {
      const [value, setValue] = useState('1049');
      return h('input', { name: 'amount', inputMode: 'decimal', value, onChange: (event: { target: { value: string } }) => setValue(event.target.value) });
    }
    const host = await mount(h(Controlled));
    const el = input(host);
    await act(async () => {
      type(el, '10495', 6);
    });
    expect(el.value).toBe('10,495');
    // A re-render must not put the ungrouped state value back.
    await act(async () => {
      type(el, '1049500', 8);
    });
    expect(el.value).toBe('1,049,500');
  });

  it('groups a controlled box on focus and survives a re-render (the tracker trap)', async () => {
    let bump: () => void = () => undefined;
    function Controlled() {
      const [value, setValue] = useState('10493.75');
      const [, setTick] = useState(0);
      bump = () => setTick((n) => n + 1);
      return h('input', {
        name: 'amount',
        inputMode: 'decimal',
        value,
        onChange: (event: { target: { value: string } }) => setValue(event.target.value),
      });
    }
    const host = await mount(h(Controlled));
    const el = input(host);
    await act(async () => {
      el.focus();
    });
    expect(el.value).toBe('10,493.75');
    // If writing the value had updated React's tracker, no onChange would have fired, the state would still be
    // "10493.75", and this re-render would silently put the ungrouped value back.
    await act(async () => {
      bump();
    });
    expect(el.value).toBe('10,493.75');
  });
});

describe('a comma the app added is not an edit (EditableRecord’s “changed?” test)', () => {
  const box = { name: 'channel_x', type: 'text', numeric: true, value: '10,493.75', defaultValue: '10493.75' };
  it('a regrouped value is unchanged', () => {
    expect(changedNames([box])).toEqual([]);
  });
  it('a different figure is a change', () => {
    expect(changedNames([{ ...box, value: '10,494.75' }])).toEqual(['channel_x']);
  });
  it('a non-number field still compares byte for byte', () => {
    expect(changedNames([{ ...box, numeric: false, value: '10,493.75' }])).toEqual(['channel_x']);
  });
  it('an emptied box is a change', () => {
    expect(changedNames([{ ...box, value: '' }])).toEqual(['channel_x']);
  });
});

describe('it is mounted where the whole app sees it', () => {
  it('the root layout renders NumericEntryBehaviour', () => {
    const layout = readFileSync(resolve(__dirname, '../src/app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/from '@\/components\/forms\/NumericEntry'/);
    expect(layout).toMatch(/<NumericEntryBehaviour\s*\/>/);
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisclosureCard } from '../src/components/ui/DisclosureCard';
import { rememberScreen } from '../src/components/shell/screen-state';
import { observePhoneTables } from '../src/components/ui/phone-table-cards';

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.body.replaceChildren(); sessionStorage.clear(); vi.restoreAllMocks(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function mount() {
  const root = document.createElement('main');
  root.innerHTML = '<details id="new-item"><summary>Request a new item</summary><input name="name" value="Not stored"></details><div data-screen-scroll="catalogue"><table><thead><tr><th>Item</th><th>Kind</th><th>Code</th></tr></thead><tbody><tr><td><a href="/items/apple">Apple</a></td><td>Supply</td><td>APPL-001</td></tr></tbody></table></div>';
  document.body.append(root); stops.push(observePhoneTables(root)); return root;
}
describe('T450 return to the same screen presentation', () => {
  it('renders the collapsed Add disclosure with its original form present and no nested button', () => {
    const html = renderToStaticMarkup(h(DisclosureCard, { id: 'new-item', title: 'Request a new item', action: 'Add', children: h('form', null, h('input', { name: 'name' })) }));
    expect(html).toContain('<details'); expect(html).not.toContain(' open=');
    expect(html).toContain('<summary'); expect(html).toContain('Add'); expect(html).toContain('name="name"');
    expect(html).not.toContain('<button');
  });
  it('restores document/panel scroll, disclosures and expanded cards after navigating away and returning', async () => {
    history.replaceState(null, '', '/items?kind=supply'); const root = mount();
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(720);
    const stop = rememberScreen(root, 'reviewer');
    root.querySelector('details')!.open = true;
    root.querySelector('tr[data-card-kind]')!.setAttribute('data-card-expanded', 'true');
    root.querySelector<HTMLElement>('[data-screen-scroll]')!.scrollTop = 170;
    window.dispatchEvent(new Event('pagehide')); stop(); root.remove();
    history.replaceState(null, '', '/items/apple');
    const detail = document.createElement('main'); detail.innerHTML = '<a data-screen-return href="/items">Items</a>'; document.body.append(detail);
    stops.push(rememberScreen(detail, 'reviewer'));
    expect(detail.querySelector('a')?.getAttribute('href')).toBe('/items?kind=supply'); detail.remove();
    history.replaceState(null, '', '/items?kind=supply'); const returned = mount(); stops.push(rememberScreen(returned, 'reviewer')); await tick();
    expect(scroll).toHaveBeenCalledWith({ left: 0, top: 720, behavior: 'instant' });
    expect(returned.querySelector('details')?.open).toBe(true);
    expect(returned.querySelector('[data-card-expanded]')).not.toBeNull();
    expect(returned.querySelector<HTMLElement>('[data-screen-scroll]')?.scrollTop).toBe(170);
    expect(sessionStorage.getItem('erp-screen:reviewer')).not.toContain('Not stored');
  });
  it('isolates accounts and URLs, respects fragments and tolerates blocked storage', () => {
    history.replaceState(null, '', '/items'); const root = mount();
    stops.push(rememberScreen(root, 'one')); window.dispatchEvent(new Event('pagehide'));
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    stops.push(rememberScreen(root, 'two')); expect(scroll).not.toHaveBeenCalled();
    history.replaceState(null, '', '/items#new-item'); stops.push(rememberScreen(root, 'one')); expect(scroll).not.toHaveBeenCalled();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(() => stops.push(rememberScreen(root, 'blocked'))).not.toThrow();
  });
  it('ignores malformed storage and stops restoring when the user interacts', async () => {
    history.replaceState(null, '', '/items'); sessionStorage.setItem('erp-screen:reviewer', '{broken'); const root = mount();
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const stop = rememberScreen(root, 'reviewer'); window.dispatchEvent(new Event('pagehide')); stop();
    stops.push(rememberScreen(root, 'reviewer')); window.dispatchEvent(new Event('wheel')); scroll.mockClear();
    root.append(document.createElement('div')); await tick(); expect(scroll).not.toHaveBeenCalled();
  });
  it('restores streamed cards and never replays a transient flash query in an ancestor return link', async () => {
    history.replaceState(null, '', '/items?kind=supply&f=transient'); const first = mount();
    const stop = rememberScreen(first, 'reviewer');
    first.querySelector('tr[data-card-kind]')!.setAttribute('data-card-expanded', 'true');
    window.dispatchEvent(new Event('pagehide')); stop(); first.remove();
    history.replaceState(null, '', '/items/apple');
    const detail = document.createElement('main'); detail.innerHTML = '<a href="/items">← Items</a><a href="https://other.example/items">← Other</a>'; document.body.append(detail);
    const detailStop = rememberScreen(detail, 'reviewer'); expect(detail.querySelector('a')?.getAttribute('href')).toBe('/items?kind=supply');
    expect(detail.querySelectorAll('a')[1]?.getAttribute('href')).toBe('https://other.example/items'); detailStop(); detail.remove();
    history.replaceState(null, '', '/items?kind=supply'); const late = document.createElement('main'); document.body.append(late);
    stops.push(observePhoneTables(late)); stops.push(rememberScreen(late, 'reviewer'));
    const incoming = mount(); late.innerHTML = incoming.innerHTML; incoming.remove(); await tick();
    expect(late.querySelector('[data-card-expanded]')).not.toBeNull();
  });
});

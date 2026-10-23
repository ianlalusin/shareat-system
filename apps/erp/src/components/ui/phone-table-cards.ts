/** T-450: annotate original nodes. Never mount copies, reparent controls or inspect their values. */
const CONTROL = 'button,a[href],input:not([type="hidden"]),select,textarea,[tabindex]';
const EDITOR = 'button,input:not([type="hidden"]),select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable]:not([contenteditable="false"])';
const cellsOf = (row: HTMLTableRowElement) => Array.from(row.cells).filter(cell => !cell.hasAttribute('data-card-toggle-cell'));
let detailId = 0;
function attribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
function role(element: Element, value: string) {
  if (!element.hasAttribute('role')) element.setAttribute('role', value);
}
function headerText(cell: Element): string {
  const explicit = cell.getAttribute('data-card-heading') ?? cell.getAttribute('aria-label');
  if (explicit) return explicit;
  // Detached text-only inspection; the clone is NEVER mounted or given handlers.
  const copy = cell.cloneNode(true) as Element;
  copy.querySelectorAll('form,input,select,textarea,[aria-hidden="true"],table').forEach(node => node.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function span(cell: HTMLTableCellElement, name: 'colSpan' | 'rowSpan', remaining: number): number {
  const value = cell[name];
  if (!Number.isSafeInteger(value)) return 1;
  return value === 0 ? remaining : Math.max(1, Math.min(value, 1000));
}
/** HTML's logical columns include slots occupied by earlier rowspans. */
function cellGrid(rows: HTMLTableRowElement[]): HTMLTableCellElement[][] {
  const grid: HTMLTableCellElement[][] = [];
  rows.forEach((row, y) => {
    const slots = grid[y] ?? (grid[y] = []); let x = 0;
    cellsOf(row).forEach(cell => {
      while (slots[x]) x++;
      const height = Math.min(span(cell, 'rowSpan', rows.length - y), rows.length - y);
      const width = span(cell, 'colSpan', 1);
      // Expand validated DOM span counts, never relational comparisons on parsed text/money.
      const columns = Array.from({ length: width }, (_, offset) => offset);
      for (const dy of Array.from({ length: height }, (_, offset) => offset)) {
        const target = grid[y + dy] ?? (grid[y + dy] = []);
        for (const dx of columns) target[x + dx] = cell;
      }
      x += width;
    });
  });
  return grid;
}
const distinct = (labels: string[]) => [...new Set(labels.filter(Boolean))];

function summarizeRow(table: HTMLTableElement, row: HTMLTableRowElement) {
  const cells = cellsOf(row);
  if (!cells.length) return;
  const named = (name: string | null) => name ? cells.find(cell => cell.dataset.cardLabel?.toLowerCase() === name.toLowerCase()) : undefined;
  const label = (cell: HTMLTableCellElement) => cell.dataset.cardLabel ?? '';
  const editable = (cell: HTMLTableCellElement) => Boolean(cell.querySelector(EDITOR));
  const imageCell = cells.find(cell => cell.querySelector('img') && (/photo|image|picture|avatar/i.test(label(cell)) || !headerText(cell)));
  const available = cells.filter(cell => cell !== imageCell);
  const title = named(table.getAttribute('data-card-title'))
    ?? available.find(cell => /^(item|name|person|supplier|customer|account|figure|activity|description|what|reference|invoice|order)(\b|$)/i.test(label(cell)) && !editable(cell))
    ?? available.find(cell => !editable(cell)) ?? available[0];
  if (!title) return;
  const remaining = available.filter(cell => cell !== title);
  const configuredKeys = table.getAttribute('data-card-keys');
  const ranked = [ /balance|amount due|grand total|net total/i, /amount|total|debit|credit/i, /status/i, /quantity|on.hand|stock/i, /price|rate|cost|priced per/i ];
  const automaticKeys = [...new Set(ranked.flatMap(pattern => remaining.filter(cell => !editable(cell) && pattern.test(label(cell)))))];
  const keys = configuredKeys !== null ? configuredKeys.split('|').flatMap(name => {
    const found = named(name.trim()); return found && found !== title && !editable(found) ? [found] : [];
  }).slice(0, 2) : automaticKeys.slice(0, 2);
  const subtitle = named(table.getAttribute('data-card-subtitle'))
    ?? remaining.find(cell => !keys.includes(cell) && !editable(cell) && /kind|type|description|code|reference|date|day|supplier|customer/i.test(label(cell)))
    ?? remaining.find(cell => !keys.includes(cell) && !editable(cell) && Boolean(headerText(cell)));
  const group = (cells.length === 1 && cells[0]?.dataset.cardSpan === 'full') || cells.some(cell => cell.querySelector('table'));
  attribute(row, 'data-card-kind', group ? 'group' : 'summary');
  if (keys.length && !group) attribute(row, 'data-card-has-keys', '');
  else row.removeAttribute('data-card-has-keys');
  const text = headerText(title);
  const words = text.split(/\s+/).filter(Boolean);
  const initials = [words[0], words.length === 1 ? undefined : words[words.length - 1]]
    .filter((word): word is string => Boolean(word)).map(word => [...word][0] ?? '').join('').toUpperCase();
  attribute(row, 'data-card-avatar', initials || '·');
  const image = imageCell?.querySelector('img') ?? title.querySelector('img');
  if (image) { attribute(row, 'data-card-has-image', ''); attribute(image, 'data-card-image', ''); }
  else row.removeAttribute('data-card-has-image');
  const extras: HTMLTableCellElement[] = [];
  for (const cell of cells) {
    const keyIndex = keys.indexOf(cell);
    const slot = group ? 'group' : cell === imageCell ? 'media' : cell === title ? 'title'
      : editable(cell) ? 'actions' : keyIndex !== -1 ? 'key' : cell === subtitle ? 'subtitle' : 'extra';
    attribute(cell, 'data-card-slot', slot);
    if (slot === 'key') attribute(cell, 'data-card-key-order', String(keyIndex + 1));
    else cell.removeAttribute('data-card-key-order');
    if (slot === 'extra') extras.push(cell);
  }
  let toggleCell = Array.from(row.cells).find(cell => cell.hasAttribute('data-card-toggle-cell'));
  if (!extras.length) {
    toggleCell?.remove(); row.removeAttribute('data-card-has-extra'); row.removeAttribute('data-card-expanded'); return;
  }
  attribute(row, 'data-card-has-extra', '');
  if (!toggleCell) {
    toggleCell = table.ownerDocument.createElement('td');
    toggleCell.setAttribute('data-card-toggle-cell', ''); toggleCell.setAttribute('role', table.getAttribute('role') === 'grid' ? 'gridcell' : 'cell');
    const button = table.ownerDocument.createElement('button'); button.type = 'button';
    button.setAttribute('data-card-toggle', '');
    const svg = table.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = table.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm7 6 5 5 5-5M7 13l5 5 5-5'); svg.append(path); button.append(svg);
    toggleCell.append(button); row.append(toggleCell);
  }
  const button = toggleCell.querySelector('button');
  if (button) {
    attribute(button, 'aria-expanded', String(row.hasAttribute('data-card-expanded')));
    attribute(button, 'aria-label', `More details for ${text || label(title)}`);
    for (const cell of extras) if (!cell.id) attribute(cell, 'id', `phone-card-detail-${++detailId}`);
    attribute(button, 'aria-controls', extras.map(cell => cell.id).join(' '));
  }
}

function enhanceTable(table: HTMLTableElement) {
  const rows = Array.from(table.rows).filter(row => row.closest('table') === table);
  const headRows = rows.filter(row => row.parentElement === table.tHead);
  const headers = cellGrid(headRows);
  const explicit = table.getAttribute('data-card-columns')?.split('|').map(label => label.trim());
  const columnCount = Math.max(explicit?.length ?? 0, ...rows.map(row =>
    cellsOf(row).reduce((count, cell) => count + span(cell, 'colSpan', 1), 0)), 0);
  const labels = Array.from({ length: columnCount }, (_, x) => explicit?.[x]
    ?? distinct(headers.flatMap(row => row[x] ? [headerText(row[x])] : [])).join(' · '));
  role(table, 'table');
  for (const section of [table.tHead, ...Array.from(table.tBodies), table.tFoot]) {
    if (section) role(section, 'rowgroup');
  }
  for (const row of headRows) {
    role(row, 'row');
    Array.from(row.cells).forEach(cell => {
      role(cell, 'columnheader');
      if (cell.querySelector(CONTROL)) attribute(cell, 'data-card-control', '');
      else cell.removeAttribute('data-card-control');
    });
  }
  if (table.tHead) {
    if (table.tHead.querySelector(CONTROL)) attribute(table.tHead, 'data-card-controls', '');
    else table.tHead.removeAttribute('data-card-controls');
  }
  const sections = [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])];
  for (const section of sections) {
    const bodyRows = Array.from(section.children).filter((element): element is HTMLTableRowElement => element.tagName === 'TR');
    const bodyGrid = cellGrid(bodyRows);
    bodyRows.forEach((row, y) => {
      role(row, 'row');
      cellsOf(row).forEach(cell => {
        role(cell, cell.tagName === 'TH' ? 'rowheader' : table.getAttribute('role') === 'grid' ? 'gridcell' : 'cell');
        const x = bodyGrid[y]?.indexOf(cell) ?? 0;
        const referenced = cell.getAttribute('headers')?.split(/\s+/).flatMap(id => {
          const header = table.ownerDocument.getElementById(id);
          return header?.closest('table') === table ? [headerText(header)] : [];
        });
        const label = referenced?.length ? distinct(referenced).join(' · ')
          : distinct(labels.slice(x, x + cell.colSpan)).join(' · ');
        const fallback = cell.querySelector('input[type="checkbox"],input[type="radio"]') ? 'Select'
          : cell.querySelector(CONTROL) ? 'Actions' : 'Details';
        attribute(cell, 'data-card-label', label || fallback);
        if (cell.colSpan > 1 && cell.colSpan >= columnCount) attribute(cell, 'data-card-span', 'full');
        else cell.removeAttribute('data-card-span');
      });
      summarizeRow(table, row);
    });
  }
  // Set last: unannotated tables remain the usable native fallback while streaming/hydrating.
  attribute(table, 'data-phone-cards', '');
}

export function enhancePhoneTables(root: HTMLElement): void {
  root.querySelectorAll<HTMLTableElement>('table').forEach(enhanceTable);
}

/** React stamps `__reactFiber$...` on a DOM node when it hydrates it. A table without it is still dehydrated server HTML. */
const isHydrated = (el: Element) => Object.keys(el).some(key => key.startsWith('__reactFiber$'));

export interface ObservePhoneTablesOptions {
  /**
   * Inserting the toggle cell changes a row's children, so doing it to HTML React has not hydrated yet is a hydration
   * mismatch (minified React error #418, DEF-740). Streamed-in Suspense content arrives after the shell has hydrated;
   * with this on, such tables stay native until React owns them, then are annotated.
   */
  readonly awaitHydration?: boolean;
}

export function observePhoneTables(root: HTMLElement, options: ObservePhoneTablesOptions = {}): () => void {
  const view = root.ownerDocument.defaultView;
  const waiting = new Set<HTMLTableElement>();
  let timer: number | undefined;
  let tries = 0;
  const settle = () => {
    timer = undefined;
    for (const table of Array.from(waiting)) {
      if (!root.contains(table)) waiting.delete(table);
      else if (isHydrated(table)) { waiting.delete(table); enhanceTable(table); }
    }
    // Hydration of streamed boundaries is quick; give up quietly after ~10 s and leave the native table.
    if (waiting.size && view && ++tries < 100) timer = view.setTimeout(settle, 100);
  };
  const enhance = (table: HTMLTableElement) => {
    if (!options.awaitHydration || isHydrated(table)) return enhanceTable(table);
    waiting.add(table);
    if (!timer && view) { tries = 0; timer = view.setTimeout(settle, 50); }
  };
  root.querySelectorAll<HTMLTableElement>('table').forEach(enhance);
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('button[data-card-toggle]');
    const row = button?.closest('tr'); if (!button || !row || !root.contains(row)) return;
    event.preventDefault(); event.stopPropagation();
    if (row.hasAttribute('data-card-expanded')) row.removeAttribute('data-card-expanded');
    else attribute(row, 'data-card-expanded', 'true');
    attribute(button, 'aria-expanded', String(row.hasAttribute('data-card-expanded')));
  };
  root.addEventListener('click', onClick);
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  if (!Observer) return () => { if (timer) view?.clearTimeout(timer); root.removeEventListener('click', onClick); };
  const observer = new Observer(records => {
    const tables = new Set<HTMLTableElement>();
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
      const table = target?.closest<HTMLTableElement>('table'); if (table && root.contains(table)) tables.add(table);
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (element.tagName === 'TABLE') tables.add(element as HTMLTableElement);
        element.querySelectorAll<HTMLTableElement>('table').forEach(added => tables.add(added));
      }
    }
    tables.forEach(table => { if (root.contains(table)) enhance(table); });
  });
  // Annotation attributes/roles are deliberately excluded: our writes cannot trigger a feedback loop.
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['colspan', 'rowspan', 'headers', 'aria-label', 'data-card-heading', 'data-card-columns', 'data-card-title', 'data-card-subtitle', 'data-card-keys'] });
  return () => { observer.disconnect(); if (timer) view?.clearTimeout(timer); root.removeEventListener('click', onClick); };
}

/** T-450: annotate original nodes. Never mount copies, reparent controls or inspect their values. */
const CONTROL = 'button,a[href],input:not([type="hidden"]),select,textarea,[tabindex]';
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
    Array.from(row.cells).forEach(cell => {
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

function enhanceTable(table: HTMLTableElement) {
  const rows = Array.from(table.rows).filter(row => row.closest('table') === table);
  const headRows = rows.filter(row => row.parentElement === table.tHead);
  const headers = cellGrid(headRows);
  const explicit = table.getAttribute('data-card-columns')?.split('|').map(label => label.trim());
  const columnCount = Math.max(explicit?.length ?? 0, ...rows.map(row =>
    Array.from(row.cells).reduce((count, cell) => count + span(cell, 'colSpan', 1), 0)), 0);
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
      Array.from(row.cells).forEach(cell => {
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
    });
  }
  // Set last: unannotated tables remain the usable native fallback while streaming/hydrating.
  attribute(table, 'data-phone-cards', '');
}

export function enhancePhoneTables(root: HTMLElement): void {
  root.querySelectorAll<HTMLTableElement>('table').forEach(enhanceTable);
}

export function observePhoneTables(root: HTMLElement): () => void {
  enhancePhoneTables(root);
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  if (!Observer) return () => {};
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
    tables.forEach(table => { if (root.contains(table)) enhanceTable(table); });
  });
  // Annotation attributes/roles are deliberately excluded: our writes cannot trigger a feedback loop.
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['colspan', 'rowspan', 'headers', 'aria-label', 'data-card-heading', 'data-card-columns'] });
  return () => observer.disconnect();
}

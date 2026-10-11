/**
 * element-forms.ts - T-390 S5 tester helper. Walks a React element tree (expanding function components, reading the children of
 * hook-using client components) and lists every form with its action, hidden fields and control names.
 */
// ---- element-tree walk ------------------------------------------------------------------------------------------------

type El = { type: unknown; props: Record<string, unknown> };
export async function walk(node: unknown, visit: (el: El) => void): Promise<void> {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const n of node) await walk(n, visit);
    return;
  }
  if (typeof (node as { then?: unknown }).then === 'function') return walk(await (node as Promise<unknown>), visit);
  if (typeof node !== 'object' || !('props' in (node as object))) return;
  const el = node as El;
  visit(el);
  const t = el.type as { prototype?: { isReactComponent?: unknown } } | ((p: unknown) => unknown);
  if (typeof t === 'function' && !t.prototype?.isReactComponent) {
    try {
      await walk(await (t as (p: unknown) => unknown)(el.props), visit);
      return;
    } catch {
      /* a client component (hooks): fall back to its children */
    }
  }
  await walk(el.props['children'], visit);
}
export interface FormInfo {
  action: unknown;
  hidden: Record<string, string>;
  names: Set<string>;
}
export async function formsOf(root: unknown): Promise<FormInfo[]> {
  const forms: El[] = [];
  await walk(root, (el) => {
    if (el.type === 'form' || (el.props['action'] !== undefined && el.props['hidden'] !== undefined)) forms.push(el);
  });
  const out: FormInfo[] = [];
  for (const fm of forms) {
    const names = new Set<string>();
    const hidden: Record<string, string> = { ...((fm.props['hidden'] as Record<string, string> | undefined) ?? {}) };
    await walk(fm.props['children'], (el) => {
      if (el.type === 'input' || el.type === 'select' || el.type === 'textarea') {
        const n = el.props['name'];
        if (typeof n === 'string') {
          names.add(n);
          if (el.type === 'input' && el.props['type'] === 'hidden' && typeof el.props['value'] === 'string') hidden[n] = el.props['value'];
        }
      }
    });
    out.push({ action: fm.props['action'], hidden, names });
  }
  return out;
}


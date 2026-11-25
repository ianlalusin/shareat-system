import type { FieldDef } from '@shareat/domain/documents/doc';

/**
 * The list that opens when `{{` is typed in the editor (and under "Insert field"). T-637 s3. Presentational: the editor owns the filtering (`suggestFields`) and the keys; this draws the
 * label, the raw name and a sample value for each field, and picks on press (mouse-down, so the editor keeps its cursor).
 */
export function FieldSuggestList({ items, selected, onPick, id }: { items: readonly FieldDef[]; selected: number; onPick: (f: FieldDef) => void; id?: string }) {
  if (items.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted" role="status">
        No field starts with that. Keep typing, or press Esc.
      </p>
    );
  }
  return (
    <ul id={id} role="listbox" aria-label="Fields you can insert" className="max-h-64 overflow-y-auto py-1">
      {items.map((f, i) => (
        <li key={f.name} role="option" aria-selected={i === selected}>
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(f);
            }}
            className={`flex min-h-11 w-full flex-col items-start justify-center px-3 py-1 text-left text-sm ${i === selected ? 'bg-canvas' : ''}`}
          >
            <span className="font-medium text-ink">{f.label}</span>
            <span className="text-xs text-muted">
              <span className="font-mono">{`{{${f.name}}}`}</span> · e.g. {f.sample}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

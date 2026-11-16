import { parseBody } from '@shareat/domain';

/**
 * A document's wording, drawn as React TEXT. T-584 s6.
 *
 * The wording is plain text with three marks (blank line = paragraph, `# ` = heading, `**bold**`); `parseBody` returns data and this component draws it
 * as text nodes inside ordinary elements. There is no HTML anywhere in the path: nothing an author types can become a tag, an attribute or a script, so
 * `<script>` in a template prints as the characters `<script>`. A single newline inside a paragraph stays a line break (`whitespace-pre-line`).
 */
export function DocumentBody({ body, className }: { body: string; className?: string }) {
  return (
    <div className={className}>
      {parseBody(body).map((block, i) =>
        block.type === 'heading' ? (
          <h2 key={i} className="mt-4 text-lg font-semibold first:mt-0">
            {block.text}
          </h2>
        ) : (
          <p key={i} className="mt-3 whitespace-pre-line first:mt-0">
            {block.runs.map((r, j) => (r.bold ? <strong key={j}>{r.text}</strong> : <span key={j}>{r.text}</span>))}
          </p>
        ),
      )}
    </div>
  );
}

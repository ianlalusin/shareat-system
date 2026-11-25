/**
 * T-641 - the "learnt truth": search over the approved documents, built into `knowledge.generated.json` by `scripts/build-ask-knowledge.mjs` (the glossary, the rules, the decision log, the
 * posting patterns and the how-to manual). Plain keyword scoring (BM25) in code: no vector database, no embeddings, no network. The model reaches it only through the `searchKnowledge`
 * tool, on demand, and never learns from chats: the file changes only when someone rebuilds it from a changed document.
 *
 * Two audiences. "everyone" (the manual, the glossary) is searched for anybody who may use Ask ERP. "manager" (the rules, the decision log, the posting patterns) only for a person who may
 * read the financial reports. A later admin-written note (the `ai_knowledge` table, deferred) joins as `extra`, approved notes only, through the same search.
 */
export type KnowledgeAudience = 'everyone' | 'manager';
export interface KnowledgeChunk {
  readonly id: string;
  readonly source: string;
  readonly audience: KnowledgeAudience;
  readonly title: string;
  readonly text: string;
}
export interface KnowledgeHit {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
}

const STOP: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from', 'what', 'how', 'why', 'who', 'when', 'where', 'does', 'did', 'has', 'have', 'can', 'not', 'you', 'our', 'your', 'its', 'into', 'than',
  'then', 'there', 'their', 'about', 'which', 'would', 'should', 'could', 'any', 'all', 'but', 'out', 'use', 'used', 'get', 'ang', 'ng', 'sa', 'na', 'ba', 'ko', 'mo', 'ano', 'paano',
  'is', 'at', 'or', 'of', 'to', 'in', 'on', 'be', 'by', 'as', 'it', 'an', 'do', 'if', 'we', 'my', 'me', 'so', 'no', 'up', 'us',
]);

/** Lower case, accents folded ("A la carte" and "a la carte" match), words of two letters or more, a trailing plural "s" dropped. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

interface Index {
  docs: { chunk: KnowledgeChunk; tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avgLen: number;
}

const TITLE_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;
const indexes = new WeakMap<readonly KnowledgeChunk[], Index>();

function indexOf(chunks: readonly KnowledgeChunk[]): Index {
  const known = indexes.get(chunks);
  if (known) return known;
  const df = new Map<string, number>();
  const docs = chunks.map((chunk) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(chunk.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tokenize(chunk.title)) tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    let len = 0;
    for (const n of tf.values()) len += n;
    return { chunk, tf, len };
  });
  const built: Index = { docs, df, avgLen: docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0 };
  indexes.set(chunks, built);
  return built;
}

export interface SearchOptions {
  /** May this person read the "manager" audience? */
  manager: boolean;
  limit?: number;
}

/** The best matching chunks for a question, the allowed audiences only, best first. Empty when nothing shares a word with the question. */
export function searchChunks(chunks: readonly KnowledgeChunk[], query: string, opts: SearchOptions): KnowledgeHit[] {
  const idx = indexOf(chunks);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || idx.docs.length === 0) return [];
  const n = idx.docs.length;
  const hits: KnowledgeHit[] = [];
  for (const d of idx.docs) {
    if (d.chunk.audience === 'manager' && !opts.manager) continue;
    let score = 0;
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      const df = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / idx.avgLen)));
    }
    if (score > 0) hits.push({ id: d.chunk.id, source: d.chunk.source, title: d.chunk.title, text: d.chunk.text, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit ?? 5);
}

let loaded: Promise<readonly KnowledgeChunk[]> | null = null;
/** The built file, read once per process and only when a question first needs it (it is about half a megabyte). */
function builtChunks(): Promise<readonly KnowledgeChunk[]> {
  loaded ??= import('./knowledge.generated.json').then((m) => (m.default ?? m) as unknown as readonly KnowledgeChunk[]);
  return loaded;
}

export async function searchKnowledge(query: string, opts: SearchOptions, extra: readonly KnowledgeChunk[] = []): Promise<KnowledgeHit[]> {
  const built = await builtChunks();
  return searchChunks(extra.length === 0 ? built : [...built, ...extra], query, opts);
}

#!/usr/bin/env node
/**
 * T-641 - turns the approved documents into the searchable knowledge file Ask ERP reads.
 *
 *     node scripts/build-ask-knowledge.mjs            # writes packages/domain/src/ask-erp/knowledge.generated.json
 *     node scripts/build-ask-knowledge.mjs --check    # exits 1 if the committed file is out of date (tests/unit/t641-knowledge-build.test.ts does the same in-process)
 *
 * WHAT GOES IN (a short, closed list; adding a source is a change to this file, reviewed):
 *   docs/ask-erp-manual.md      how-to, plain words                   -> audience "everyone"
 *   docs/GLOSSARY.md            what the words really mean            -> audience "everyone"
 *   docs/RULES.md               the operating rules, one page         -> audience "manager"
 *   PROJECT_BIBLE.md section 13 the decision log, one chunk per row   -> audience "manager"
 *   docs/POSTING-PATTERNS.md    how each business event posts         -> audience "manager"
 * "manager" knowledge is searched only for a person who may read the financial reports; "everyone" for anyone who may use Ask ERP at all.
 *
 * The output is DETERMINISTIC (no dates, stable order), so a test can rebuild it and compare. Code blocks are dropped, link targets are dropped, and anything that looks like a
 * network address, an e-mail address or a key is replaced before it is written: the privacy guard scrubs again on every answer, but nothing sensitive should be in the file at all.
 * The model never learns from chats: this file changes only when someone runs this script on a changed document.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'packages/domain/src/ask-erp/knowledge.generated.json';
const MAX_CHARS = 1200;
const MAX_ROW_CHARS = 1500;

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Plain text for a model: no code blocks, no link targets, no backticks, nothing that looks like an address or a key. */
export function clean(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[☀-➿⬀-⯿️\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]')
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}/g, '[key]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';

/** Splits markdown into sections by heading (levels 1 to 3), each with its body text. */
function sections(md) {
  const out = [];
  let cur = { heading: '', body: [] };
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push(cur);
      cur = { heading: h[2].trim(), body: [] };
    } else cur.body.push(line);
  }
  out.push(cur);
  return out.filter((s) => s.body.join('').trim().length > 0);
}

/** A section's body as blocks: paragraphs, and each table row on its own (the header and separator rows are dropped). */
function blocks(body) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(para.join(' ').trim());
    para = [];
  };
  let tableRows = 0;
  for (const line of body) {
    if (line.trim() === '') {
      flush();
      tableRows = 0;
    } else if (line.startsWith('|')) {
      flush();
      tableRows += 1;
      if (tableRows === 1) continue; // header row
      if (/^\|[\s:|-]+\|?\s*$/.test(line.trim())) continue; // separator
      out.push(line.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' - '));
    } else para.push(line.trim().replace(/^>+\s*/, ''));
  }
  flush();
  return out.filter((b) => b.length > 0);
}

/** Greedy merge of blocks into chunks of at most MAX_CHARS (a single longer block is cut). */
function merge(list) {
  const out = [];
  let cur = '';
  for (const b of list.map((x) => clean(x)).filter(Boolean)) {
    if (cur && cur.length + b.length + 1 > MAX_CHARS) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${b}` : b;
    if (cur.length > MAX_CHARS) {
      out.push(cur.slice(0, MAX_CHARS));
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function fromMarkdown(md, { source, audience, prefix, firstChunkOnly = false, skip = () => false }) {
  const chunks = [];
  const used = new Map();
  const noCode = md.replace(/```[\s\S]*?```/g, ' ');
  for (const s of sections(noCode)) {
    if (skip(s.heading)) continue;
    const title = clean(s.heading) || source;
    let parts = merge(blocks(s.body));
    if (firstChunkOnly) parts = parts.slice(0, 1);
    parts.forEach((text, i) => {
      const base = `${prefix}:${slug(title)}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      chunks.push({ id: n === 1 ? base : `${base}-${n}`, source, audience, title: i === 0 ? title : `${title} (cont.)`, text });
    });
  }
  return chunks;
}

/** The decision log: one chunk per table row of section 13, "Decision N (date): what. Why." */
function decisions(md) {
  const start = md.indexOf('\n## 13. Decision log');
  const end = md.indexOf('\n## 14.', start);
  if (start < 0 || end < 0) throw new Error('build-ask-knowledge: PROJECT_BIBLE.md section 13 (Decision log) was not found');
  const chunks = [];
  for (const line of md.slice(start, end).split('\n')) {
    const m = /^\|\s*(\d+)\s*\|\s*([0-9-]+)\s*\|(.*)$/.exec(line);
    if (!m) continue;
    const cells = m[3].split('|').map((c) => c.trim());
    const decision = clean(cells[0] ?? '');
    const why = clean(cells[1] ?? '');
    if (!decision) continue;
    const text = `${decision}${why ? ` Why: ${why}` : ''}`.slice(0, MAX_ROW_CHARS);
    chunks.push({ id: `bible-13:${m[1]}`, source: 'decision-log', audience: 'manager', title: `Decision ${m[1]} (${m[2]})`, text });
  }
  return chunks;
}

export function buildKnowledge() {
  const out = [
    ...fromMarkdown(read('docs/ask-erp-manual.md'), { source: 'manual', audience: 'everyone', prefix: 'manual' }),
    ...fromMarkdown(read('docs/GLOSSARY.md'), { source: 'glossary', audience: 'everyone', prefix: 'glossary' }),
    ...fromMarkdown(read('docs/RULES.md'), { source: 'rules', audience: 'manager', prefix: 'rules' }),
    ...decisions(read('PROJECT_BIBLE.md')),
    ...fromMarkdown(read('docs/POSTING-PATTERNS.md'), { source: 'posting-patterns', audience: 'manager', prefix: 'posting', firstChunkOnly: true, skip: (h) => /^(How to read this|Posting patterns)/i.test(h) }),
  ];
  const ids = new Set();
  for (const c of out) {
    if (ids.has(c.id)) throw new Error(`build-ask-knowledge: duplicate chunk id ${c.id}`);
    ids.add(c.id);
  }
  return out;
}

export function render(chunks) {
  return `[\n${chunks.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(buildKnowledge());
  if (process.argv.includes('--check')) {
    const have = readFileSync(join(ROOT, OUTPUT), 'utf8').replace(/\r\n/g, '\n');
    if (have !== text) {
      console.error(`${OUTPUT} is out of date. Run: node scripts/build-ask-knowledge.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date.`);
  } else {
    writeFileSync(join(ROOT, OUTPUT), text, { encoding: 'utf8' });
    console.log(`${OUTPUT}: ${JSON.parse(text).length} chunks, ${Math.round(text.length / 1024)} KB`);
  }
}

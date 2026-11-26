import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildKnowledge, clean, OUTPUT, render } from '../../../../scripts/build-ask-knowledge.mjs';
import { scrubText } from '@shareat/ai';
import { searchChunks, searchKnowledge, tokenize, type KnowledgeChunk } from '../../src/ask-erp/knowledge';

/**
 * T-641 test 4: the knowledge search. The approved documents are built into one committed file (scripts/build-ask-knowledge.mjs); Ask ERP reaches it only through `searchKnowledge`.
 * ("Only approved notes" is true by construction today: the file holds the four approved sources and nothing else (the engineering rulebook is NOT one of them), and a person-written note table is deferred. When it lands, only its
 * `approved` rows may be passed as `extra`; the audience filter below is what keeps "manager" text from a person who may not read the reports.)
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const chunk = (id: string, title: string, text: string, audience: 'everyone' | 'manager' = 'everyone'): KnowledgeChunk => ({ id, source: 'test', audience, title, text });

describe('T-641 the tokenizer and the scoring', () => {
  it('folds case, accents and a plural s, and drops filler words [kills: a search that misses "A la carte" or "sales"]', () => {
    expect(tokenize('À la carte SALES, the stores')).toEqual(['la', 'carte', 'sale', 'store']);
  });

  it('the chunk that shares the question\'s rare words comes first; one that shares nothing is not returned [kills: unranked or unfiltered results]', () => {
    const docs = [
      chunk('a', 'Remittance', 'Cash kept at a store must be handed over to the office by the remittance cadence.'),
      chunk('b', 'Low stock', 'Items at or below their threshold are listed, worst shortage first.'),
      chunk('c', 'Sales days', 'Each store sales for a day is recorded and verified.'),
    ];
    const hits = searchChunks(docs, 'when is cash remittance due', { manager: false });
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(searchChunks(docs, 'zebra giraffe', { manager: false })).toEqual([]);
    expect(searchChunks(docs, '', { manager: false })).toEqual([]);
  });

  it('a title match outweighs the same word once in a body [kills: titles ignored]', () => {
    const docs = [chunk('body', 'Other', 'budget budget'), chunk('title', 'Budget caps', 'A cap only warns.')];
    expect(searchChunks(docs, 'budget caps', { manager: false })[0]?.id).toBe('title');
  });

  it('the "manager" audience is returned only when the person may read it [kills: manager text shown to everyone]', () => {
    const docs = [chunk('pub', 'Posting', 'How a sale is booked, for everyone.'), chunk('mgr', 'Posting rules', 'How a sale is booked, decision rows.', 'manager')];
    expect(searchChunks(docs, 'how a sale is booked', { manager: false }).map((h) => h.id)).toEqual(['pub']);
    expect(searchChunks(docs, 'how a sale is booked', { manager: true }).map((h) => h.id).sort()).toEqual(['mgr', 'pub']);
  });

  it('the limit holds and the order is stable [kills: an unbounded result]', () => {
    const docs = Array.from({ length: 12 }, (_, i) => chunk(`d${String(i).padStart(2, '0')}`, 'Sales', 'sales sales'));
    const hits = searchChunks(docs, 'sales', { manager: false, limit: 3 });
    expect(hits.map((h) => h.id)).toEqual(['d00', 'd01', 'd02']);
  });
});

describe('T-641 the built knowledge file', () => {
  const have = readFileSync(join(ROOT, OUTPUT), 'utf8').replace(/\r\n/g, '\n');
  const rows = JSON.parse(have) as { id: string; source: string; audience: string; title: string; text: string }[];

  it('is exactly what the build script makes from the documents today [kills: a document edited and the file not rebuilt; a hand-edited file]', () => {
    expect(have).toBe(render(buildKnowledge()));
  });

  it('holds only the four approved sources, with the audience each is meant for [kills: a new source slipped in without a review]', () => {
    const bySource = new Map<string, Set<string>>();
    for (const r of rows) (bySource.get(r.source) ?? bySource.set(r.source, new Set()).get(r.source)!).add(r.audience);
    expect(Object.fromEntries([...bySource].map(([k, v]) => [k, [...v]]))).toEqual({
      manual: ['everyone'],
      glossary: ['everyone'],
      'decision-log': ['manager'],
      'posting-patterns': ['manager'],
    });
    expect(rows.length).toBeGreaterThan(300);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('carries no network address, e-mail address or key, and no code fence [kills: a document that leaks an address into the file]', () => {
    for (const r of rows) {
      const where = `${r.id}: ${r.title}`;
      expect(r.text, where).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(r.text, where).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
      expect(r.text, where).not.toMatch(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}/);
      expect(r.text, where).not.toContain('```');
      expect(r.text.length, where).toBeLessThanOrEqual(1500);
    }
  });

  it('the cleaner drops addresses, e-mails, keys, link targets and code [kills: a cleaner that lets them through]', () => {
    const out = clean('Host 159.223.46.224 mail a@b.com key sk-abcdefghijklmnopqrstuvwx [the page](docs/x.md) ```secret code``` **bold**');
    expect(out).not.toMatch(/159\.223|a@b\.com|sk-abc|docs\/x\.md|secret code|\*\*/);
    expect(out).toContain('the page');
    expect(out).toContain('bold');
  });

  it('finds the glossary for anyone and keeps the decision log for people who may read the reports [kills: manager text served to staff; a search that cannot find the real file]', async () => {
    const forAnyone = await searchKnowledge('dineinsales', { manager: false });
    expect(forAnyone[0]?.id).toBe('glossary:dineinsales');
    expect((await searchKnowledge('what does dineinsales mean', { manager: false })).slice(0, 2).map((h) => h.id)).toContain('glossary:dineinsales');
    expect(forAnyone.every((h) => !h.id.startsWith('bible-13:')  && !h.id.startsWith('posting:'))).toBe(true);
    const forManager = await searchKnowledge('why PostgreSQL system of record decision', { manager: true });
    expect(forManager.some((h) => h.id.startsWith('bible-13:'))).toBe(true);
    const staffView = await searchKnowledge('why PostgreSQL system of record decision', { manager: false });
    expect(staffView.some((h) => h.id.startsWith('bible-13:'))).toBe(false);
  });

  it('the manual answers a how-to question for anyone [kills: an empty manual]', async () => {
    const hits = await searchKnowledge('how do I record an expense', { manager: false });
    expect(hits.slice(0, 3).map((h) => h.id)).toContain('manual:recording-an-expense');
  });

  it('extra approved notes are searched with the built ones, and a note is only found if it was handed in [kills: extra notes ignored]', async () => {
    const note: KnowledgeChunk = { id: 'note:1', source: 'note', audience: 'everyone', title: 'Wifi password policy', text: 'The staff wifi network is changed on the first of every month.' };
    expect((await searchKnowledge('staff wifi network changed', { manager: false }, [note]))[0]?.id).toBe('note:1');
    expect((await searchKnowledge('staff wifi network changed', { manager: false })).some((h) => h.id === 'note:1')).toBe(false);
  });
});

/**
 * BOSS ruling (26 Nov 2026): the knowledge base is for running the business, NOT for engineering or security internals. This list is written out here on its own (not imported from the
 * build script), so removing or weakening the script's filter turns this red rather than moving the goalposts with it.
 */
const FORBIDDEN: readonly RegExp[] = [
  /droplet/i, /\bssh\b/i, /server/i, /deploy/i, /build/i, /\bci\b/i, /secret/i, /password/i, /token/i, /key file/i, /hmac/i, /\bpins?\b/i, /rate limit/i, /credential/i, /firebase/i,
  /migration/i, /\brls\b/i, /\bdef-/i, /vulnerab/i, /exploit/i, /ip address/i, /159\.223/, /\.env/i, /superuser/i, /bypassrls/i, /artifact/i,
];
const URLISH = /(?:https?|ftp):\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|ph|dev|app|co|gov)\b/i;
const PH_MOBILE = /(?<![0-9])(?:\+?63[ -]?\(?|0\(?)?9[0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/** Why a chunk may not be in the file, or null. Pure, so a control can prove the scan itself is not blind. */
function whyForbidden(c: { id: string; title: string; text: string }): string | null {
  const text = `${c.title}
${c.text}`;
  for (const f of FORBIDDEN) if (f.test(text)) return `${c.id}: denylisted word ${f.source}`;
  if (URLISH.test(text)) return `${c.id}: a URL or host name`;
  if (EMAIL.test(text)) return `${c.id}: an e-mail address`;
  if (PH_MOBILE.test(text)) return `${c.id}: a Philippine mobile number`;
  if (Object.keys(scrubText(text).redactions).length > 0) return `${c.id}: key-, ID- or card-shaped text (${Object.keys(scrubText(text).redactions).join(', ')})`;
  return null;
}

describe('T-641 the knowledge file is business knowledge only (BOSS ruling)', () => {
  const rows = JSON.parse(readFileSync(join(ROOT, OUTPUT), 'utf8')) as { id: string; title: string; text: string }[];

  it('no chunk holds a URL, a denylisted engineering or security word, an e-mail, a Philippine mobile number or anything key-shaped [kills: removing the build filter or the URL stripper]', () => {
    const bad = rows.map(whyForbidden).filter((x): x is string => x !== null);
    expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
  });

  it('the scan itself is not blind: each kind of forbidden text is caught [kills: a scan that passes everything]', () => {
    const c = (text: string) => ({ id: 'x', title: 't', text });
    expect(whyForbidden(c('see https://claude.ai/code/abc'))).toMatch(/URL/);
    expect(whyForbidden(c('open github.com/x/y'))).toMatch(/URL/);
    expect(whyForbidden(c('the droplet was rebooted'))).toMatch(/denylisted/);
    expect(whyForbidden(c('fixed in DEF-123'))).toMatch(/denylisted/);
    expect(whyForbidden(c('mail me at a@b.example'))).not.toBeNull();
    expect(whyForbidden(c('call 0917 123 4567'))).toMatch(/mobile|key-/);
    expect(whyForbidden(c('key sk-abcdefghijklmnopqrstuvwx'))).toMatch(/key-/);
    expect(whyForbidden(c('Sales are recorded each day and verified by the manager.'))).toBeNull();
  });

  it('the engineering rulebook and the build tooling are not sources, and business decisions are still there [kills: dropping everything; keeping RULES.md]', () => {
    expect(rows.some((r) => r.id.startsWith('rules:'))).toBe(false);
    expect(rows.filter((r) => r.id.startsWith('bible-13:')).length).toBeGreaterThan(100);
    expect(rows.some((r) => r.id === 'bible-13:1')).toBe(true);
  });
});

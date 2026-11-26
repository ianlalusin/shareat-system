/**
 * T-640 - the privacy guard: EVERY payload passes through `guardChatRequest` before it leaves for a provider (the router calls it; no
 * caller can skip it). Callers are meant to send business fields only; this is the net under them.
 *
 *  - ID-shaped numbers (SSS, TIN, PhilHealth, Pag-IBIG, card and account numbers), key-shaped strings, e-mail addresses, Philippine mobile
 *    numbers and "pin / password / token = value" pairs are replaced with a marker. The marker never contains any part of what it replaced.
 *  - A JSON payload loses the fields that name a person, pay, a PIN, a credential or an image (`stripPersonalFields`).
 *  - A picture (a base64 image) is REFUSED outright: receipts and photos never go to a provider.
 *
 * ⚠️ A person's NAME typed into free text cannot be told from any other words, so it is caught by FIELD only. That is why callers send
 * business fields, not people.
 */

export class PrivacyRefusal extends Error {
  constructor() {
    super('privacy guard: a picture was in the payload');
    this.name = 'PrivacyRefusal';
  }
}

export type RedactionCounts = Record<string, number>;

const IMAGE = /data:image\/[a-z0-9.+-]+;base64,/i;

/** Order matters: the more specific shapes first, so a long number is not half-eaten by a shorter pattern. */
const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp; marker: string }> = [
  // keys and tokens
  { kind: 'key', re: /(?<![A-Za-z0-9_-])(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}/g, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /AIza[0-9A-Za-z_-]{30,}/g, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /(?<![A-Za-z0-9_-])(?:ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /(?<=Authorization\s*[:=]\s*)Basic\s+[A-Za-z0-9+/=]{8,}/gi, marker: '[KEY REMOVED]' },
  { kind: 'key', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, marker: '[KEY REMOVED]' },
  // "pin: 1234", "password = hunter2", "api key: ..." - the value goes, the word stays
  { kind: 'credential', re: /(?<![A-Za-z])((?:pin|passcode|password|passwd|pwd|secret|token|api[ _-]?key)\s*[:=]\s*)\S*[^\s.,;:!?]/gi, marker: '$1[REMOVED]' },
  // any other long unbroken mix of letters and digits that is not a UUID looks like a secret
  { kind: 'key', re: /(?<![A-Za-z0-9_-])(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, marker: '[KEY REMOVED]' },
  // contact details
  { kind: 'contact', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, marker: '[CONTACT REMOVED]' },
  { kind: 'contact', re: /(?<![0-9])(?:\+?63[ -]?\(?|0\(?)?9[0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])/g, marker: '[CONTACT REMOVED]' },
  // card and account numbers: 13 to 19 digits, spaces or dashes allowed between groups
  { kind: 'account_number', re: /(?<![0-9A-Za-z_-])(?:[0-9][ -]?){12,18}[0-9](?![0-9A-Za-z_])/g, marker: '[NUMBER REMOVED]' },
  // government IDs: grouped forms (a space, dot, slash or dash between the groups), then the same lengths run together
  { kind: 'government_id', re: /(?<![0-9])[0-9]{4}[ ./-][0-9]{4}[ ./-][0-9]{4}(?![0-9])/g, marker: '[ID REMOVED]' }, // Pag-IBIG
  { kind: 'government_id', re: /(?<![0-9])[0-9]{2}[ ./-][0-9]{9}[ ./-][0-9](?![0-9])/g, marker: '[ID REMOVED]' }, // PhilHealth
  { kind: 'government_id', re: /(?<![0-9])[0-9]{3}[ ./-][0-9]{3}[ ./-][0-9]{3}(?:[ ./-][0-9]{3,5})?(?![0-9])/g, marker: '[ID REMOVED]' }, // TIN
  { kind: 'government_id', re: /(?<![0-9])[0-9]{2}[ ./-][0-9]{7}[ ./-][0-9](?![0-9])/g, marker: '[ID REMOVED]' }, // SSS
  // 9, 10 and 12 digit runs (TIN, SSS, PhilHealth / Pag-IBIG written without dashes); a run touching a letter or hyphen is part of an identifier (a UUID), not a number
  { kind: 'government_id', re: /(?<![0-9A-Za-z_.,-])(?:[0-9]{12}|[0-9]{10}|[0-9]{9})(?![0-9A-Za-z_]|[.,][0-9])/g, marker: '[ID REMOVED]' },
];

/** Replaces everything ID-shaped or key-shaped in a string. Returns the clean text and how many of each kind it replaced. */
export function scrubText(text: string): { text: string; redactions: RedactionCounts } {
  if (IMAGE.test(text)) throw new PrivacyRefusal();
  const redactions: RedactionCounts = {};
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      redactions[p.kind] = (redactions[p.kind] ?? 0) + 1;
      // a `$1` marker keeps the credential's own word; every other marker is a plain string
      if (p.marker.includes('$1')) return p.marker.replace('$1', String(args[1] ?? ''));
      return p.marker;
    });
  }
  return { text: out, redactions };
}

/** Field names that name a person, pay, a PIN, a credential, an ID number or an image. Compared in lower case with punctuation removed. */
const PERSONAL_FIELDS: ReadonlySet<string> = new Set([
  'pin', 'passcode', 'password', 'secret', 'token', 'apikey', 'authorization', 'credential',
  'salary', 'payrate', 'wage', 'dailyrate', 'monthlyrate', 'hourlyrate', 'basicpay', 'grosspay', 'netpay', 'payslip',
  'fullname', 'firstname', 'lastname', 'middlename', 'displayname', 'legalname', 'employeename', 'personname', 'customername', 'staffname', 'cashiername',
  'phone', 'mobile', 'email', 'address', 'birthdate', 'birthday',
  'tin', 'sss', 'philhealth', 'pagibig', 'govid', 'governmentid', 'idnumber', 'accountnumber', 'cardnumber', 'bankaccount',
  'receiptimage', 'image', 'photo', 'signature', 'picture',
]);

const normalKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Replaces the value of every personal field, at any depth, with a marker. Arrays and objects are copied, never changed in place. */
export function stripPersonalFields(value: unknown, removed: { count: number } = { count: 0 }): unknown {
  if (Array.isArray(value)) return value.map((v) => stripPersonalFields(v, removed));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PERSONAL_FIELDS.has(normalKey(k))) {
        out[k] = '[REMOVED]';
        removed.count += 1;
      } else out[k] = stripPersonalFields(v, removed);
    }
    return out;
  }
  return value;
}

function cleanContent(text: string, redactions: RedactionCounts): string {
  let body = text;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const removed = { count: 0 };
      const stripped = stripPersonalFields(JSON.parse(t) as unknown, removed);
      if (removed.count > 0) {
        redactions.personal_field = (redactions.personal_field ?? 0) + removed.count;
        body = JSON.stringify(stripped);
      }
    } catch {
      // not JSON after all: the text scrub below still applies
    }
  }
  const s = scrubText(body);
  for (const [k, n] of Object.entries(s.redactions)) redactions[k] = (redactions[k] ?? 0) + n;
  return s.text;
}

/** The turns the guard cleans: text, an assistant turn with its tool calls, and the tool results (T-641). Structurally the same as `ChatMessage`, kept here so this file imports nothing. */
export type GuardedMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly args: Readonly<Record<string, unknown>>; readonly thoughtSignature?: string }[] }
  | { readonly role: 'tool'; readonly results: readonly { readonly id: string; readonly name: string; readonly content: string }[] };

/** The arguments of a tool call the model made, cleaned the way a JSON message is: personal fields stripped, then every string scrubbed. */
function cleanArgs(args: Readonly<Record<string, unknown>>, redactions: RedactionCounts): Record<string, unknown> {
  const removed = { count: 0 };
  const stripped = stripPersonalFields(args, removed);
  if (removed.count > 0) redactions.personal_field = (redactions.personal_field ?? 0) + removed.count;
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return cleanContent(v, redactions);
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(stripped) as Record<string, unknown>;
}

export interface GuardedRequest {
  readonly system?: string;
  readonly messages: readonly GuardedMessage[];
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> }[];
}

export interface GuardedResult {
  readonly system: string | undefined;
  readonly messages: GuardedMessage[];
  readonly tools: { name: string; description: string; parameters: Readonly<Record<string, unknown>> }[] | undefined;
  /** How many of each kind were replaced. Counts only: never the text that was removed. */
  readonly redactions: RedactionCounts;
}

/** The ONE function every outgoing payload passes through (the router calls it, so no caller can skip it). Returns cleaned parts; the input is not changed. */
export function guardChatRequest(req: GuardedRequest): GuardedResult {
  const redactions: RedactionCounts = {};
  const system = req.system === undefined ? undefined : cleanContent(req.system, redactions);
  // a tool RESULT is text our own code wrote from the database, and goes through exactly the same cleaning as a typed question: stripped of personal fields, then scrubbed.
  // A tool CALL's arguments are what the model chose to ask for, so they are scrubbed too (a model can be talked into echoing an ID number into an argument).
  const messages: GuardedMessage[] = req.messages.map((m): GuardedMessage => {
    if (m.role === 'tool') return { role: 'tool', results: m.results.map((r) => ({ id: r.id, name: r.name, content: cleanContent(r.content, redactions) })) };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return { role: 'assistant', content: cleanContent(m.content, redactions), toolCalls: m.toolCalls.map((c) => ({ ...c, args: cleanArgs(c.args, redactions) })) };
    }
    return { role: m.role, content: cleanContent(m.content, redactions) };
  });
  // tool names and descriptions are written by our own code, but are scrubbed all the same
  const tools = req.tools?.map((t) => ({ name: t.name, description: cleanContent(t.description, redactions), parameters: t.parameters }));
  return { system, messages, tools, redactions };
}

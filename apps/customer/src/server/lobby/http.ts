import 'server-only';
/** T-455 S3 - JSON replies and the capped body reader for the lobby routes. Every reply is private to one phone: never cached. */

export const MAX_BODY_BYTES = 16 * 1024;

export const SENTENCES = {
  counter: 'Please check in at the counter.',
  tooLarge: 'That request is too large.',
  badInput: 'Please check the name, party size and order, then try again.',
  notFound: 'We could not find that place in line.',
  unexpected: 'Something went wrong. Please check in at the counter.',
} as const;

export function json(status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

export function fail(status: number, error: string): Response {
  return json(status, { ok: false, error });
}

export class BodyTooLarge extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLarge';
  }
}

/** Reads the body with a hard cap on ACTUAL bytes (content-length is not trusted). Throws BodyTooLarge past MAX_BODY_BYTES. */
export async function readCappedText(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The JSON body as a plain object, or null when it is empty, broken, an array or not an object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const text = await readCappedText(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

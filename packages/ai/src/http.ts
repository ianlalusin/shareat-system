/**
 * T-640 - the one door to the network. Every adapter takes an `HttpClient`, so a test hands it a fake and NO real network is ever used in
 * tests. `fetchHttpClient` is the production one: a hard timeout, and no error text that could carry a key.
 */
import { AiProviderError } from './errors';

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}
export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** The largest provider reply read at all: an answer is a few kilobytes, so anything near this is wrong (or hostile) and is refused before it is parsed. */
export const MAX_REPLY_BYTES = 2 * 1024 * 1024;

/**
 * Reads a reply body with a hard size cap: a declared length over the cap is refused at once, and a stream is read in pieces and stopped (and cancelled) the moment it passes the cap,
 * so a huge or endless body never sits in memory. Over the cap is a `bad_response`.
 */
export async function readCappedBody(res: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }, maxBytes: number = MAX_REPLY_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AiProviderError('bad_response');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AiProviderError('bad_response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const fetchHttpClient: HttpClient = async (req) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    // `redirect: 'error'`: a provider never redirects an API call, and following one would send the key header to wherever it points
    const res = await fetch(req.url, { method: 'POST', headers: { ...req.headers }, body: req.body, signal: ctl.signal, redirect: 'error' });
    return { status: res.status, body: await readCappedBody(res) };
  } catch (e) {
    if (e instanceof AiProviderError) throw e;
    // Deliberately no `e.message`: nothing about the request (its headers hold the key) may reach a log.
    throw new AiProviderError(ctl.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
};

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

export const fetchHttpClient: HttpClient = async (req) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: { ...req.headers }, body: req.body, signal: ctl.signal });
    return { status: res.status, body: await res.text() };
  } catch {
    // Deliberately no `e.message`: nothing about the request (its headers hold the key) may reach a log.
    throw new AiProviderError(ctl.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
};

/**
 * T-441 - sends one file to `POST /files/upload` with `XMLHttpRequest`, because `fetch` cannot report upload progress.
 * Browser only. Words every failure the way the person should read it; aborts when the signal fires.
 *
 * The browser sets `Origin` itself (a script must not, and cannot, set it); the route checks it.
 */
export interface SentFile {
  fileId: string;
  contentType: string;
  byteSize: number;
}

/** A failed send: `reason` is for the person, `retryable` says whether sending the same file again could succeed. */
export class UploadSendError extends Error {
  readonly retryable: boolean;
  readonly aborted: boolean;
  constructor(reason: string, retryable: boolean, aborted = false) {
    super(reason);
    this.name = 'UploadSendError';
    this.retryable = retryable;
    this.aborted = aborted;
  }
}

const INTERRUPTED = 'Upload interrupted - check the connection and press Retry';
const SESSION_ENDED = 'Your session ended - sign in again, then Retry';
const UPLOAD_PATH = '/files/upload';

/**
 * `onProgress(loaded, total)`: `total` is 0 when the browser cannot measure (`lengthComputable === false`), and the
 * caller then shows "Uploading..." with no percentage.
 */
export function sendFile(
  file: File,
  purpose: string,
  storeId: string | null,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<SentFile> {
  return new Promise<SentFile>((resolve, reject) => {
    const query = new URLSearchParams({ purpose });
    if (storeId) query.set('storeId', storeId);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${UPLOAD_PATH}?${query.toString()}`);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
      else onProgress(0, 0);
    };
    xhr.onerror = () => reject(new UploadSendError(INTERRUPTED, true));
    xhr.ontimeout = () => reject(new UploadSendError(INTERRUPTED, true));
    xhr.onabort = () => reject(new UploadSendError('Upload cancelled.', false, true));
    xhr.onload = () => {
      // A redirected answer (a sign-in page) or anything that is not our JSON means the session is gone.
      let answeredByRoute = true;
      try {
        answeredByRoute = new URL(xhr.responseURL, window.location.href).pathname === UPLOAD_PATH;
      } catch {
        answeredByRoute = false;
      }
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (xhr.status === 401 || !answeredByRoute || body === null) return reject(new UploadSendError(SESSION_ENDED, true));
      if (xhr.status >= 200 && xhr.status < 300 && typeof body['fileId'] === 'string') {
        return resolve({ fileId: body['fileId'], contentType: String(body['contentType'] ?? file.type), byteSize: Number(body['byteSize'] ?? file.size) });
      }
      const message = typeof body['error'] === 'string' && body['error'] ? body['error'] : INTERRUPTED;
      // A 5xx may pass on a second try; a 4xx refusal (type, size, rights, limit) will not.
      reject(new UploadSendError(message, xhr.status >= 500));
    };

    if (signal) {
      if (signal.aborted) return reject(new UploadSendError('Upload cancelled.', false, true));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

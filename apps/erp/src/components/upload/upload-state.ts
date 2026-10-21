/**
 * T-441 - the upload control's state machine. Pure: no DOM, no timers, never mutates its input.
 *
 *   empty -> selected -> compressing -> uploading{loaded,total} -> done{fileId,preview}
 *                                              \-> failed{reason,retryable,file}  (Retry re-sends the same file)
 *   existing{fileId,kind}: a file already on the record.
 *
 * Late events (a progress / uploaded / fail from an upload that was Replaced or Removed) are ignored: they only apply while
 * the state they belong to is still current.
 */

export type ExistingFile = { fileId: string; kind: 'image' | 'pdf' };

export type UploadState =
  | { status: 'empty' }
  | { status: 'selected'; file: File }
  | { status: 'compressing'; file: File }
  | { status: 'uploading'; file: File; loaded: number; total: number }
  | { status: 'done'; fileId: string; preview: string | null; byteSize?: number }
  | { status: 'failed'; reason: string; retryable: boolean; file?: File }
  | { status: 'existing'; fileId: string; kind: 'image' | 'pdf' };

export type UploadAction =
  | { type: 'pick'; file: File }
  | { type: 'compress' }
  | { type: 'compressed'; file: File }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'uploaded'; fileId?: string | null; preview?: string | null; byteSize?: number }
  | { type: 'fail'; reason: string; retryable?: boolean }
  | { type: 'retry' }
  | { type: 'replace' }
  | { type: 'remove' }
  | { type: 'unmount' };

export function initialState(existing?: ExistingFile): UploadState {
  return existing ? { status: 'existing', fileId: existing.fileId, kind: existing.kind } : { status: 'empty' };
}

const EMPTY: UploadState = { status: 'empty' };
const NO_CONFIRMATION = 'The upload finished but was not confirmed - press Retry.';

export function reduce(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case 'pick':
      return { status: 'selected', file: action.file };
    case 'compress':
      return state.status === 'selected' ? { status: 'compressing', file: state.file } : state;
    case 'compressed':
      return state.status === 'selected' || state.status === 'compressing'
        ? { status: 'uploading', file: action.file, loaded: 0, total: action.file.size }
        : state;
    case 'progress':
      return state.status === 'uploading' ? { ...state, loaded: action.loaded, total: action.total } : state;
    case 'uploaded': {
      if (state.status !== 'uploading') return state;
      if (typeof action.fileId !== 'string' || action.fileId === '') {
        return { status: 'failed', reason: NO_CONFIRMATION, retryable: true, file: state.file };
      }
      return {
        status: 'done',
        fileId: action.fileId,
        preview: action.preview ?? null,
        ...(action.byteSize === undefined ? {} : { byteSize: action.byteSize }),
      };
    }
    case 'fail': {
      if (state.status !== 'selected' && state.status !== 'compressing' && state.status !== 'uploading') return state;
      // Only an upload can be re-sent as is; a refusal while shrinking needs a different photo.
      const retryable = state.status === 'uploading' ? (action.retryable ?? true) : false;
      return { status: 'failed', reason: action.reason, retryable, file: state.file };
    }
    case 'retry':
      return state.status === 'failed' && state.retryable && state.file
        ? { status: 'uploading', file: state.file, loaded: 0, total: state.file.size }
        : state;
    case 'replace':
    case 'remove':
      return EMPTY;
    case 'unmount':
      return state;
  }
}

/** True when this action makes work already in flight (compressing, or an XHR) stale, so the caller must abort it. */
export function shouldAbort(state: UploadState, action: UploadAction): boolean {
  const inFlight = state.status === 'compressing' || state.status === 'uploading';
  return inFlight && (action.type === 'replace' || action.type === 'remove' || action.type === 'unmount' || action.type === 'pick');
}

/**
 * 0-100, floored. While uploading it never reaches 100 - only the server's answer (`done`) does. `null` means the browser
 * cannot measure (total 0): the control shows "Uploading..." and never invents a number.
 */
export function percent(state: UploadState): number | null {
  switch (state.status) {
    case 'done':
    case 'existing':
      return 100;
    case 'uploading': {
      if (!(state.total > 0)) return null;
      const loaded = Math.min(Math.max(state.loaded, 0), state.total);
      return Math.min(99, Math.floor((loaded * 100) / state.total));
    }
    default:
      return 0;
  }
}

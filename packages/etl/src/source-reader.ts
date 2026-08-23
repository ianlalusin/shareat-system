/**
 * source-reader.ts — the read-only source interface + a fixture reader.
 * docs/tasks/112-etl-framework.md Contract §1.
 *
 * `SourceReader` declares NO write method, so none can be called — bible §11 rule 4
 * ("the ETL never mutates Firestore") is enforced by the TYPE, not by a code-review
 * promise. Anything implementing this interface is structurally incapable of writing
 * back to the source, in any language feature stronger than a comment.
 *
 * The concrete Firestore-backed reader is OUT OF SCOPE for this task — same reason
 * capture.ts (T-117) left one out: `CAPTURE_ERP_SA_KEY`, `CAPTURE_HUB_SA_KEY` and
 * `CAPTURE_SALT` are not present in this environment, so any Admin-SDK code path
 * touching them would be unexercised and unreviewable here. `FixtureReader` below is
 * what `run.ts`'s `runCapture` and this package's integration test exercise instead.
 */

export interface SourceDocument {
  /** Full path — the natural key, e.g. 'stores/ABC/journal/xyz'. */
  docPath: string;
  docId: string;
  /** 'stores/{storeId}/journal' */
  collectionPath: string;
  storeCode: string | null;
  payload: Record<string, unknown>;
}

export interface SourceReader {
  readonly sourceSystem: string;
  listCollections(): Promise<readonly string[]>;
  readDocuments(collectionPath: string): AsyncIterable<SourceDocument>;
}

/**
 * An in-memory `SourceReader` over a plain object — `capture` mode's only exercised
 * implementation in this environment. `data`'s keys ARE the collections
 * `listCollections()` reports; a collection with no entry in `data` simply does not
 * exist as far as this reader is concerned (no empty-array requirement).
 */
export class FixtureReader implements SourceReader {
  readonly sourceSystem: string;
  private readonly collections: ReadonlyMap<string, readonly SourceDocument[]>;

  constructor(sourceSystem: string, data: Readonly<Record<string, readonly SourceDocument[]>>) {
    this.sourceSystem = sourceSystem;
    this.collections = new Map(Object.entries(data));
  }

  async listCollections(): Promise<readonly string[]> {
    return [...this.collections.keys()];
  }

  async *readDocuments(collectionPath: string): AsyncIterable<SourceDocument> {
    const docs = this.collections.get(collectionPath);
    if (!docs) return;
    for (const doc of docs) {
      yield doc;
    }
  }
}

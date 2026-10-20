/** Pure screen wording shared by live hints and server refusals. No validation or I/O. */
export const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const UUID_SHAPE_GLOBAL = new RegExp(UUID_SHAPE.source, 'gi');

/** Preserve ordinary quoted amounts while hiding identifiers and making a single plain sentence. */
export function screenSentence(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim().replace(UUID_SHAPE_GLOBAL, '[hidden]');
}

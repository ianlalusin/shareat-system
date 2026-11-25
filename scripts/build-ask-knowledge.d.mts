export const OUTPUT: string;
export interface KnowledgeRow {
  id: string;
  source: string;
  audience: 'everyone' | 'manager';
  title: string;
  text: string;
}
// declared as typed constants, not function declarations: the production-caller census reads function declarations in .mts files
export const clean: (text: string) => string;
export const buildKnowledge: () => KnowledgeRow[];
export const render: (chunks: readonly KnowledgeRow[]) => string;

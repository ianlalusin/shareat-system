/**
 * Shared TypeScript-AST helpers (T-440): a source parser, a name -> function-body index, and call-chain reachability.
 * Moved (not copied) out of t440-s2-live-check-guard.test.ts for the S9 auth-first guard (G6).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export function parse(source: string, file: string) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
export const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

export type Sources = Record<string, string>;

export interface FnDef {
  file: string;
  node: ts.Node;
}
export interface Index {
  defs: Map<string, FnDef[]>;
  consts: Map<string, Map<string, string>>; // file -> const name -> initializer text (all depths, collisions joined)
}
export function buildIndex(sources: Sources): Index {
  const defs = new Map<string, FnDef[]>();
  const consts = new Map<string, Map<string, string>>();
  const add = (name: string, d: FnDef) => defs.set(name, [...(defs.get(name) ?? []), d]);
  for (const [file, src] of Object.entries(sources)) {
    const sf = parse(src, file);
    const fc = new Map<string, string>();
    consts.set(file, fc);
    const v = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) add(n.name.text, { file, node: n.body });
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) add(n.name.text, { file, node: n.initializer.body });
        fc.set(n.name.text, [fc.get(n.name.text), n.initializer.getText()].filter(Boolean).join(' '));
      }
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  return { defs, consts };
}
export function callees(n: ts.Node): Set<string> {
  const out = new Set<string>();
  const v = (x: ts.Node) => {
    if (ts.isCallExpression(x)) {
      const e = x.expression;
      if (ts.isIdentifier(e)) out.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) out.add(e.name.text);
    }
    ts.forEachChild(x, v);
  };
  v(n);
  return out;
}
export const noSpace = (s: string) => s.replace(/\s+/g, '');
export const wordRe = (w: string, tail = '') => new RegExp(`(?<![\\w$])${w.replace(/\$/g, '\\$')}${tail}(?![\\w$])`, 'g');

/** The function bodies reachable from `start` by name (union over same-named functions), depth-limited. */
export function reachable(index: Index, start: string, maxDepth = 8): FnDef[] {
  const seen = new Set<string>();
  const out: FnDef[] = [];
  let frontier = [start];
  for (let d = 0; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const def of index.defs.get(name) ?? []) {
        out.push(def);
        for (const c of callees(def.node)) if (!seen.has(c) && index.defs.has(c)) next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}

export function walk(dir: string, accept: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

export const read = (f: string) => readFileSync(f, 'utf8');
export const toSources = (files: string[], k: (f: string) => string): Sources => Object.fromEntries(files.map((f) => [k(f), read(f)]));


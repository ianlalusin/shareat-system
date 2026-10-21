/**
 * control-source.ts - T-440. Source-text tests read a form's JSX as text. T-440 moved a control's `name`, `required`,
 * `maxLength` and `inputMode` into its rule (`{...nativeAttrs(SET.field)}`) and the `<form>` into `<CheckedForm rules= action=>`.
 * `resolveControlSource` puts the attributes back, computed from the REAL rule set (so it cannot drift), and treats
 * `<CheckedForm ... action={X}>` as `<form action={X}>`. A test that scans for `name="x"` or `<form action=` then keeps meaning
 * what it meant.
 */
import { readFileSync } from 'node:fs';
import * as fieldRules from '@shareat/domain/field-rules';

type Rule = Parameters<typeof fieldRules.nativeAttrs>[0];

/** The JSX attribute text `nativeAttrs(rule)` stands for, e.g. `name="sss" required maxLength={10} inputMode="numeric"`. */
export function nativeAttrsText(rule: Rule): string {
  const a = fieldRules.nativeAttrs(rule);
  const parts = [`name="${a.name}"`];
  if (a.required === true) parts.push('required');
  if (a.maxLength !== undefined) parts.push(`maxLength={${String(a.maxLength)}}`);
  if (a.inputMode !== undefined) parts.push(`inputMode="${String(a.inputMode)}"`);
  return parts.join(' ');
}

const SPREAD = /\{\.\.\.nativeAttrs\(\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\)\}/g;

export function resolveControlSource(src: string): string {
  const sets = fieldRules as unknown as Record<string, Record<string, Rule> | undefined>;
  return src
    .replace(SPREAD, (whole, set: string, field: string, offset: number) => {
      const rule = sets[set]?.[field];
      if (!rule) throw new Error(`control-source: no rule ${set}.${field} to resolve ${whole}`);
      let text = nativeAttrsText(rule);
      // A control that spreads the rule AND states its own `name=` (a computed or overriding name) keeps only the explicit one.
      const rest = src.slice(offset + whole.length);
      const tail = rest.slice(0, rest.search(/\/>|<\//) >= 0 ? rest.search(/\/>|<\//) : rest.length);
      if (/\sname=/.test(tail)) text = text.replace(/^name="[^"]*"\s*/, '');
      return text;
    })
    .replace(/<CheckedForm\s+rules=\{[^}]*\}/g, '<form')
    .replace(/<CheckedForm(?=[\s>])/g, '<form')
    .replace(/<\/CheckedForm>/g, '</form>');
}

/** Read a source file and resolve its rule-driven controls. */
export function readControlSource(path: string, _encoding?: string): string {
  return resolveControlSource(readFileSync(path, 'utf8'));
}

/**
 * T-262 / DEF-269 — authored-box-geometry resolver for interactive controls under `apps/erp/src`.
 *
 * Replaces the old text-matcher (`text-xs` + bare `underline`) with a model of the actual box
 * height WCAG 2.5.8 cares about. The governing line (bible, this task's spec §6.1): a source
 * scanner may assert what the author WROTE; never what the browser COMPUTES. Font-size is the one
 * computed property this resolver approximates (via authored JSX ancestry), and it fails closed —
 * UNRESOLVED, which the caller must treat as FAIL — the moment that approximation runs out.
 *
 * Definitions stated explicitly here because the spec deliberately leaves them to the implementer
 * (§6.3's own "state your own opaque-set" instruction, applied to the two places below that are
 * genuinely judgment calls rather than mechanical steps):
 *
 * 1. INTERACTIVE CONTROL — a JSX element is a candidate iff:
 *    (a) its tag is one of the native "always interactive" tags: a, button, input (excluding
 *        type="hidden"), select, textarea, summary; or
 *    (b) its tag is `Link` (next/link) — transparent, renders a plain `<a>` (§6.3's own corrected
 *        lesson: capitalised is not the same as opaque); or
 *    (c) it is a native (lowercase) tag not in (a) carrying an `onClick` attribute — the scrim-div
 *        pattern (`components/shell/Sidebar.tsx`'s backdrop): a click target the browser does not
 *        already know is one.
 *    checkbox/radio `<input>` are candidates too (rule (a)) but are ALWAYS unresolved — Ian's
 *    ruling, §6.1: their box is intrinsic (~13px in Chrome) and does not scale with font size, so
 *    no source scanner can ever resolve it.
 *
 * 2. OPAQUE COMPONENT ALLOWLIST — capitalised custom components whose own source (read directly,
 *    not guessed) renders a real interactive control whose box cannot be seen from the call site.
 *    Kept as a small, explicit, auditable list — the same convention as `TARGET_FILES` below —
 *    rather than a generic "any component with an onXxx prop" heuristic, which would sweep in
 *    every callback-accepting wrapper component in the tree (modals, forms, providers) with no
 *    relationship to touch targets. Each entry needs its own justification, visible in a diff:
 *      - `TokenReveal` (`app/attendance/terminals/TokenReveal.tsx`) — renders its own `<button>`
 *        and `<textarea>` from a `BTN` constant and inline classes not visible at the call site.
 *      - `SidebarNav` (`components/shell/SidebarNav.tsx`) — renders `shell-nav-row` buttons/links
 *        internally; the call site passes only behavioural props (`isRailNow`, `onLinkClick`).
 *    Every JSX usage site of a listed name is one UNRESOLVED candidate. This resolver does NOT
 *    deduplicate multiple usage sites of the same opaque component (e.g. SidebarNav is used once
 *    for the persistent desktop sidebar and once for the mobile drawer) — each call site is a
 *    distinct authored element and is reported separately. If the original census counted these
 *    as one, that is a difference to report, not a bug to silently match.
 *
 * CONFIRMED BASELINE (orchestrator, T-262 review round) — UNRESOLVED is 53, not the spec's original
 * 78; 53 is the correct figure and 78 was an artefact of a weaker resolver that could not see
 * function-scoped consts or string concatenation. §6.10's falsifier (a materially LOWER UNRESOLVED
 * count is the dangerous direction — something that used to be loud going silent) fired correctly:
 * it pointed at exactly the right 42 controls, and rendered measurement (not argument) cleared them.
 * The orchestrator measured 27 of the 42 in the running app at 1280 across the 5 affected routes
 * (`/inventory/deliveries`, `/inventory/usage`, `/trade/orders`, `/inventory/transfers`,
 * `/attendance`) with `~/.claude/skills/orchestrator/tools/smoke-t262-verdict.mjs`: zero of 27
 * rendered below 24px (histogram 35×1, 36×2, 38×11, 39×11, 40×2). The remaining 15 sit behind
 * unopened "New …" form toggles but share the same two conventions as the 27 measured, so the
 * verdict generalises to all 42. This resolver's modelled heights (34px/38px) under-estimate the
 * rendered values by 1-5px (e.g. 34 modelled vs 35-39 rendered) — a KNOWN BIAS, not a bug: it errs
 * toward flagging a borderline control rather than missing one, the safe direction for a floor
 * check, but worth knowing rather than rediscovering. The gap the falsifier predicted turned out to
 * be exactly 42 controls that resolve to PASS only because of two fixes made while building this
 * resolver against real source (both real, both needed to satisfy §6.7(b)'s ACTION_LINK requirement
 * / the repo's own existing const conventions — see `findLocalConst` and the `PlusToken` branch of
 * `resolveExpr` above):
 *
 *   Fix 1 (lexical-scope `const` resolution, not just module-top-level) accounts for 36 of the 42:
 *     - `app/inventory/deliveries/NewDeliveryForm.tsx` — 10 controls, all `<select>`/`<input>`,
 *       resolve through the function-scoped `const field = '...px-2 py-2 text-sm...'` → 38px.
 *     - `app/inventory/usage/NewUsageForm.tsx` — 7 controls, same `field` convention → 38px.
 *     - `app/trade/orders/NewOrderForm.tsx` — 10 controls, same `field` convention → 38px.
 *     - `app/inventory/transfers/NewTransferForm.tsx` — 4 controls, function-scoped
 *       `const fieldSelect = '...px-2 py-1.5 text-sm...'` (one used via a template substitution,
 *       `` `${fieldSelect} tabular-nums` ``) → 34px.
 *     - `app/attendance/page.tsx` — 3 controls (lines 89, 99, 103), function-scoped
 *       `const FIELD = '...px-2 py-1.5 text-sm...'` referenced via template substitution
 *       (`` `${FIELD} w-52` `` etc.) → 34px.
 *   Fix 2 (`className={CONST + ' literal'}` string concatenation) accounts for the remaining 6, all
 *   in `app/attendance/[dayId]/page.tsx` (lines 253, 289, 324, 359, 366, 406) — `FIELD` there is
 *   already module-top-level (fix 1 does not apply), but every usage is `FIELD + ' w-28'` /
 *   `FIELD + ' w-full'` — a binary expression, not a bare identifier or a template. → 34px.
 *
 * Every one of the 42 is a form `<select>`/`<input>` styled through one of exactly two repo-wide
 * conventions (`px-2 py-1.5|2 text-sm` + a `border`), landing at 34px or 38px — comfortably above
 * the 24px floor, and none is a checkbox/radio, a foreign component, or an ancestry-truncated case.
 * Both fixes were verified independently before this was written: temporarily reverting each and
 * re-running the census reproduces the pre-fix 95/59/53 UNRESOLVED sequence exactly, and the
 * intersection of (current PASS) ∩ (UNRESOLVED with both fixes reverted) is precisely these 42 —
 * none of the 42 land in FAIL under either resolver version, and FAIL stayed 151/151/151 throughout
 * all three states.
 *
 * CONFIRMED UNRESOLVED BASELINE — 53, adjudicated by rendered measurement, not by argument:
 * 35 checkbox/radio · 10 ancestry-truncated · 4 foreign-component · 3 className-unresolvable ·
 * 1 UA-padding. Do not tune the resolver toward the old 78 — that number is being retired in the
 * spec doc (`docs/tasks/262-*.md`, the orchestrator's to edit, not this file's).
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

export const FLOOR_PX = 24;

const NATIVE_ALWAYS_INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const OPAQUE_COMPONENTS = new Set(['TokenReveal', 'SidebarNav']);

// Deliberately NOT typed `Record<string, number>` — a generic string index defeats
// `noUncheckedIndexedAccess`'s point (every read becomes `number | undefined` again). Left to
// infer, `keyof typeof FONT_SIZE_PX` etc. are the literal key union, so a value already narrowed
// to that union (e.g. `bareFontSize`'s return type) indexes as a plain `number`.
const FONT_SIZE_PX = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
};

const LINE_HEIGHT_PX = {
  xs: 16,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 28,
  '2xl': 32,
  '3xl': 36,
};

const LEADING_MULTIPLIER = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

// UA-default-padding tags: a box computed as lineHeight-only for these would assert a number the
// browser does not actually render (the UA stylesheet adds padding this resolver cannot see) —
// §6.3's "3: input/select/textarea with no authored padding" bucket. `button` deliberately excluded
// — the spec's own classification scopes this carve-out to these three tags only.
const UA_PADDING_TAGS = new Set(['input', 'select', 'textarea']);

export type ControlResult =
  | { file: string; line: number; tag: string; status: 'pass'; px: number }
  | { file: string; line: number; tag: string; status: 'fail'; px: number }
  | { file: string; line: number; tag: string; status: 'unresolved'; reason: string };

function spacingToPx(token: string): number | undefined {
  if (token === 'px') return 1;
  const n = Number(token);
  if (Number.isNaN(n)) return undefined;
  return n * 4;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// globals.css — Step 2b. Only `.class { ... min-height: Npx ... }` rules are relevant; the smallest
// authored value wins per class (a media query narrows further, never widens, per §6.2's "assert
// the smallest authored height").
// ---------------------------------------------------------------------------------------------
function parseCssMinHeights(cssPath: string): Map<string, number> {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const result = new Map<string, number>();
  // Matches `.name { ... }` blocks (no nested braces in this file's rules — verified: every block
  // under globals.css is a flat declaration list, no CSS nesting used).
  const ruleRe = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(ruleRe)) {
    const [, className, body] = m;
    if (className === undefined || body === undefined) continue;
    const heightMatch = body.match(/min-height\s*:\s*([\d.]+)px/);
    const value = heightMatch?.[1];
    if (value === undefined) continue;
    const px = Number(value);
    const prev = result.get(className);
    if (prev === undefined || px < prev) result.set(className, px);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Cross-file `const NAME = '<string>'` map (§6.2 step 1, shape 3) and import resolution.
// ---------------------------------------------------------------------------------------------
interface FileInfo {
  path: string;
  sourceFile: ts.SourceFile;
  imports: Map<string, { file: string; exportedName: string }>; // local name -> origin
}

function resolveModuleSpecifier(fromFile: string, specifier: string, srcRoot: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(srcRoot, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return undefined; // bare/package specifier — not one of our own files
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not this candidate
    }
  }
  return undefined;
}

function stringLiteralValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function buildFileInfos(files: string[], srcRoot: string): Map<string, FileInfo> {
  const infos = new Map<string, FileInfo>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Map<string, { file: string; exportedName: string }>();

    for (const node of sourceFile.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveModuleSpecifier(file, node.moduleSpecifier.text, srcRoot);
        if (resolved && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const el of node.importClause.namedBindings.elements) {
            const exportedName = (el.propertyName ?? el.name).text;
            imports.set(el.name.text, { file: resolved, exportedName });
          }
        }
      }
    }
    infos.set(file, { path: file, sourceFile, imports });
  }
  return infos;
}

/** Find `const NAME = '<string>'` by walking UP the real lexical scope chain from a usage site —
 *  not a flat per-file map. `field`/`label`-style helpers (the existing repo convention this task's
 *  spec calls out) are almost always declared inside the component function body, not at module
 *  level; a flat top-level-only map misses every one of them, and a flat *whole-file* map risks
 *  resolving to the wrong same-named local from a sibling function. Blocks and the source file are
 *  the only scopes that matter here — JSX only appears inside function bodies / arrow bodies, both
 *  of which are `ts.Block`s (or the file itself for a rare top-level const). */
function findLocalConst(startNode: ts.Node, name: string): string | undefined {
  let current: ts.Node | undefined = startNode;
  while (current) {
    const statements = ts.isSourceFile(current) || ts.isBlock(current) ? current.statements : undefined;
    if (statements) {
      for (const stmt of statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
            const value = stringLiteralValue(decl.initializer);
            if (value !== undefined) return value;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** Resolve an identifier's string value: nearest enclosing lexical scope in its own file, else
 *  follow an import binding one hop into the target file's module scope (files in this tree
 *  re-export constants directly; no need to chase re-export chains further). */
function resolveIdentifierValue(
  identifier: ts.Identifier,
  info: FileInfo,
  infos: Map<string, FileInfo>,
): string | undefined {
  const own = findLocalConst(identifier, identifier.text);
  if (own !== undefined) return own;
  const imp = info.imports.get(identifier.text);
  if (!imp) return undefined;
  const target = infos.get(imp.file);
  if (!target) return undefined;
  return findLocalConst(target.sourceFile, imp.exportedName);
}

// ---------------------------------------------------------------------------------------------
// className resolution (§6.2 step 1) — returns the resolved class-string(s) to run the geometry
// model over, or `undefined` if any required part could not be resolved.
//
// Templates: the spec's literal wording ("concatenate literal spans") would silently drop a
// `${CONST}` substitution — and 5 of the 8 known ACTION_LINK sites use exactly that shape
// (`` `${ACTION_LINK} text-neutral-500 ...` ``). Each substitution is therefore resolved with the
// same rules as a bare identifier/conditional (recursively), and only an unresolvable substitution
// makes the whole className unresolved — necessary to satisfy §6.7(b)'s own requirement that the
// resolver positively identify all 8 ACTION_LINK sites.
// ---------------------------------------------------------------------------------------------
function resolveExpr(expr: ts.Expression, info: FileInfo, infos: Map<string, FileInfo>): string | undefined {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text;
    for (const span of expr.templateSpans) {
      const sub = resolveExpr(span.expression, info, infos);
      if (sub === undefined) return undefined;
      out += sub + span.literal.text;
    }
    return out;
  }
  if (ts.isIdentifier(expr)) return resolveIdentifierValue(expr, info, infos);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // A fifth shape the spec's four don't name: `className={CONST + ' extra-class'}` — plain
    // string concatenation, seen in practice (`FIELD + ' w-32'`). Same fail-closed rule as the
    // conditional shape: resolve both operands or the whole className is unresolved.
    const left = resolveExpr(expr.left, info, infos);
    const right = resolveExpr(expr.right, info, infos);
    if (left === undefined || right === undefined) return undefined;
    return left + right;
  }
  if (ts.isConditionalExpression(expr)) {
    const whenTrue = resolveExpr(expr.whenTrue, info, infos);
    const whenFalse = resolveExpr(expr.whenFalse, info, infos);
    if (whenTrue === undefined || whenFalse === undefined) return undefined;
    return `${whenTrue} ${whenFalse}`;
  }
  if (ts.isParenthesizedExpression(expr)) return resolveExpr(expr.expression, info, infos);
  return undefined;
}

function resolveClassName(
  attrs: ts.JsxAttributes,
  info: FileInfo,
  infos: Map<string, FileInfo>,
): { ok: true; value: string } | { ok: false } {
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'className') continue;
    if (!attr.initializer) return { ok: false };
    if (ts.isStringLiteral(attr.initializer)) return { ok: true, value: attr.initializer.text };
    if (ts.isJsxExpression(attr.initializer)) {
      if (!attr.initializer.expression) return { ok: false };
      const value = resolveExpr(attr.initializer.expression, info, infos);
      return value === undefined ? { ok: false } : { ok: true, value };
    }
    return { ok: false };
  }
  return { ok: true, value: '' }; // no className attribute at all — a known, definite fact
}

function getAttrStringValue(attrs: ts.JsxAttributes, name: string): string | undefined {
  for (const attr of attrs.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === name) {
      if (!attr.initializer) return undefined;
      if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
      return undefined; // dynamic type=... — not resolvable; handled by caller
    }
  }
  return undefined;
}

function hasAttr(attrs: ts.JsxAttributes, name: string): boolean {
  return attrs.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
}

// ---------------------------------------------------------------------------------------------
// Geometry model (§6.2 steps 2-3).
// ---------------------------------------------------------------------------------------------
const SIZE_TOKEN_RE = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/;

function bareFontSize(tokens: string[]): keyof typeof FONT_SIZE_PX | undefined {
  for (const t of tokens) {
    const m = SIZE_TOKEN_RE.exec(t);
    if (m) return m[1] as keyof typeof FONT_SIZE_PX;
  }
  return undefined;
}

function explicitHeightPx(tokens: string[], cssMinHeights: Map<string, number>): number | undefined {
  let best: number | undefined;
  for (const t of tokens) {
    if (t.includes(':')) continue; // variant-prefixed — conditional, not the base box
    const arbitrary = /^(?:h|min-h)-\[(\d+(?:\.\d+)?)px\]$/.exec(t);
    if (arbitrary) {
      const px = Number(arbitrary[1]);
      best = best === undefined ? px : Math.min(best, px);
      continue;
    }
    const scaled = /^(?:h|min-h)-([\d.]+|px)$/.exec(t);
    if (scaled) {
      // Capture group is not optional in the pattern — always present when `scaled` is non-null.
      const px = spacingToPx(scaled[1]!);
      if (px !== undefined) best = best === undefined ? px : Math.min(best, px);
      continue;
    }
    const cssPx = cssMinHeights.get(t);
    if (cssPx !== undefined) best = best === undefined ? cssPx : Math.min(best, cssPx);
  }
  return best;
}

function padYTotalPx(tokens: string[]): number {
  let top: number | undefined;
  let bottom: number | undefined;
  for (const t of tokens) {
    if (t.includes(':')) continue;
    let m = /^(?:p|py)-([\d.]+|px)$/.exec(t);
    if (m) {
      const px = spacingToPx(m[1]!) ?? 0;
      top = px;
      bottom = px;
      continue;
    }
    m = /^pt-([\d.]+|px)$/.exec(t);
    if (m) top = spacingToPx(m[1]!) ?? top;
    m = /^pb-([\d.]+|px)$/.exec(t);
    if (m) bottom = spacingToPx(m[1]!) ?? bottom;
  }
  return (top ?? 0) + (bottom ?? 0);
}

function borderTotalPx(tokens: string[]): number {
  let top: number | undefined;
  let bottom: number | undefined;
  const set = new Set(tokens);
  if (set.has('border')) {
    top = 1;
    bottom = 1;
  }
  for (const t of tokens) {
    if (t.includes(':')) continue;
    let m = /^border-(\d+)$/.exec(t);
    if (m) {
      top = Number(m[1]);
      bottom = Number(m[1]);
    }
    m = /^border-[xy]-(\d+)$/.exec(t);
    if (m) {
      top = Number(m[1]);
      bottom = Number(m[1]);
    }
    if (t === 'border-y' || t === 'border-x') {
      top = 1;
      bottom = 1;
    }
    m = /^border-t(?:-(\d+))?$/.exec(t);
    if (m) top = m[1] ? Number(m[1]) : 1;
    m = /^border-b(?:-(\d+))?$/.exec(t);
    if (m) bottom = m[1] ? Number(m[1]) : 1;
  }
  return (top ?? 0) + (bottom ?? 0);
}

function leadingLineHeightPx(tokens: string[], fontSize: keyof typeof FONT_SIZE_PX): number {
  for (const t of tokens) {
    if (t.includes(':')) continue;
    const abs = /^leading-(\d+)$/.exec(t);
    if (abs) return Number(abs[1]!) * 4;
    const named = /^leading-(none|tight|snug|normal|relaxed|loose)$/.exec(t);
    if (named) {
      const key = named[1] as keyof typeof LEADING_MULTIPLIER;
      return FONT_SIZE_PX[fontSize] * LEADING_MULTIPLIER[key];
    }
  }
  return LINE_HEIGHT_PX[fontSize];
}

interface AncestorFontSizeResult {
  size?: keyof typeof FONT_SIZE_PX;
  unresolvedReason?: string;
}

function resolveAncestorFontSize(
  node: ts.Node,
  info: FileInfo,
  infos: Map<string, FileInfo>,
): AncestorFontSizeResult {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    let attrs: ts.JsxAttributes | undefined;
    if (ts.isJsxElement(current)) attrs = current.openingElement.attributes;
    else if (ts.isJsxSelfClosingElement(current)) attrs = current.attributes;

    if (attrs) {
      const resolved = resolveClassName(attrs, info, infos);
      if (!resolved.ok) {
        return { unresolvedReason: 'an ancestor className could not be resolved statically' };
      }
      const size = bareFontSize(resolved.value.split(/\s+/).filter(Boolean));
      if (size) return { size };
    }
    current = current.parent;
  }
  return { unresolvedReason: 'ancestry truncated — no font size resolvable' };
}

function computeControl(
  tag: string,
  attrs: ts.JsxAttributes,
  node: ts.Node,
  info: FileInfo,
  infos: Map<string, FileInfo>,
  cssMinHeights: Map<string, number>,
): { status: 'pass' | 'fail'; px: number } | { status: 'unresolved'; reason: string } {
  // Ian's ruling, §6.1: intrinsic checkbox/radio boxes never scale with font size — permanently
  // unresolvable from source, by construction, regardless of any class present.
  if (tag === 'input') {
    const type = getAttrStringValue(attrs, 'type');
    if (type === 'checkbox' || type === 'radio') {
      return { status: 'unresolved', reason: 'intrinsic checkbox/radio box, independent of font size — not resolvable from source (Ian’s ruling, §6.1)' };
    }
  }

  const own = resolveClassName(attrs, info, infos);
  if (!own.ok) {
    return { status: 'unresolved', reason: 'className could not be resolved statically (dynamic expression outside the known shapes)' };
  }
  const ownTokens = own.value.split(/\s+/).filter(Boolean);

  const explicit = explicitHeightPx(ownTokens, cssMinHeights);
  if (explicit !== undefined) {
    return explicit >= FLOOR_PX ? { status: 'pass', px: explicit } : { status: 'fail', px: explicit };
  }

  const ownFontSize = bareFontSize(ownTokens);
  let fontSize: keyof typeof FONT_SIZE_PX | undefined = ownFontSize;
  if (!fontSize) {
    const ancestor = resolveAncestorFontSize(node, info, infos);
    if (!ancestor.size) {
      return { status: 'unresolved', reason: ancestor.unresolvedReason ?? 'font size not resolvable' };
    }
    fontSize = ancestor.size;
  }

  const padY = padYTotalPx(ownTokens);
  if (UA_PADDING_TAGS.has(tag) && padY === 0) {
    return {
      status: 'unresolved',
      reason: 'UA stylesheet supplies default padding on this control; not visible from source',
    };
  }

  const lineHeight = leadingLineHeightPx(ownTokens, fontSize);
  const border = borderTotalPx(ownTokens);
  const px = lineHeight + padY + border;
  return px >= FLOOR_PX ? { status: 'pass', px } : { status: 'fail', px };
}

// ---------------------------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------------------------
function tagNameOf(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const nameNode = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return nameNode.getText();
}

export function stylesheetsUnderApp(appRoot: string): string[] {
  const found: string[] = [];
  const rec = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) rec(p);
      else if (extname(entry) === '.css') found.push(p);
    }
  };
  rec(appRoot);
  return found;
}

export function runCensus(srcRoot: string, globalsCssPath: string): { files: string[]; results: ControlResult[] } {
  const files = walk(srcRoot);
  const infos = buildFileInfos(files, srcRoot);
  const cssMinHeights = parseCssMinHeights(globalsCssPath);
  const results: ControlResult[] = [];

  for (const file of files) {
    const info = infos.get(file)!;
    const relFile = file.slice(srcRoot.length).replace(/\\/g, '/').replace(/^\//, '');

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagNameOf(node);
        const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
        const line = info.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

        const isNative = NATIVE_ALWAYS_INTERACTIVE.has(tag);
        const isLink = tag === 'Link';
        const isOnClickDiv = !isNative && !isLink && /^[a-z]/.test(tag) && hasAttr(attrs, 'onClick');
        const isOpaque = OPAQUE_COMPONENTS.has(tag);

        if (isNative && tag === 'input' && getAttrStringValue(attrs, 'type') === 'hidden') {
          // not a candidate — never rendered/tappable
        } else if (isOpaque) {
          results.push({
            file: relFile,
            line,
            tag,
            status: 'unresolved',
            reason: 'foreign component — box decided inside the component',
          });
        } else if (isNative || isLink || isOnClickDiv) {
          const outcome = computeControl(isLink ? 'a' : tag, attrs, node, info, infos, cssMinHeights);
          if (outcome.status === 'unresolved') {
            results.push({ file: relFile, line, tag, status: 'unresolved', reason: outcome.reason });
          } else {
            results.push({ file: relFile, line, tag, status: outcome.status, px: outcome.px });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.sourceFile);
  }

  return { files, results };
}

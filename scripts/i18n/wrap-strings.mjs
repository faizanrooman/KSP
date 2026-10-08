#!/usr/bin/env node
/**
 * i18n codemod + key extractor for apps/web (tender §45).
 *
 *   node scripts/i18n/wrap-strings.mjs            # rewrite files in place + write src/i18n/keys.json
 *   node scripts/i18n/wrap-strings.mjs --check    # only extract keys / report unwrapped strings (CI guard)
 *
 * Wraps user-visible string literals in `t('…')` using the TypeScript AST:
 *   - JSX text nodes (whitespace-normalised the way JSX renders them)
 *   - JSX attributes: label, placeholder, title, aria-label, hint, emptyLabel, confirmLabel, subtitle, description,
 *     reasonLabel, caption, alt, message, empty
 *   - object-literal properties with those names inside functions that render JSX (components), e.g. table columns
 *   - string arguments of toast.success/error/info(...) and confirm/alert-style helpers inside components
 * Strings without letters, already-wrapped strings, test files and the i18n module itself are skipped. Rendering
 * code paths that receive English from data (DataTable headers, nav labels, status badges) translate centrally.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../apps/web/src/', import.meta.url));
const CHECK = process.argv.includes('--check');
const ATTRS = new Set(['label', 'placeholder', 'title', 'aria-label', 'hint', 'emptyLabel', 'confirmLabel', 'subtitle', 'description', 'reasonLabel', 'caption', 'alt', 'message', 'empty', 'nativeLabel']);
const PROPS = new Set(['header', 'label', 'title', 'hint', 'description', 'subtitle', 'placeholder', 'emptyLabel', 'confirmLabel', 'message', 'summary', 'name']);
const TOAST_FNS = new Set(['success', 'error', 'info', 'warning']);
// Props that look like text but are data-field names on chart components.
const DATA_KEY_PROPS = new Set(['CategoryBars.label', 'CategoryBars.value', 'TimeBars.label', 'TimeBars.value', 'ThresholdMeter.label', 'ThresholdMeter.value']);
const SKIP_FILES = /(\.test\.tsx?$|\/lib\/i18n\.tsx$|\/i18n\/|\/test-setup\.ts$)/;
const EXTRA_KEYS_FILE = join(ROOT, 'i18n', 'extra-keys.json');

const keys = new Set();
const report = [];

function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (/\.tsx$/.test(p) && !SKIP_FILES.test(p)) out.push(p);
  }
  return out;
}

function renderJsxText(raw) {
  // Mirror JSX whitespace rules: lines are trimmed; whitespace runs containing a newline collapse to one space or
  // vanish at the ends.
  if (!raw.includes('\n')) return raw;
  const lines = raw.split('\n').map((l, i, arr) => (i === 0 ? l.replace(/\s+$/, '') : i === arr.length - 1 ? l.replace(/^\s+/, '') : l.trim()));
  return lines.filter((l, i) => l.length > 0 || (i !== 0 && i !== lines.length - 1)).join(' ').replace(/\s+/g, ' ').trim();
}

const hasLetters = (s) => /[A-Za-z]{2,}/.test(s);
const isJsxLike = (s) => /^[\s\d.,:;()\-–—/·•|%#]+$/.test(s);

function escapeForSingleQuotes(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function functionHasJsx(fn) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

function enclosingComponent(node) {
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return functionHasJsx(n) ? n : null;
    n = n.parent;
  }
  return null;
}

function isAlreadyWrapped(node) {
  const p = node.parent;
  return p && ts.isCallExpression(p) && p.expression.getText() === 't';
}

function processFile(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; // {start, end, text}
  let touched = false;
  // A file that declares its own `t` (e.g. `tabs.map((t) => …)`) gets the translator under the alias `tr`.
  let shadowsT = false;
  const scanDecl = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === 't') shadowsT = true;
    if (!shadowsT) ts.forEachChild(n, scanDecl);
  };
  scanDecl(sf);
  const FN = shadowsT ? 'tr' : 't';

  const addKey = (k) => keys.add(k);
  const wrapLiteral = (lit, { asExpression }) => {
    const value = lit.text;
    if (!hasLetters(value) || isJsxLike(value)) return;
    if (isAlreadyWrapped(lit)) return;
    addKey(value);
    const call = `${FN}('${escapeForSingleQuotes(value)}')`;
    edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: asExpression ? `{${call}}` : call });
    touched = true;
  };

  const visit = (node) => {
    // 0. already-translated strings count as keys too (the extractor must be idempotent)
    if (ts.isCallExpression(node) && (node.expression.getText() === 't' || node.expression.getText() === 'tr') && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
      addKey(node.arguments[0].text);
    }
    // 1. JSX text
    if (ts.isJsxText(node)) {
      const rendered = renderJsxText(node.text);
      if (rendered && hasLetters(rendered) && !isJsxLike(rendered)) {
        addKey(rendered);
        const raw = node.getFullText(sf);
        // Preserve surrounding whitespace that JSX keeps (a single leading/trailing space on single-line text).
        // A space that touches an adjacent expression on the same line is significant ("All {n} events"): keep it
        // as {' '} whether or not the text also spans lines; whitespace runs containing a newline are dropped by JSX.
        const leadWs = raw.match(/^\s*/)[0];
        const trailWs = raw.match(/\s*$/)[0];
        const lead = leadWs.length && !leadWs.includes('\n') ? "{' '}" : '';
        const trail = trailWs.length && !trailWs.includes('\n') ? "{' '}" : '';
        const start = node.getFullStart();
        const end = node.getEnd();
        // keep newline/indent structure for multi-line text so formatting stays stable
        const text = raw.includes('\n') ? raw.replace(rendered.split(' ')[0] ? raw.trim() : raw, '') : '';
        const indentMatch = raw.match(/^(\s*\n\s*)/);
        const prefix = indentMatch ? indentMatch[1] : '';
        const suffixMatch = raw.match(/(\s*\n\s*)$/);
        const suffix = suffixMatch ? suffixMatch[1] : '';
        edits.push({ start, end, text: `${prefix}${lead}{${FN}('${escapeForSingleQuotes(rendered.trim())}')}${trail}${suffix}` });
        void text;
        touched = true;
      }
      return;
    }
    // 2. JSX attributes
    if (ts.isJsxAttribute(node) && node.initializer && ATTRS.has(node.name.getText())) {
      const owner = node.parent?.parent; // JsxAttributes -> JsxOpeningElement/JsxSelfClosingElement
      const tag = owner && (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) ? owner.tagName.getText() : '';
      if (DATA_KEY_PROPS.has(`${tag}.${node.name.getText()}`)) return;
      const init = node.initializer;
      if (ts.isStringLiteral(init)) wrapLiteral(init, { asExpression: true });
      else if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) {
        wrapLiteral(init.expression, { asExpression: false });
      }
      ts.forEachChild(node, visit);
      return;
    }
    // 3. object properties inside components
    if (ts.isPropertyAssignment(node) && PROPS.has(node.name.getText()) && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      if (enclosingComponent(node)) wrapLiteral(node.initializer, { asExpression: false });
      ts.forEachChild(node, visit);
      return;
    }
    // 4. toast.x('…') calls inside components
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && TOAST_FNS.has(node.expression.name.getText()) && /toast$/i.test(node.expression.expression.getText())) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && enclosingComponent(node)) wrapLiteral(arg, { asExpression: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!touched) return;
  if (CHECK) {
    report.push(`${relative(ROOT, file)}: ${edits.length} unwrapped string(s)`);
    return;
  }
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  const spec = shadowsT ? 't as tr' : 't';
  const hasSpec = shadowsT ? /import \{[^}]*\bt as tr\b[^}]*\} from '@\/lib\/i18n'/.test(out) : /import \{[^}]*(^|[,{\s])t([,}\s]|$)[^}]*\} from '@\/lib\/i18n'/.test(out);
  if (!hasSpec) {
    if (/from '@\/lib\/i18n';/.test(out)) {
      out = out.replace(/import \{([^}]*)\} from '@\/lib\/i18n';/, (m, inner) => `import { ${inner.trim().replace(/,\s*$/, '')}${inner.trim() ? ', ' : ''}${spec} } from '@/lib/i18n';`);
    } else {
      const lastImport = [...out.matchAll(/^import [^;]+;\s*$/gm)].pop();
      const pos = lastImport ? lastImport.index + lastImport[0].length : 0;
      out = out.slice(0, pos) + `\nimport { ${spec} } from '@/lib/i18n';` + out.slice(pos);
    }
  }
  writeFileSync(file, out);
}

const files = walkDir(ROOT);
for (const f of files) processFile(f);

// Keys that are produced at runtime from data (status codes, nav sections, role names, …) and translated centrally.
try {
  for (const k of JSON.parse(readFileSync(EXTRA_KEYS_FILE, 'utf8'))) keys.add(k);
} catch {
  /* optional */
}
const sorted = [...keys].sort((a, b) => a.localeCompare(b));
const keysFile = join(ROOT, 'i18n', 'keys.json');
const keysJson = JSON.stringify(sorted, null, 2) + '\n';
if (CHECK) {
  // CI guard: the committed keys.json must match the source (run the codemod and commit the result otherwise).
  let committed = '';
  try { committed = readFileSync(keysFile, 'utf8'); } catch { /* missing */ }
  if (committed !== keysJson) {
    console.error('i18n: keys.json is out of date — run `node scripts/i18n/wrap-strings.mjs` and commit apps/web/src/i18n/keys.json');
    process.exitCode = 1;
  }
} else writeFileSync(keysFile, keysJson);
if (CHECK) {
  if (report.length) {
    console.error(`i18n: ${report.length} file(s) contain unwrapped UI strings:\n  ${report.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`i18n: all UI strings wrapped; ${sorted.length} keys`);
} else {
  console.log(`i18n: processed ${files.length} files; ${sorted.length} keys written to src/i18n/keys.json`);
}

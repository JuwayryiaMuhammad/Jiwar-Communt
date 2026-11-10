/**
 * Checks each package runs in its own tests (node --test): the catalogs'
 * parity, and no user-visible text left outside them.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { argumentNames } from './message.ts';

const ARABIC = /[؀-ۿ]/;

type Catalog = Record<string, string>;

async function load(file: string): Promise<Catalog> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: Catalog };
  assert.ok(mod.default && typeof mod.default === 'object', `${file} has a default export`);
  return mod.default;
}

/**
 * `messages/en/*.ts` and `messages/ar/*.ts`, each a default-exported object:
 * the same files, the same keys, the same values read, nothing empty, and
 * the Arabic in Arabic (apart from `latin`, keys whose text is a name or a
 * code in either language, such as the switcher's "English").
 */
export async function assertCatalogs(messagesDir: string, options: { latin?: readonly string[] } = {}) {
  const list = (locale: string) =>
    readdirSync(path.join(messagesDir, locale))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .sort();
  const files = list('en');
  assert.deepEqual(list('ar'), files, `${messagesDir}: the same catalog files in en and ar`);
  assert.ok(files.length > 0, `${messagesDir}: catalogs found`);
  let keys = 0;
  for (const file of files) {
    const en = await load(path.join(messagesDir, 'en', file));
    const ar = await load(path.join(messagesDir, 'ar', file));
    assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort(), `${file}: ar and en carry the same keys`);
    for (const key of Object.keys(en)) {
      const id = `${file} ${key}`;
      assert.ok(typeof en[key] === 'string' && en[key]!.trim(), `en ${id} is not empty`);
      assert.ok(typeof ar[key] === 'string' && ar[key]!.trim(), `ar ${id} is not empty`);
      assert.deepEqual(argumentNames(ar[key]!), argumentNames(en[key]!), `${id}: the same values in both`);
      if (!options.latin?.includes(`${file.replace(/\.ts$/, '')}.${key}`)) {
        assert.match(ar[key]!, ARABIC, `ar ${id} is Arabic`);
      }
    }
    keys += Object.keys(en).length;
  }
  return { files: files.length, keys };
}

/** Props and object keys whose text a person reads. */
const TEXT_NAMES = new Set([
  'title',
  'label',
  'placeholder',
  'description',
  'aria-label',
  'alt',
  'hint',
  'empty',
  'emptyHint',
  'confirmLabel',
  'textLabel',
  'textHint',
  'codeLabel',
  'header',
  'crumb',
  'product',
  'context',
  'meta',
  'text',
  'message',
  'subtitle',
  'caption',
]);
/** Calls whose first argument a person reads. */
const TEXT_CALLS = new Set(['show', 'confirm', 'alert', 'prompt']);

/** A word in either script; a lone acronym or code (`CSV`, `QR`, `MT-`) is not prose. */
function isProse(text: string): boolean {
  const s = text.trim();
  if (!/[A-Za-z؀-ۿ]/.test(s)) return false;
  if (/^[A-Z0-9][A-Z0-9 .:/+#-]{0,7}$/.test(s)) return false;
  return true;
}

export interface HardCodedText {
  file: string;
  line: number;
  text: string;
}

function textOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  if (ts.isConditionalExpression(node)) {
    const both = [textOf(node.whenTrue), textOf(node.whenFalse)].filter((x): x is string => x !== null);
    return both.length ? both.join(' | ') : null;
  }
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
      node.operatorToken.kind,
    )
  )
    return textOf(node.right);
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
  return null;
}

/** The text in `.tsx` files that is shown to a person without going through a catalog. */
export function findHardCodedText(files: readonly string[]): HardCodedText[] {
  const found: HardCodedText[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node: ts.Node, text: string) => {
      if (!isProse(text)) return;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push({ file, line, text: text.trim().slice(0, 80) });
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) report(node, node.text);
      else if (ts.isJsxAttribute(node) && node.initializer) {
        const name = node.name.getText(source);
        if (TEXT_NAMES.has(name)) {
          const init = node.initializer;
          const text = ts.isStringLiteral(init)
            ? init.text
            : ts.isJsxExpression(init) && init.expression
              ? textOf(init.expression)
              : null;
          if (text) report(init, text);
        }
      } else if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        if (TEXT_NAMES.has(name)) {
          const text = textOf(node.initializer);
          if (text) report(node.initializer, text);
        }
      } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        // {'text'}, {`text ${x}`} or {cond ? 'a' : 'b'} as a child of an element.
        const text = textOf(node.expression);
        if (text) report(node.expression, text);
      } else if (ts.isCallExpression(node) && node.arguments[0]) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (TEXT_CALLS.has(name)) {
          const text = textOf(node.arguments[0]);
          if (text) report(node.arguments[0], text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Every `.tsx` under the given directories, apart from node_modules and build output. */
export function tsxFiles(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name === 'e2e') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.tsx')) out.push(full);
    }
  };
  for (const dir of dirs) {
    if (statSync(dir).isDirectory()) walk(dir);
    else if (dir.endsWith('.tsx')) out.push(dir);
  }
  return out.sort();
}

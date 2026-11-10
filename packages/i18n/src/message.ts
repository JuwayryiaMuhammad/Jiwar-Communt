import { intlLocale, type Locale } from './locale.ts';

/**
 * A small subset of ICU MessageFormat, enough for the catalogs:
 *
 *   {name}                                   a value
 *   {count, plural, =0 {…} one {…} two {…} few {…} many {…} other {…}}
 *   {kind, select, unit {…} area {…} other {…}}
 *
 * `#` inside a plural branch is the count. Arabic needs every plural form
 * Intl.PluralRules gives it (zero, one, two, few, many, other); a missing
 * form falls back to `other`. There is no apostrophe escaping: the catalogs
 * use typographic quotes (’ “ ”), and a literal brace is never needed.
 */
export type MessageValue = string | number | null | undefined;
export type MessageParams = Readonly<Record<string, MessageValue>>;

type Node =
  | { t: 'text'; v: string }
  | { t: 'arg'; name: string }
  | { t: 'pound' }
  | { t: 'plural' | 'select'; name: string; options: Record<string, Node[]> };

class Parser {
  i = 0;
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  fail(what: string): never {
    throw new Error(`Bad message (${what} at ${this.i}): ${this.src}`);
  }

  nodes(inPlural: boolean, nested: boolean): Node[] {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ t: 'text', v: text });
      text = '';
    };
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === '}') {
        if (!nested) this.fail('unmatched }');
        break;
      }
      if (c === '{') {
        flush();
        out.push(this.argument());
        continue;
      }
      if (c === '#' && inPlural) {
        flush();
        out.push({ t: 'pound' });
        this.i++;
        continue;
      }
      text += c;
      this.i++;
    }
    flush();
    return out;
  }

  word(): string {
    const m = /^\s*([^\s,{}]+)\s*/.exec(this.src.slice(this.i));
    if (!m) this.fail('a name');
    this.i += m[0].length;
    return m[1]!;
  }

  argument(): Node {
    this.i++; // {
    const name = this.word();
    if (this.src[this.i] === '}') {
      this.i++;
      return { t: 'arg', name };
    }
    if (this.src[this.i] !== ',') this.fail(', or }');
    this.i++;
    const kind = this.word();
    if (kind !== 'plural' && kind !== 'select') this.fail(`unknown type ${kind}`);
    if (this.src[this.i] !== ',') this.fail(',');
    this.i++;
    const options: Record<string, Node[]> = {};
    for (;;) {
      const ws = /^\s*/.exec(this.src.slice(this.i))![0];
      this.i += ws.length;
      if (this.src[this.i] === '}') {
        this.i++;
        break;
      }
      const key = this.word();
      if (this.src[this.i] !== '{') this.fail('{ after a selector');
      this.i++;
      options[key] = this.nodes(kind === 'plural', true);
      if (this.src[this.i] !== '}') this.fail('} closing a branch');
      this.i++;
    }
    if (!options.other) this.fail('an other branch');
    return { t: kind, name, options };
  }
}

const parsed = new Map<string, Node[]>();

function parse(template: string): Node[] {
  let nodes = parsed.get(template);
  if (!nodes) {
    nodes = new Parser(template).nodes(false, false);
    parsed.set(template, nodes);
  }
  return nodes;
}

// First-strong isolates keep a value's own direction inside the sentence: a
// unit code or a Latin name in Arabic text, an Arabic name in English text.
const FSI = '⁨';
const PDI = '⁩';

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const pluralRules = new Map<Locale, Intl.PluralRules>();

function numberFormat(locale: Locale) {
  let f = numberFormats.get(locale);
  if (!f) {
    // Four-digit numbers (a year, a code) are not grouped.
    f = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2, useGrouping: 'min2' });
    numberFormats.set(locale, f);
  }
  return f;
}

function plural(locale: Locale) {
  let p = pluralRules.get(locale);
  if (!p) {
    p = new Intl.PluralRules(intlLocale(locale));
    pluralRules.set(locale, p);
  }
  return p;
}

function render(locale: Locale, nodes: Node[], params: MessageParams | undefined, count?: number): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += n.v;
        break;
      case 'pound':
        out += count === undefined ? '#' : numberFormat(locale).format(count);
        break;
      case 'arg': {
        const v = params?.[n.name];
        if (typeof v === 'number') out += numberFormat(locale).format(v);
        else if (typeof v === 'string' && v !== '') out += FSI + v + PDI;
        break;
      }
      case 'plural': {
        const raw = params?.[n.name];
        const value = typeof raw === 'number' ? raw : Number(raw);
        const branch =
          n.options[`=${value}`] ??
          (Number.isFinite(value) ? n.options[plural(locale).select(value)] : undefined) ??
          n.options.other!;
        out += render(locale, branch, params, Number.isFinite(value) ? value : undefined);
        break;
      }
      case 'select': {
        const raw = params?.[n.name];
        out += render(locale, n.options[String(raw)] ?? n.options.other!, params, count);
        break;
      }
    }
  }
  return out;
}

/** Fill a catalog message. A missing value renders as nothing. */
export function formatMessage(locale: Locale, template: string, params?: MessageParams): string {
  return render(locale, parse(template), params);
}

/** The names a message reads, for the catalogs' parity test. */
export function argumentNames(template: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.t === 'arg') names.add(n.name);
      if (n.t === 'plural' || n.t === 'select') {
        names.add(n.name);
        Object.values(n.options).forEach(walk);
      }
    }
  };
  walk(parse(template));
  return [...names].sort();
}

/** Strip the direction isolates `formatMessage` puts around values (tests, plain-text exports). */
export function stripIsolates(text: string): string {
  return text.replace(/[⁨⁩]/g, '');
}

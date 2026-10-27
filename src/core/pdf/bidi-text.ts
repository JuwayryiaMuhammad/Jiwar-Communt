import bidiFactory from 'bidi-js';

// ============================================================================
// Mixed Arabic and Latin text on a PDF line (ADR 0062)
// ============================================================================
//
// pdfkit shapes Arabic through fontkit (the letters join), and fontkit lays
// an Arabic run right to left. What neither does is the bidirectional
// algorithm: a whole line given at once comes out with its digits and Latin
// words reversed ("345" as "543"), and the Arabic font has no Latin glyphs.
// So a line is cut into runs by the Unicode bidi levels (bidi-js), each run
// gets the font for its script, and the runs are placed in visual order.

const bidi = bidiFactory();

/** The two faces text is set in: the Arabic one or the Latin one. */
export type Script = 'arabic' | 'latin';

/** Arabic letters, Arabic-Indic digits and the presentation forms. */
export const ARABIC_RANGE =
  '\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff';
const ARABIC = new RegExp(`[${ARABIC_RANGE}]`);

export function scriptOf(text: string): Script {
  return ARABIC.test(text) ? 'arabic' : 'latin';
}

/** A paragraph's direction: its first strong character's, else `fallback`. */
export function directionOf(
  text: string,
  fallback: 'ltr' | 'rtl',
): 'ltr' | 'rtl' {
  const strong = new RegExp(`[A-Za-z\\u00c0-\\u024f${ARABIC_RANGE}]`).exec(
    text,
  );
  if (!strong) return fallback;
  return ARABIC.test(strong[0]) ? 'rtl' : 'ltr';
}

/**
 * One piece of a line, in visual order left to right: a word (or part of
 * one) in a single face, or a stretch of spaces. pdfkit is given one piece
 * at a time and never sees a space inside a piece: given several Arabic
 * words at once it lays each out on its own and loses a space between them.
 *
 * An Arabic piece is handed over in logical order, since fontkit reverses
 * it (and must, to join its letters). Anything else on a right-to-left
 * stretch (a bracket, a dash) is set in the Latin face, which has the
 * punctuation the Arabic face lacks, reversed and mirrored here.
 */
export interface VisualPiece {
  text: string;
  script: Script;
  space: boolean;
}

type Face = Script | 'space';

function faceOf(ch: string): Face {
  if (/\s/.test(ch)) return 'space';
  return scriptOf(ch);
}

/**
 * The pieces of one line, left to right. Line breaking happens before this,
 * in logical order; each line is reordered on its own (UAX #9 L1-L2), with
 * the levels resolved over its whole paragraph.
 */
export function visualPieces(
  paragraph: string,
  base: 'ltr' | 'rtl',
  start = 0,
  end = paragraph.length - 1,
): VisualPiece[] {
  if (end < start) return [];
  const levels = bidi.getEmbeddingLevels(paragraph, base);
  // The logical index shown at each visual position of the line.
  const order: number[] = [];
  for (let i = start; i <= end; i++) order.push(i);
  for (const [from, to] of bidi.getReorderSegments(
    paragraph,
    levels,
    start,
    end,
  )) {
    const a = from - start;
    const b = to - start;
    order.splice(a, b - a + 1, ...order.slice(a, b + 1).reverse());
  }
  const groups: { indices: number[]; rtl: boolean; face: Face }[] = [];
  for (const i of order) {
    const rtl = levels.levels[i] % 2 === 1;
    const face = faceOf(paragraph[i]);
    const last = groups[groups.length - 1];
    const step = last ? i - last.indices[last.indices.length - 1] : 0;
    if (
      last &&
      last.rtl === rtl &&
      last.face === face &&
      step === (rtl ? -1 : 1)
    ) {
      last.indices.push(i);
      continue;
    }
    groups.push({ indices: [i], rtl, face });
  }
  return groups.map(({ indices, rtl, face }) => {
    const space = face === 'space';
    const script: Script = face === 'arabic' ? 'arabic' : 'latin';
    if (rtl && script === 'arabic') {
      // Visual order is reversed; give fontkit the logical order back.
      const text = [...indices]
        .reverse()
        .map((i) => paragraph[i])
        .join('');
      return { text, script, space };
    }
    const text = indices
      .map((i) =>
        rtl
          ? (bidi.getMirroredCharacter(paragraph[i]) ?? paragraph[i])
          : paragraph[i],
      )
      .join('');
    return { text, script, space };
  });
}

/** A word and the spaces after it, as found in logical order. */
interface Token {
  start: number;
  end: number; // exclusive, the word's
  next: number; // exclusive, with its trailing spaces
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /(\S+)(\s*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      start: m.index,
      end: m.index + m[1].length,
      next: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Cuts a paragraph into lines no wider than `width`, in logical order, by
 * words. `measure` gives the width of a piece of text (it measures each
 * script's part in that script's face). A word wider than the line stands
 * alone on its line. Returns [start, end] inclusive, trailing spaces left out.
 */
export function wrapLines(
  text: string,
  width: number,
  measure: (piece: string) => number,
): [number, number][] {
  const words = tokens(text);
  const lines: [number, number][] = [];
  let first: Token | null = null;
  let last: Token | null = null;
  for (const word of words) {
    if (!first || !last) {
      first = last = word;
      continue;
    }
    if (measure(text.slice(first.start, word.end)) <= width) {
      last = word;
      continue;
    }
    lines.push([first.start, last.end - 1]);
    first = last = word;
  }
  if (first && last) lines.push([first.start, last.end - 1]);
  return lines;
}

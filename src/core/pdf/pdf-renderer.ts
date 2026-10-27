import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import {
  ARABIC_RANGE,
  directionOf,
  scriptOf,
  visualPieces,
  wrapLines,
  type Script,
} from './bidi-text';

// ============================================================================
// Server-side PDFs (ADR 0062)
// ============================================================================
//
// One small renderer for the documents the backend issues: certificates
// now, receipts next (R11c). A PDF is never stored: it is drawn on demand
// from an immutable record, by the template version the record names, so
// there is no file to keep, purge or erase. Templates are code; a version
// once used is never edited (its spec pins its output), a change is a new
// version. Same input, same bytes: the creation date is the record's.

/** The vendored faces (OFL, assets/fonts/OFL.txt): src and dist alike. */
const FONTS = resolve(__dirname, '../../../assets/fonts');
const FACES: Record<Script, Record<'regular' | 'bold', string>> = {
  arabic: {
    regular: `${FONTS}/NotoNaskhArabic-Regular.ttf`,
    bold: `${FONTS}/NotoNaskhArabic-Bold.ttf`,
  },
  latin: {
    regular: `${FONTS}/NotoSans-Regular.ttf`,
    bold: `${FONTS}/NotoSans-Bold.ttf`,
  },
};

export interface TextStyle {
  size: number;
  bold?: boolean;
  /** The paragraph's own direction, else its first strong character's. */
  dir?: 'ltr' | 'rtl';
  align: 'left' | 'right' | 'center';
}

/**
 * A page being drawn. Text goes through `paragraph`, which wraps by words
 * and sets each line's runs in their own face and in visual order.
 */
export class PdfPage {
  constructor(readonly doc: PDFKit.PDFDocument) {}

  private face(script: Script, style: TextStyle): void {
    this.doc
      .font(`${script}-${style.bold ? 'bold' : 'regular'}`)
      .fontSize(style.size);
  }

  /** The width of one piece, in its face. */
  private pieceWidth(text: string, script: Script, style: TextStyle): number {
    this.face(script, style);
    return this.doc.widthOfString(text);
  }

  /** The width of logical text: each word's parts in their own face. */
  width(text: string, style: TextStyle): number {
    let total = 0;
    for (const piece of text.match(ARABIC_OR_NOT) ?? [])
      total += this.pieceWidth(piece, scriptOf(piece), style);
    return total;
  }

  /** Draws a paragraph in the box; returns the y below its last line. */
  paragraph(
    text: string,
    x: number,
    y: number,
    width: number,
    style: TextStyle,
  ): number {
    const base = style.dir ?? directionOf(text, 'ltr');
    const lineHeight = style.size * 1.6;
    for (const [start, end] of wrapLines(text, width, (t) =>
      this.width(t, style),
    )) {
      const pieces = visualPieces(text, base, start, end).map((p) => ({
        ...p,
        width: this.pieceWidth(p.text, p.script, style),
      }));
      const used = pieces.reduce((w, p) => w + p.width, 0);
      let at =
        style.align === 'left'
          ? x
          : style.align === 'right'
            ? x + width - used
            : x + (width - used) / 2;
      for (const piece of pieces) {
        if (!piece.space) {
          this.face(piece.script, style);
          this.doc.text(piece.text, at, y, { lineBreak: false });
        }
        at += piece.width;
      }
      y += lineHeight;
    }
    return y;
  }

  rule(y: number, x = 50, to = 545): void {
    this.doc
      .moveTo(x, y)
      .lineTo(to, y)
      .lineWidth(0.5)
      .strokeColor('#888888')
      .stroke();
  }
}

/** Arabic stretches, spaces, and everything else, apart. */
const ARABIC_OR_NOT = new RegExp(
  `[${ARABIC_RANGE}]+|\\s+|[^\\s${ARABIC_RANGE}]+`,
  'g',
);

@Injectable()
export class PdfRenderer {
  /**
   * One A4 document drawn by `draw`. `createdAt` is the record's instant,
   * so the same record gives the same bytes.
   */
  render(
    meta: { title: string; createdAt: Date },
    draw: (page: PdfPage) => void,
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: meta.title,
        Producer: 'Jiwar',
        Creator: 'Jiwar',
        CreationDate: meta.createdAt,
      },
    });
    for (const script of ['arabic', 'latin'] as const) {
      doc.registerFont(`${script}-regular`, FACES[script].regular);
      doc.registerFont(`${script}-bold`, FACES[script].bold);
    }
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((ok, fail) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => ok(Buffer.concat(chunks)));
      doc.on('error', fail);
    });
    draw(new PdfPage(doc));
    doc.end();
    return done;
  }
}

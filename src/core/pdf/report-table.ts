import type { PdfPage, TextStyle } from './pdf-renderer';

// ============================================================================
// A report's table as a PDF (ADR 0086)
// ============================================================================
//
// A curated report drawn on A4, portrait up to six columns and landscape
// beyond: the compound, the report's title in English and Arabic, its
// period (and what it is compared with), then the table, its header
// repeated on every page, the totals last. The type shrinks with the
// columns (never below 6 pt). The caller hands over finished strings;
// nothing here reads the database.

export interface ReportTableContent {
  compound: string;
  titleEn: string;
  titleAr: string;
  /** "2026-10-01 to 2026-10-31", and what it is compared with. */
  lines: string[];
  headers: { en: string; ar: string }[];
  /** Figures align right, text by its own direction. */
  kinds: ('text' | 'number')[];
  rows: (string | null)[][];
  /** The last row, in bold: the totals. */
  totalsLast: boolean;
}

const MARGIN = 50;

/** Landscape past this many columns. */
export const PORTRAIT_COLUMNS = 6;

export function reportLayout(columns: number): 'portrait' | 'landscape' {
  return columns > PORTRAIT_COLUMNS ? 'landscape' : 'portrait';
}

export function drawReportTable(page: PdfPage, c: ReportTableContent): void {
  const doc = page.doc;
  const width = doc.page.width - 2 * MARGIN;
  const bottom = doc.page.height - MARGIN;
  const n = Math.max(c.headers.length, 1);
  const size = Math.max(6, Math.min(10, Math.floor(60 / n) + 3));
  const col = width / n;
  let y = MARGIN;
  y = page.paragraph(c.compound, MARGIN, y, width, {
    size: 12,
    bold: true,
    align: 'center',
  });
  const titleY = y + 4;
  const en = page.paragraph(c.titleEn, MARGIN, titleY, width / 2, {
    size: 15,
    bold: true,
    dir: 'ltr',
    align: 'left',
  });
  const ar = page.paragraph(c.titleAr, MARGIN + width / 2, titleY, width / 2, {
    size: 15,
    bold: true,
    dir: 'rtl',
    align: 'right',
  });
  y = Math.max(en, ar);
  for (const line of c.lines)
    y = page.paragraph(line, MARGIN, y, width, {
      size: 9,
      dir: 'ltr',
      align: 'left',
    });
  y += 6;
  const header = (top: number): number => {
    let end = top;
    c.headers.forEach((h, i) => {
      const style: TextStyle = { size, bold: true, align: 'center' };
      const a = page.paragraph(h.en, MARGIN + i * col, top, col - 4, style);
      const b = page.paragraph(h.ar, MARGIN + i * col, a, col - 4, {
        ...style,
        dir: 'rtl',
      });
      end = Math.max(end, b);
    });
    page.rule(end + 1, MARGIN, MARGIN + width);
    return end + 4;
  };
  y = header(y);
  c.rows.forEach((row, r) => {
    const bold = c.totalsLast && r === c.rows.length - 1;
    // A row's height is its tallest cell's: measured where it would go.
    const lineHeight = size * 1.6;
    if (y + lineHeight * 2 > bottom) {
      doc.addPage();
      y = header(MARGIN);
    }
    if (bold) page.rule(y - 2, MARGIN, MARGIN + width);
    let end = y;
    row.forEach((v, i) => {
      if (v === null) return;
      const at = page.paragraph(v, MARGIN + i * col, y, col - 4, {
        size,
        bold,
        align: c.kinds[i] === 'number' ? 'right' : 'left',
        ...(c.kinds[i] === 'number' ? { dir: 'ltr' as const } : {}),
      });
      end = Math.max(end, at);
    });
    y = Math.max(end, y + lineHeight);
  });
}

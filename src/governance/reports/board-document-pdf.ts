import type { PdfPage } from '../../core/pdf/pdf-renderer';

// ============================================================================
// The board's documents as PDFs (ADR 0075): a handover pack, a manager's
// handover, the monthly board report. One template, drawn on demand from a
// stored snapshot (ADR 0062: a PDF is never stored). The domain hands over
// finished strings; nothing here reads the database. The compound's logo,
// when it has one, heads the first page.
// ============================================================================

export const BOARD_DOCUMENT_TEMPLATES = ['board-document.v1'] as const;

export interface BoardDocumentSection {
  headingEn: string;
  headingAr: string;
  /** One line each, any script; an empty section says so. */
  lines: string[];
}

export interface BoardDocumentContent {
  /** The compound's name, as it calls itself. */
  compound: string;
  titleEn: string;
  titleAr: string;
  /** e.g. the period, or `BM-0003`. */
  subtitle: string;
  sections: BoardDocumentSection[];
  /** PNG or JPEG bytes, or null. */
  logo: Buffer | null;
}

const LEFT = 50;
const WIDTH = 495;
const BOTTOM = 780;
const NONE_EN = 'None.';
const NONE_AR = 'لا شيء.';

export function drawBoardDocument(
  page: PdfPage,
  c: BoardDocumentContent,
): void {
  let y = 50;
  if (c.logo) {
    try {
      page.doc.image(c.logo, LEFT + WIDTH / 2 - 30, y, { fit: [60, 60] });
      y += 68;
    } catch {
      // An image pdfkit cannot read draws no logo; the document stands.
    }
  }
  y = page.paragraph(c.compound, LEFT, y, WIDTH, {
    size: 13,
    bold: true,
    align: 'center',
  });
  y += 6;
  const en = page.paragraph(c.titleEn, LEFT, y, WIDTH / 2, {
    size: 17,
    bold: true,
    dir: 'ltr',
    align: 'left',
  });
  const ar = page.paragraph(c.titleAr, LEFT + WIDTH / 2, y, WIDTH / 2, {
    size: 17,
    bold: true,
    dir: 'rtl',
    align: 'right',
  });
  y = Math.max(en, ar);
  y = page.paragraph(c.subtitle, LEFT, y, WIDTH, {
    size: 11,
    dir: 'ltr',
    align: 'center',
  });
  page.rule(y + 4);
  y += 14;
  for (const section of c.sections) {
    if (y > BOTTOM - 60) y = nextPage(page);
    const hEn = page.paragraph(section.headingEn, LEFT, y, WIDTH / 2, {
      size: 12,
      bold: true,
      dir: 'ltr',
      align: 'left',
    });
    const hAr = page.paragraph(
      section.headingAr,
      LEFT + WIDTH / 2,
      y,
      WIDTH / 2,
      { size: 12, bold: true, dir: 'rtl', align: 'right' },
    );
    y = Math.max(hEn, hAr) + 2;
    const lines = section.lines.length
      ? section.lines
      : [`${NONE_EN} ${NONE_AR}`];
    for (const line of lines) {
      if (y > BOTTOM) y = nextPage(page);
      y = page.paragraph(line, LEFT + 10, y, WIDTH - 10, {
        size: 10,
        align: 'left',
      });
    }
    y += 10;
  }
}

function nextPage(page: PdfPage): number {
  page.doc.addPage();
  return 50;
}

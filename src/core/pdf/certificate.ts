import type { PdfPage } from './pdf-renderer';

// ============================================================================
// Certificates as PDFs (ADR 0062)
// ============================================================================
//
// A certificate is a record (a clearance, a works completion); this draws
// it, bilingual on one A4 page: English on the left, Arabic on the right,
// the values between them. The issuing domain hands over finished strings
// (dates in the compound's zone, amounts formatted); nothing here reads the
// database. Each template version is frozen once a record names it.
// (certificate.v1 never left the branch that made it: v2 replaced it there,
// with the unit's code and building on rows of their own and every amount
// in one form.)

export const CERTIFICATE_TEMPLATES = ['certificate.v2'] as const;
export type CertificateTemplate = (typeof CERTIFICATE_TEMPLATES)[number];

export interface CertificateRow {
  labelEn: string;
  labelAr: string;
  /** Any script; set in the direction of its first letter. */
  value: string;
}

export interface CertificateContent {
  template: CertificateTemplate;
  /** The compound's name, as it calls itself. */
  compound: string;
  titleEn: string;
  titleAr: string;
  /** The record's number, e.g. `CL-000123`. */
  number: string;
  rows: CertificateRow[];
  /** One sentence each, what the certificate states. */
  statementEn: string;
  statementAr: string;
  /** Where and with what code anyone can check it. */
  verifyUrl: string;
  verifyCode: string;
}

const LEFT = 50;
const WIDTH = 495;
const LABEL = 150;
const VALUE = WIDTH - 2 * LABEL;

export function drawCertificate(page: PdfPage, c: CertificateContent): void {
  switch (c.template) {
    case 'certificate.v2':
      return drawV2(page, c);
  }
}

function drawV2(page: PdfPage, c: CertificateContent): void {
  let y = 60;
  y = page.paragraph(c.compound, LEFT, y, WIDTH, {
    size: 13,
    bold: true,
    align: 'center',
  });
  y += 10;
  const titleY = y;
  const enEnd = page.paragraph(c.titleEn, LEFT, titleY, WIDTH / 2, {
    size: 18,
    bold: true,
    dir: 'ltr',
    align: 'left',
  });
  const arEnd = page.paragraph(c.titleAr, LEFT + WIDTH / 2, titleY, WIDTH / 2, {
    size: 18,
    bold: true,
    dir: 'rtl',
    align: 'right',
  });
  y = Math.max(enEnd, arEnd);
  y = page.paragraph(c.number, LEFT, y, WIDTH, {
    size: 12,
    dir: 'ltr',
    align: 'center',
  });
  page.rule(y + 4);
  y += 18;
  for (const row of c.rows) {
    const en = page.paragraph(row.labelEn, LEFT, y, LABEL, {
      size: 11,
      dir: 'ltr',
      align: 'left',
    });
    const value = page.paragraph(row.value, LEFT + LABEL, y, VALUE, {
      size: 11,
      bold: true,
      align: 'center',
    });
    const ar = page.paragraph(row.labelAr, LEFT + LABEL + VALUE, y, LABEL, {
      size: 11,
      dir: 'rtl',
      align: 'right',
    });
    y = Math.max(en, value, ar) + 4;
  }
  page.rule(y);
  y += 14;
  y = page.paragraph(c.statementEn, LEFT, y, WIDTH, {
    size: 11,
    dir: 'ltr',
    align: 'left',
  });
  y = page.paragraph(c.statementAr, LEFT, y + 4, WIDTH, {
    size: 11,
    dir: 'rtl',
    align: 'right',
  });
  y += 16;
  y = page.paragraph(
    `Verify at ${c.verifyUrl} with the code ${c.verifyCode}.`,
    LEFT,
    y,
    WIDTH,
    { size: 10, dir: 'ltr', align: 'left' },
  );
  page.paragraph(
    `للتحقق: ${c.verifyUrl} بالرمز ${c.verifyCode}`,
    LEFT,
    y + 2,
    WIDTH,
    { size: 10, dir: 'rtl', align: 'right' },
  );
}

import type { PdfPage } from './pdf-renderer';

// ============================================================================
// A purchase order as a PDF (ADR 0094)
// ============================================================================
//
// What the compound sends a vendor: its name, the order's number and
// revision, the vendor, the delivery day, the lines with their quantity,
// unit, price and VAT, and the totals; bilingual on one A4 page (more when
// the lines need it): English on the left, Arabic on the right. The domain
// hands over finished strings (days in the compound's zone, amounts
// formatted); nothing here reads the database. A template version once
// used is never edited.

export const PURCHASE_ORDER_TEMPLATES = ['purchase-order.v1'] as const;
export type PurchaseOrderTemplate = (typeof PURCHASE_ORDER_TEMPLATES)[number];

export interface PurchaseOrderPdfLine {
  position: string;
  description: string;
  /** `10 piece`: the quantity and its unit, as the reader says them. */
  quantity: string;
  unitPrice: string;
  /** The line's VAT rate (`14%`) or `-`. */
  vat: string;
  net: string;
}

export interface PurchaseOrderPdfContent {
  template: PurchaseOrderTemplate;
  /** The compound's name, as it calls itself. */
  compound: string;
  /** `PO-000012`. */
  number: string;
  revision: number;
  vendorName: string;
  vendorTaxNumber: string | null;
  deliveryOn: string;
  issuedOn: string;
  lines: PurchaseOrderPdfLine[];
  subtotal: string;
  tax: string;
  total: string;
  note: string | null;
}

const LEFT = 50;
const WIDTH = 495;
const BOTTOM = 780;
/** The columns' widths: number, description, quantity, price, VAT, net. */
const COLUMNS = [24, 190, 80, 70, 40, 91];

export function drawPurchaseOrder(
  page: PdfPage,
  c: PurchaseOrderPdfContent,
): void {
  switch (c.template) {
    case 'purchase-order.v1':
      return drawV1(page, c);
  }
}

function drawV1(page: PdfPage, c: PurchaseOrderPdfContent): void {
  let y = 60;
  y = page.paragraph(c.compound, LEFT, y, WIDTH, {
    size: 13,
    bold: true,
    align: 'center',
  });
  y += 10;
  const en = page.paragraph('Purchase order', LEFT, y, WIDTH / 2, {
    size: 18,
    bold: true,
    dir: 'ltr',
    align: 'left',
  });
  const ar = page.paragraph('أمر شراء', LEFT + WIDTH / 2, y, WIDTH / 2, {
    size: 18,
    bold: true,
    dir: 'rtl',
    align: 'right',
  });
  y = Math.max(en, ar);
  y = page.paragraph(`${c.number} / ${c.revision}`, LEFT, y, WIDTH, {
    size: 12,
    dir: 'ltr',
    align: 'center',
  });
  page.rule(y + 4);
  y += 18;
  const rows: [string, string, string][] = [
    ['Vendor', c.vendorName, 'المورد'],
    ...(c.vendorTaxNumber
      ? ([['Tax number', c.vendorTaxNumber, 'الرقم الضريبي']] as [
          string,
          string,
          string,
        ][])
      : []),
    ['Issued on', c.issuedOn, 'تاريخ الإصدار'],
    ['Delivery on', c.deliveryOn, 'موعد التسليم'],
  ];
  for (const [labelEn, value, labelAr] of rows) {
    const a = page.paragraph(labelEn, LEFT, y, 120, {
      size: 11,
      dir: 'ltr',
      align: 'left',
    });
    const b = page.paragraph(value, LEFT + 120, y, WIDTH - 240, {
      size: 11,
      bold: true,
      align: 'center',
    });
    const d = page.paragraph(labelAr, LEFT + WIDTH - 120, y, 120, {
      size: 11,
      dir: 'rtl',
      align: 'right',
    });
    y = Math.max(a, b, d) + 4;
  }
  page.rule(y);
  y += 10;
  y = header(page, y);
  for (const l of c.lines) {
    const cells = [
      l.position,
      l.description,
      l.quantity,
      l.unitPrice,
      l.vat,
      l.net,
    ];
    const height = rowHeight(page, cells);
    if (y + height > BOTTOM) {
      page.doc.addPage();
      y = header(page, 50);
    }
    y = row(page, y, cells, false);
  }
  page.rule(y);
  y += 8;
  for (const [labelEn, value, labelAr] of [
    ['Net', c.subtotal, 'الصافي'],
    ['VAT', c.tax, 'الضريبة'],
    ['Total', c.total, 'الإجمالي'],
  ] as const) {
    if (y + 20 > BOTTOM) {
      page.doc.addPage();
      y = 50;
    }
    const a = page.paragraph(labelEn, LEFT, y, 120, {
      size: 11,
      bold: labelEn === 'Total',
      dir: 'ltr',
      align: 'left',
    });
    const b = page.paragraph(value, LEFT + 120, y, WIDTH - 240, {
      size: 11,
      bold: true,
      dir: 'ltr',
      align: 'center',
    });
    const d = page.paragraph(labelAr, LEFT + WIDTH - 120, y, 120, {
      size: 11,
      bold: labelEn === 'Total',
      dir: 'rtl',
      align: 'right',
    });
    y = Math.max(a, b, d) + 2;
  }
  if (c.note) {
    y += 10;
    if (y + 40 > BOTTOM) {
      page.doc.addPage();
      y = 50;
    }
    page.paragraph(c.note, LEFT, y, WIDTH, { size: 10, align: 'left' });
  }
}

function header(page: PdfPage, y: number): number {
  const cells = [
    '#',
    'Description / البند',
    'Qty / الكمية',
    'Price / السعر',
    'VAT',
    'Net / الصافي',
  ];
  y = row(page, y, cells, true);
  page.rule(y);
  return y + 4;
}

/** The tallest cell of a row, drawn to measure nothing: lines of 8 pt each. */
function rowHeight(page: PdfPage, cells: string[]): number {
  let tallest = 1;
  cells.forEach((text, i) => {
    const w = page.width(text, { size: 9, align: 'left' });
    tallest = Math.max(tallest, Math.ceil(w / Math.max(COLUMNS[i] - 4, 1)));
  });
  return tallest * 14 + 4;
}

function row(page: PdfPage, y: number, cells: string[], bold: boolean): number {
  let x = LEFT;
  let bottom = y;
  cells.forEach((text, i) => {
    const end = page.paragraph(text, x, y, COLUMNS[i] - 4, {
      size: 9,
      bold,
      align: i === 1 ? 'left' : 'center',
    });
    bottom = Math.max(bottom, end);
    x += COLUMNS[i];
  });
  return bottom + 4;
}

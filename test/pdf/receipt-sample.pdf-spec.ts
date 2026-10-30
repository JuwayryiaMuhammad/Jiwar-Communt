import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawCertificate } from '../../src/core/pdf/certificate';
import { PdfRenderer } from '../../src/core/pdf/pdf-renderer';
import { receiptContent } from '../../src/finance/payments/receipt-pdf';

// A payment's receipt (ADR 0069), drawn by the certificate's layout and
// rasterised with poppler for a person to look at: an Arabic compound name,
// a grouped amount, invoice numbers and the verifying link. Run with
// `pnpm test:pdf-sample`; PDF_RECEIPT_PNG=<path> also copies the page there.

describe('receipt PDF sample', () => {
  it('keeps the numbers in order, names nobody, and rasterises', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiwar-receipt-'));
    const pdf = join(dir, 'receipt.pdf');
    writeFileSync(
      pdf,
      await new PdfRenderer().render(
        { title: 'RC-000042', createdAt: new Date('2027-01-05T09:30:00Z') },
        (page) =>
          drawCertificate(
            page,
            receiptContent('كمبوند الياسمين — Al Yasmin Compound', {
              receiptNumber: 'RC-000042',
              receiptCode: 'K7P2x9QX4mN8bV3cZ1aLqw',
              receiptUrl:
                'https://app.jiwar.example/receipt#K7P2x9QX4mN8bV3cZ1aLqw',
              unitCode: 'B-12',
              building: '3',
              method: 'bank_transfer',
              amount: '1250.00',
              paidOn: '2027-01-05',
              invoiceNumbers: ['INV-000101', 'INV-000102'],
              reversed: false,
            }),
          ),
      ),
    );
    const text = execFileSync('pdftotext', ['-raw', pdf, '-'], {
      encoding: 'utf8',
    });
    for (const s of [
      'RC-000042',
      '1,250.00 EGP',
      'B-12',
      'INV-000101',
      '2027-01-05',
    ])
      expect(text).toContain(s);
    expect(text).not.toContain('00.052,1');
    execFileSync('pdftoppm', [
      '-r',
      '110',
      '-png',
      '-singlefile',
      pdf,
      join(dir, 'page'),
    ]);
    const png = readFileSync(join(dir, 'page.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    if (process.env.PDF_RECEIPT_PNG)
      copyFileSync(join(dir, 'page.png'), process.env.PDF_RECEIPT_PNG);
  });
});

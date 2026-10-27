import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { drawCertificate } from '../../src/core/pdf/certificate';
import {
  SAMPLE,
  SAMPLE_CREATED_AT,
} from '../../src/core/pdf/certificate.fixtures';
import { PdfRenderer } from '../../src/core/pdf/pdf-renderer';

// The Arabic proof (ADR 0062): a bilingual certificate with Arabic names,
// numbers and mixed text, drawn, then rasterised with poppler (pdftoppm,
// pdftotext, pdffonts must be installed) for a person to look at. Run with
// `pnpm test:pdf-sample`; PDF_SAMPLE_PNG=<path> also copies the page there.

describe('certificate PDF sample', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwar-pdf-'));
  const renderer = new PdfRenderer();
  const draw = () =>
    renderer.render(
      { title: SAMPLE.number, createdAt: SAMPLE_CREATED_AT },
      (page) => drawCertificate(page, SAMPLE),
    );

  it('is the same bytes for the same record', async () => {
    const [a, b] = await Promise.all([draw(), draw()]);
    expect(createHash('sha256').update(a).digest('hex')).toBe(
      createHash('sha256').update(b).digest('hex'),
    );
  });

  it('embeds both faces, keeps the numbers in order, and rasterises', async () => {
    const pdf = join(dir, 'certificate.pdf');
    writeFileSync(pdf, await draw());

    const fonts = execFileSync('pdffonts', [pdf], { encoding: 'utf8' });
    expect(fonts).toMatch(/NotoNaskhArabic-Bold/);
    expect(fonts).toMatch(/NotoNaskhArabic-Regular/);
    expect(fonts).toMatch(/NotoSans-Regular/);

    // Each Latin or digit run is drawn whole, left to right.
    const text = execFileSync('pdftotext', ['-raw', pdf, '-'], {
      encoding: 'utf8',
    });
    for (const s of [
      'CL-000123',
      '1,250.00',
      'B-12',
      '2026-10-27',
      'K7P2-9QX4',
      'Ahmed Mohamed El-Sayed',
      '0.00 EGP',
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain('00.052,1');
    expect(text).not.toContain('21-B');

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
    if (process.env.PDF_SAMPLE_PNG)
      copyFileSync(join(dir, 'page.png'), process.env.PDF_SAMPLE_PNG);
  });
});

import { createHash } from 'node:crypto';
import { drawCertificate } from './certificate';
import { SAMPLE, SAMPLE_CREATED_AT } from './certificate.fixtures';
import { PdfRenderer } from './pdf-renderer';

/**
 * A template version, once a record names it, is never edited: the same
 * record must draw the same document for as long as it is kept. A changed
 * hash means the template, the renderer or pdfkit changed. Check the
 * rasterised sample (`pnpm test:pdf-sample`); if the page is unchanged to
 * the eye, pin the new hash; if not, the change is a new template version.
 */
const PINNED: Record<string, string> = {
  'certificate.v2':
    '471d50ab0b7b04c5eb6073cb8a79e0d672575235626ee185cd20acdae97cd280',
};

describe('certificate templates', () => {
  it.each(Object.keys(PINNED))(
    '%s draws the pinned bytes',
    async (template) => {
      const pdf = await new PdfRenderer().render(
        { title: SAMPLE.number, createdAt: SAMPLE_CREATED_AT },
        (page) =>
          drawCertificate(page, {
            ...SAMPLE,
            template: template as typeof SAMPLE.template,
          }),
      );
      expect(createHash('sha256').update(pdf).digest('hex')).toBe(
        PINNED[template],
      );
    },
  );
});

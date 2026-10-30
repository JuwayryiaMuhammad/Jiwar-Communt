import { Prisma } from '@prisma/client';
import { pairLines, type ComparedLine } from './fee-rules';

const line = (
  position: number,
  text: string,
  amount: string,
): ComparedLine => ({
  position,
  descriptionEn: text,
  descriptionAr: text,
  amount: new Prisma.Decimal(amount),
});
const shape = (pairs: ReturnType<typeof pairLines>) =>
  pairs.map((p) => [
    p.current?.descriptionEn ?? null,
    p.previous?.descriptionEn ?? null,
    p.change,
  ]);

describe('an invoice’s lines against the one before (ADR 0069)', () => {
  it('a plan’s invoices pair by position, whatever the period in the text', () => {
    expect(
      shape(
        pairLines(
          [line(1, 'Service — 2027-02', '600.00')],
          [line(1, 'Service — 2027-01', '500.00')],
          true,
        ),
      ),
    ).toEqual([['Service — 2027-02', 'Service — 2027-01', 'changed']]);
  });

  it('other invoices pair by text, each line once; the rest are added or removed', () => {
    expect(
      shape(
        pairLines(
          [
            line(1, 'Water', '80.00'),
            line(2, 'Water', '80.00'),
            line(3, 'Lift repair', '300.00'),
          ],
          [line(1, 'Water', '80.00'), line(2, 'Security', '50.00')],
          false,
        ),
      ),
    ).toEqual([
      ['Water', 'Water', 'same'],
      ['Water', null, 'added'],
      ['Lift repair', null, 'added'],
      [null, 'Security', 'removed'],
    ]);
  });
});

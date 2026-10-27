import { directionOf, visualPieces, wrapLines } from './bidi-text';

/** The words of a line left to right, spaces dropped, with their face. */
const texts = (p: string, base: 'ltr' | 'rtl') =>
  visualPieces(p, base)
    .filter((r) => !r.space)
    .map((r) => [r.text, r.script]);

describe('visualPieces', () => {
  it('keeps digits and Latin left to right inside an Arabic line', () => {
    // Read right to left: الوحدة, B-12, رقم, 345.
    expect(texts('الوحدة B-12 رقم 345', 'rtl')).toEqual([
      ['345', 'latin'],
      ['رقم', 'arabic'],
      ['B-12', 'latin'],
      ['الوحدة', 'arabic'],
    ]);
  });

  it('hands each Arabic word over alone, in logical order (fontkit reverses and shapes it)', () => {
    expect(texts('أحمد محمد السيد', 'rtl')).toEqual([
      ['السيد', 'arabic'],
      ['محمد', 'arabic'],
      ['أحمد', 'arabic'],
    ]);
    expect(visualPieces('أحمد محمد', 'rtl').map((p) => p.space)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('sets brackets and dashes in the Latin face, mirrored on a right-to-left stretch', () => {
    expect(texts('0.00 جنيه (EGP)', 'rtl')).toEqual([
      ['(', 'latin'],
      ['EGP', 'latin'],
      [')', 'latin'],
      ['جنيه', 'arabic'],
      ['0.00', 'latin'],
    ]);
    expect(texts('كمبوند الياسمين — Al Yasmin', 'rtl')).toEqual([
      ['Al', 'latin'],
      ['Yasmin', 'latin'],
      ['—', 'latin'],
      ['الياسمين', 'arabic'],
      ['كمبوند', 'arabic'],
    ]);
  });

  it('keeps an amount whole, separators included', () => {
    expect(texts('المبلغ 1,250.00 جنيه', 'rtl')).toEqual([
      ['جنيه', 'arabic'],
      ['1,250.00', 'latin'],
      ['المبلغ', 'arabic'],
    ]);
  });

  it('places an Arabic name inside an English sentence', () => {
    expect(texts('Issued to أحمد السيد on 2026-10-27', 'ltr')).toEqual([
      ['Issued', 'latin'],
      ['to', 'latin'],
      ['السيد', 'arabic'],
      ['أحمد', 'arabic'],
      ['on', 'latin'],
      ['2026-10-27', 'latin'],
    ]);
  });

  it('reorders each wrapped line on its own', () => {
    const p = 'الوحدة B-12 رقم 345';
    // The second line holds "رقم 345" only.
    const start = p.indexOf('رقم');
    expect(
      visualPieces(p, 'rtl', start, p.length - 1)
        .filter((r) => !r.space)
        .map((r) => r.text),
    ).toEqual(['345', 'رقم']);
  });
});

describe('directionOf', () => {
  it('follows the first strong letter', () => {
    expect(directionOf('123 أحمد', 'ltr')).toBe('rtl');
    expect(directionOf('B-12 الوحدة', 'rtl')).toBe('ltr');
    expect(directionOf('2026-10-27', 'rtl')).toBe('rtl');
  });
});

describe('wrapLines', () => {
  const measure = (t: string) => t.length;
  it('breaks by words and drops the trailing spaces', () => {
    expect(wrapLines('aaa bbb ccc', 7, measure)).toEqual([
      [0, 6],
      [8, 10],
    ]);
  });
  it('lets a word wider than the line stand alone', () => {
    expect(wrapLines('a bbbbbbbbbb c', 5, measure)).toEqual([
      [0, 0],
      [2, 11],
      [13, 13],
    ]);
  });
});

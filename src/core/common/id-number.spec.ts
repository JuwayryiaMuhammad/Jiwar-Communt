import { normalizeIdNumber } from './id-number';

describe('normalizeIdNumber (ADR 0053)', () => {
  it('folds how a number is typed into one string', () => {
    const one = '29001011234567';
    for (const typed of [
      '29001011234567',
      ' 2900101 1234567 ',
      '2900-101-1234567',
      '٢٩٠٠١٠١١٢٣٤٥٦٧',
      '۲۹۰۰۱۰۱۱۲۳۴۵۶۷',
    ])
      expect(normalizeIdNumber(typed)).toBe(one);
    expect(normalizeIdNumber('a12345678')).toBe('A12345678');
  });

  it('refuses what is not 4 to 20 letters and digits', () => {
    for (const typed of ['', '123', 'ABC_123', 'أحمد1234', '1'.repeat(21)])
      expect(normalizeIdNumber(typed)).toBeNull();
  });
});

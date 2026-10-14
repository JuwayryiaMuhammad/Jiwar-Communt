import { normalizePlate } from './vehicle-plate';

describe('normalizePlate', () => {
  it('keeps Arabic and Latin plates, tidied', () => {
    expect(normalizePlate(' ق  ب ط   ١٢٣٤ ')).toBe('ق ب ط ١٢٣٤');
    expect(normalizePlate('abc 1234')).toBe('ABC 1234');
    expect(normalizePlate('أ ب 123')).toBe('أ ب 123');
    expect(normalizePlate('123456789012')).toBe('123456789012');
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      '   ',
      '1234567890123',
      'ABC-123',
      'ق.ب 12',
      'ـــ',
      'АВС 123', // Cyrillic look-alikes
      '۱۲۳', // Persian digits
    ])
      expect(normalizePlate(bad)).toBeNull();
  });
});

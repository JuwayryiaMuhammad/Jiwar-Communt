import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizePlate,
  PLATE_FOLD_FROM,
  PLATE_FOLD_TO,
  plateKey,
} from './vehicle-plate';

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

describe('plateKey', () => {
  it('drops the spaces and reads Arabic-Indic digits as Western ones', () => {
    expect(plateKey('ق ب ط ١٢٣٤')).toBe('قبط1234');
    expect(plateKey('قبط1234')).toBe('قبط1234');
    expect(plateKey('ABC 1234')).toBe('ABC1234');
    expect(plateKey('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('folds the Arabic letter variants: أ/إ/آ as ا, ى as ي, ة as ه', () => {
    expect(plateKey('أ ب 1')).toBe('اب1');
    expect(plateKey('إ 1')).toBe(plateKey('ا 1'));
    expect(plateKey('آ 1')).toBe(plateKey('ا 1'));
    expect(plateKey('ى 1')).toBe(plateKey('ي 1'));
    expect(plateKey('ة 1')).toBe(plateKey('ه 1'));
    // Nothing else is folded.
    expect(plateKey('ب 1')).not.toBe(plateKey('ت 1'));
  });

  it('maps character for character, as translate() does', () => {
    expect([...PLATE_FOLD_FROM]).toHaveLength([...PLATE_FOLD_TO].length);
    expect(new Set(PLATE_FOLD_FROM).size).toBe([...PLATE_FOLD_FROM].length);
    [...PLATE_FOLD_FROM].forEach((ch, i) =>
      expect(plateKey(ch)).toBe([...PLATE_FOLD_TO][i]),
    );
  });

  it('is the expression of the generated plate_key columns', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261025090000_plate_key_fold/migration.sql',
      ),
      'utf8',
    );
    // The pre-check and the four columns, with no other fold anywhere.
    const fold = `'${PLATE_FOLD_FROM}', '${PLATE_FOLD_TO}'`;
    expect(sql.split(fold).length - 1).toBe(5);
    expect(sql.match(/translate\(/g)).toHaveLength(5);
  });
});

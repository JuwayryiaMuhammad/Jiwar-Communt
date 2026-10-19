import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME_FOLD_FROM, NAME_FOLD_TO, nameKey } from './visitor-name';

const migration = readFileSync(
  join(
    __dirname,
    '../../..',
    'prisma/migrations/20261104090900_visitor_name_key/migration.sql',
  ),
  'utf8',
);

describe('a visitor’s name key (ADR 0056)', () => {
  it('is what the database generates: the same folds, the same spaces', () => {
    expect(migration).toContain(
      `translate("full_name", '${NAME_FOLD_FROM}', '${NAME_FOLD_TO}')`,
    );
    expect(migration).toContain(`'[ \\t\\r\\n]+', ' ', 'g'`);
    expect(migration).toContain('btrim(');
  });

  it('folds case, Arabic letters, vowels, tatweel and spaces; nothing else', () => {
    expect(nameKey('  Mona   ADEL ')).toBe('mona adel');
    expect(nameKey('أحمد  عليّ')).toBe(nameKey('احمد علي'));
    expect(nameKey('فاطمة')).toBe('فاطمه');
    expect(nameKey('مُصْطَفـى')).toBe('مصطفي');
    expect(nameKey('Mona\tAdel\n')).toBe('mona adel');
    // Exactly the name: never a part of it, never a likeness.
    expect(nameKey('Mona')).not.toBe(nameKey('Mona Adel'));
    expect(nameKey('Muna Adel')).not.toBe(nameKey('Mona Adel'));
    // Latin letters past A to Z are left as they are.
    expect(nameKey('ÉLISE')).toBe('Élise');
  });

  it('is null when nothing is left', () => {
    expect(nameKey('   ')).toBeNull();
    expect(nameKey('ـ')).toBeNull();
  });
});

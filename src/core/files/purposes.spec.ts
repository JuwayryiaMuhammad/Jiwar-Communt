import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_PURPOSES, FILE_TYPES } from './purposes';
import { matchesSignature } from './signatures';

const migrations = '../../../prisma/migrations';
const migration = readFileSync(
  join(__dirname, migrations, '20261005090000_files/migration.sql'),
  'utf8',
);
/** The size CHECK as it stands now (ADR 0032 recreated it). */
const sizeCheck = readFileSync(
  join(__dirname, migrations, '20261007090100_maintenance/migration.sql'),
  'utf8',
);

describe('file purposes', () => {
  it('match the CHECKs in the database', () => {
    // files_size_for_purpose
    expect(sizeCheck).toContain(
      `WHEN 'worker_photo' THEN ${FILE_PURPOSES.worker_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'resident_photo' THEN ${FILE_PURPOSES.resident_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'ticket_photo' THEN ${FILE_PURPOSES.ticket_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(`ELSE ${FILE_PURPOSES.document.maxBytes} END`);
    // files_content_type_for_purpose: images for every purpose, a PDF only
    // as a document.
    expect(FILE_PURPOSES.worker_photo.types).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(FILE_PURPOSES.resident_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.ticket_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.document.types).toEqual(FILE_TYPES);
    expect(migration).toContain(
      `"content_type" IN ('image/jpeg', 'image/png', 'image/webp')`,
    );
    expect(migration).toContain(
      `("content_type" = 'application/pdf' AND "purpose" = 'document')`,
    );
  });

  it('only the four types', () => {
    expect([...FILE_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });
});

describe('matchesSignature', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([1, 2, 3, 4]),
    Buffer.from('WEBPVP8 '),
  ]);
  const pdf = Buffer.from('%PDF-1.4\n');
  const samples = {
    'image/png': png,
    'image/jpeg': jpeg,
    'image/webp': webp,
    'application/pdf': pdf,
  } as const;

  it('accepts each type only with its own bytes', () => {
    for (const [type, bytes] of Object.entries(samples)) {
      for (const [other, otherBytes] of Object.entries(samples)) {
        expect(matchesSignature(type as keyof typeof samples, otherBytes)).toBe(
          type === other,
        );
      }
      void bytes;
    }
  });

  it('refuses short or empty files and a RIFF that is not WebP', () => {
    expect(matchesSignature('image/png', png.subarray(0, 7))).toBe(false);
    expect(matchesSignature('application/pdf', Buffer.alloc(0))).toBe(false);
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from('WAVEfmt '),
    ]);
    expect(matchesSignature('image/webp', wav)).toBe(false);
  });
});

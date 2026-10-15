import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_PURPOSES, FILE_TYPES } from './purposes';
import { matchesSignature } from './signatures';

const migrations = '../../../prisma/migrations';
/** Both CHECKs as they stand now (ADR 0045 recreated them). */
const sizeCheck = readFileSync(
  join(
    __dirname,
    migrations,
    '20261023090200_vehicle_file_purposes/migration.sql',
  ),
  'utf8',
);
const typeCheck = sizeCheck;

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
    expect(sizeCheck).toContain(
      `WHEN 'parcel_photo' THEN ${FILE_PURPOSES.parcel_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'neighbour_post_photo' THEN ${FILE_PURPOSES.neighbour_post_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'gate_request_photo' THEN ${FILE_PURPOSES.gate_request_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'parking_photo' THEN ${FILE_PURPOSES.parking_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'vehicle_fine_photo' THEN ${FILE_PURPOSES.vehicle_fine_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'data_export' THEN ${FILE_PURPOSES.data_export.maxBytes}`,
    );
    expect(sizeCheck).toContain(`ELSE ${FILE_PURPOSES.document.maxBytes} END`);
    // A purpose without its own WHEN takes the ELSE.
    expect(sizeCheck).not.toContain(`WHEN 'request_attachment'`);
    expect(FILE_PURPOSES.request_attachment.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(sizeCheck).not.toContain(`WHEN 'community_attachment'`);
    expect(FILE_PURPOSES.community_attachment.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(sizeCheck).not.toContain(`WHEN 'complaint_evidence'`);
    expect(FILE_PURPOSES.complaint_evidence.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(sizeCheck).not.toContain(`WHEN 'vehicle_licence'`);
    expect(FILE_PURPOSES.vehicle_licence.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    // files_content_type_for_purpose: images for every purpose, a PDF only
    // as a document, a request's attachment, a community attachment, a
    // complaint's evidence or a vehicle's licence.
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
    expect(FILE_PURPOSES.parcel_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.document.types).toEqual([
      ...FILE_PURPOSES.worker_photo.types,
      'application/pdf',
    ]);
    expect(FILE_PURPOSES.request_attachment.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(FILE_PURPOSES.community_attachment.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(FILE_PURPOSES.complaint_evidence.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(FILE_PURPOSES.neighbour_post_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.vehicle_licence.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(FILE_PURPOSES.parking_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.vehicle_fine_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.data_export.types).toEqual(['application/zip']);
    expect(typeCheck).toContain(
      `("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" <> 'data_export')`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence'))`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'application/zip' AND "purpose" = 'data_export')`,
    );
  });

  it('only the five types', () => {
    expect([...FILE_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/zip',
    ]);
  });

  it('nobody uploads an export', () => {
    expect(FILE_PURPOSES.data_export.uploaders).toEqual([]);
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
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]);
  const samples = {
    'image/png': png,
    'image/jpeg': jpeg,
    'image/webp': webp,
    'application/pdf': pdf,
    'application/zip': zip,
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

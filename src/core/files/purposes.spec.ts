import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_PURPOSES, FILE_TYPES, mediaOf } from './purposes';
import { matchesSignature } from './signatures';

const migrations = '../../../prisma/migrations';
/**
 * The size CHECK as it stands now: ADR 0086's, recreated after the
 * later-dated ADR 0087 and 0088 with every purpose.
 */
const both = readFileSync(
  join(__dirname, migrations, '20270611090400_reports_checks/migration.sql'),
  'utf8',
);
/** The size CHECK's statements alone. */
const sizeCheck = both.slice(
  both.indexOf('"files_size_for_purpose"'),
  both.indexOf('"files_content_type_for_purpose"'),
);
/**
 * The content type CHECK as it stands now: ADR 0090's, with the staff
 * certificate among the PDFs, to the end of its migration.
 */
const latest = readFileSync(
  join(
    __dirname,
    migrations,
    '20270614090500_field_team_b_checks/migration.sql',
  ),
  'utf8',
);
const typeCheck = latest.slice(
  latest.indexOf('"files_content_type_for_purpose"'),
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
      `WHEN 'gate_service_photo' THEN ${FILE_PURPOSES.gate_service_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'dispute_photo' THEN ${FILE_PURPOSES.dispute_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'contractor_photo' THEN ${FILE_PURPOSES.contractor_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'permit_photo' THEN ${FILE_PURPOSES.permit_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'guard_task_photo' THEN ${FILE_PURPOSES.guard_task_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'found_item_photo' THEN ${FILE_PURPOSES.found_item_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'patrol_photo' THEN ${FILE_PURPOSES.patrol_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'incident_photo' THEN ${FILE_PURPOSES.incident_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'blocklist_photo' THEN ${FILE_PURPOSES.blocklist_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'violation_photo' THEN ${FILE_PURPOSES.violation_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'violation_appeal_photo' THEN ${FILE_PURPOSES.violation_appeal_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'child_photo' THEN ${FILE_PURPOSES.child_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'child_escort_photo' THEN ${FILE_PURPOSES.child_escort_photo.maxBytes}`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'visitor_photo' THEN ${FILE_PURPOSES.visitor_photo.maxBytes}`,
    );
    for (const purpose of [
      'patrol_note_audio',
      'patrol_note_video',
      'incident_audio',
      'incident_video',
      'incident_signature',
    ] as const)
      expect(sizeCheck).toContain(
        `WHEN '${purpose}' THEN ${FILE_PURPOSES[purpose].maxBytes}`,
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
    for (const purpose of [
      'approval_attachment',
      'board_appeal_attachment',
      'expense_invoice',
      'decision_appeal_attachment',
      'registration_document',
      'kinship_proof',
      'unit_document',
      'contract',
    ] as const) {
      expect(sizeCheck).not.toContain(`WHEN '${purpose}'`);
      expect(FILE_PURPOSES[purpose].maxBytes).toBe(
        FILE_PURPOSES.document.maxBytes,
      );
      expect(FILE_PURPOSES[purpose].types).toEqual(
        FILE_PURPOSES.document.types,
      );
    }
    // A compound document's version (ADR 0062): a PDF only, 10 MB.
    expect(sizeCheck).not.toContain(`WHEN 'compound_document'`);
    expect(FILE_PURPOSES.compound_document.types).toEqual(['application/pdf']);
    // A works completion photo (ADR 0063): an image, the 10 MB default, so
    // neither CHECK names it.
    expect(sizeCheck).not.toContain(`WHEN 'works_inspection_photo'`);
    expect(typeCheck).not.toContain(`'works_inspection_photo'`);
    expect(FILE_PURPOSES.works_inspection_photo.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(FILE_PURPOSES.works_inspection_photo.types).not.toContain(
      'application/pdf',
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
    expect(FILE_PURPOSES.gate_service_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.dispute_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.contractor_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.permit_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.guard_task_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.found_item_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.patrol_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.incident_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.blocklist_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.violation_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.violation_appeal_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(FILE_PURPOSES.data_export.types).toEqual(['application/zip']);
    // Recordings (ADR 0056): the MP4 family, never an image.
    for (const purpose of ['patrol_note_audio', 'incident_audio'] as const)
      expect(FILE_PURPOSES[purpose].types).toEqual(['audio/mp4']);
    for (const purpose of ['patrol_note_video', 'incident_video'] as const)
      expect(FILE_PURPOSES[purpose].types).toEqual([
        'video/mp4',
        'video/quicktime',
      ]);
    // A signature (ADR 0056): a PNG only.
    expect(FILE_PURPOSES.incident_signature.types).toEqual(['image/png']);
    expect(typeCheck).toContain(
      `("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import', 'report_file', 'compound_export', 'compound_logo'))`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'image/png' AND "purpose" = 'incident_signature')`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))`,
    );
    expect(typeCheck).toContain(
      `("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document', 'vendor_document', 'permit_drawing', 'compliance_evidence', 'tender_document', 'tender_bid', 'report_file', 'staff_certificate'))`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'application/zip' AND "purpose" IN ('data_export', 'compound_export'))`,
    );
    // Assets (ADR 0064): a document is an image or a PDF like any other, a
    // checklist photo an image; a sheet is CSV and nothing else.
    expect(FILE_PURPOSES.asset_document.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'asset_document'`);
    expect(FILE_PURPOSES.asset_document.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    // Vendors (ADR 0077): a vendor's paper is a document like any other.
    expect(FILE_PURPOSES.vendor_document.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'vendor_document'`);
    expect(FILE_PURPOSES.vendor_document.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    // Compliance (ADR 0087): evidence is a document like any other.
    expect(FILE_PURPOSES.compliance_evidence.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'compliance_evidence'`);
    expect(FILE_PURPOSES.compliance_evidence.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    // Staff certificates (ADR 0090): a paper like any other, filed by the
    // field team.
    expect(FILE_PURPOSES.staff_certificate.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'staff_certificate'`);
    expect(FILE_PURPOSES.staff_certificate.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(FILE_PURPOSES.staff_certificate.uploaders).toEqual([
      'field_team.manage',
    ]);
    // Tenders (ADR 0088): a tender's document and a bid's offer are
    // documents like any other.
    for (const purpose of ['tender_document', 'tender_bid'] as const) {
      expect(FILE_PURPOSES[purpose].types).toEqual(
        FILE_PURPOSES.document.types,
      );
      expect(sizeCheck).not.toContain(`WHEN '${purpose}'`);
      expect(FILE_PURPOSES[purpose].maxBytes).toBe(
        FILE_PURPOSES.document.maxBytes,
      );
    }
    expect(FILE_PURPOSES.checklist_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(sizeCheck).toContain(
      `WHEN 'checklist_photo' THEN ${FILE_PURPOSES.checklist_photo.maxBytes}`,
    );
    expect(FILE_PURPOSES.data_import.types).toEqual(['text/csv']);
    expect(sizeCheck).toContain(
      `WHEN 'data_import' THEN ${FILE_PURPOSES.data_import.maxBytes}`,
    );
    expect(typeCheck).toContain(
      `("content_type" = 'text/csv' AND "purpose" IN ('data_import', 'report_file'))`,
    );
    // Reports (ADR 0086): a run's file is a PDF, a workbook or CSV of 20 MB;
    // the compound's export a zip as large as a personal one.
    expect(FILE_PURPOSES.report_file.types).toEqual([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ]);
    expect(typeCheck).toContain(
      `("content_type" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' AND "purpose" = 'report_file')`,
    );
    expect(sizeCheck).toContain(
      `WHEN 'report_file' THEN ${FILE_PURPOSES.report_file.maxBytes}`,
    );
    expect(FILE_PURPOSES.compound_export.types).toEqual(['application/zip']);
    expect(sizeCheck).toContain(
      `WHEN 'compound_export' THEN ${FILE_PURPOSES.compound_export.maxBytes}`,
    );
    // Guard vendors (ADR 0068): a face probe and an ID scan are images, 5 MB.
    for (const purpose of ['gate_face_probe', 'gate_id_scan'] as const) {
      expect(FILE_PURPOSES[purpose].types).toEqual(
        FILE_PURPOSES.worker_photo.types,
      );
      expect(sizeCheck).toContain(
        `WHEN '${purpose}' THEN ${FILE_PURPOSES[purpose].maxBytes}`,
      );
      expect(typeCheck).not.toContain(`'${purpose}'`);
    }
    // Community (ADR 0071): a listing's photo is a 5 MB image, a gallery
    // photo a 10 MB one (the ELSE).
    expect(FILE_PURPOSES.market_listing_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(sizeCheck).toContain(
      `WHEN 'market_listing_photo' THEN ${FILE_PURPOSES.market_listing_photo.maxBytes}`,
    );
    expect(FILE_PURPOSES.gallery_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'gallery_photo'`);
    expect(FILE_PURPOSES.gallery_photo.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    // Fit-out (ADR 0074): a drawing is an image or a PDF of 10 MB, the
    // management's photo a 10 MB image (both the ELSE), an appeal's photo a
    // 5 MB image.
    expect(FILE_PURPOSES.permit_drawing.types).toEqual(
      FILE_PURPOSES.document.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'permit_drawing'`);
    expect(FILE_PURPOSES.permit_drawing.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(FILE_PURPOSES.fitout_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(sizeCheck).not.toContain(`WHEN 'fitout_photo'`);
    expect(typeCheck).not.toContain(`'fitout_photo'`);
    expect(FILE_PURPOSES.fitout_photo.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(FILE_PURPOSES.damage_appeal_photo.types).toEqual(
      FILE_PURPOSES.worker_photo.types,
    );
    expect(sizeCheck).toContain(
      `WHEN 'damage_appeal_photo' THEN ${FILE_PURPOSES.damage_appeal_photo.maxBytes}`,
    );
    expect(typeCheck).not.toContain(`'damage_appeal_photo'`);
  });

  it('only the ten types', () => {
    expect([...FILE_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/zip',
      'audio/mp4',
      'video/mp4',
      'video/quicktime',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
  });

  it('a recording, and only a recording, has its duration read', () => {
    const media = Object.keys(FILE_PURPOSES).filter((p) =>
      mediaOf(p as keyof typeof FILE_PURPOSES),
    );
    expect(media.sort()).toEqual([
      'incident_audio',
      'incident_video',
      'patrol_note_audio',
      'patrol_note_video',
    ]);
  });

  it('nobody uploads an export or a report’s file', () => {
    expect(FILE_PURPOSES.data_export.uploaders).toEqual([]);
    expect(FILE_PURPOSES.compound_export.uploaders).toEqual([]);
    expect(FILE_PURPOSES.report_file.uploaders).toEqual([]);
  });

  it('a face probe and an ID scan are the guard’s alone (ADR 0068)', () => {
    expect(FILE_PURPOSES.gate_face_probe.uploaders).toEqual(['gate.operate']);
    expect(FILE_PURPOSES.gate_id_scan.uploaders).toEqual(['gate.operate']);
  });

  it('a listing’s photo is the seller’s, a gallery photo the staff’s (ADR 0071)', () => {
    expect(FILE_PURPOSES.market_listing_photo.uploaders).toEqual([
      'market.post',
    ]);
    expect(FILE_PURPOSES.gallery_photo.uploaders).toEqual(['content.manage']);
  });

  it('the site map and a floor plan are images of the 10 MB default, the spaces keeper’s (ADR 0084)', () => {
    for (const p of ['site_map', 'floor_plan'] as const) {
      expect(sizeCheck).not.toContain(`WHEN '${p}'`);
      expect(typeCheck).not.toContain(`'${p}'`);
      expect(FILE_PURPOSES[p].types).toEqual(FILE_PURPOSES.worker_photo.types);
      expect(FILE_PURPOSES[p].maxBytes).toBe(FILE_PURPOSES.document.maxBytes);
      expect(FILE_PURPOSES[p].uploaders).toEqual(['spaces.manage']);
    }
  });

  it('the compound’s logo is a PNG or a JPEG of the 10 MB default, the manager’s (ADR 0075)', () => {
    expect(FILE_PURPOSES.compound_logo.types).toEqual([
      'image/jpeg',
      'image/png',
    ]);
    expect(sizeCheck).not.toContain(`WHEN 'compound_logo'`);
    expect(FILE_PURPOSES.compound_logo.maxBytes).toBe(
      FILE_PURPOSES.document.maxBytes,
    );
    expect(typeCheck).toContain(
      `("content_type" IN ('image/jpeg', 'image/png') AND "purpose" = 'compound_logo')`,
    );
    expect(FILE_PURPOSES.compound_logo.uploaders).toEqual([
      'governance.manage',
    ]);
  });

  it('a sheet to import is uploaded by whoever keeps the register, the meters, the units or the treasury (ADR 0064, 0066, 0072, 0085)', () => {
    expect(FILE_PURPOSES.data_import.uploaders).toEqual([
      'assets.manage',
      'energy.manage',
      'units.manage',
      'finance.treasury',
    ]);
  });

  it('an incident’s photo is uploaded by a guard, the incidents’ keepers, or a technician from their ticket (ADR 0053, 0067)', () => {
    expect(FILE_PURPOSES.incident_photo.uploaders).toEqual([
      'gate.operate',
      'incidents.manage',
      'tickets.work',
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

  it('the MP4 family: a `ftyp` box first, QuickTime by its brand', () => {
    const ftyp = (brand: string) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftyp'),
        Buffer.from(brand, 'latin1'),
        Buffer.from([0, 0, 0, 0]),
      ]);
    for (const brand of ['isom', 'mp42', 'M4A '])
      for (const type of ['audio/mp4', 'video/mp4'] as const) {
        expect(matchesSignature(type, ftyp(brand))).toBe(true);
        expect(matchesSignature('video/quicktime', ftyp(brand))).toBe(false);
      }
    expect(matchesSignature('video/quicktime', ftyp('qt  '))).toBe(true);
    expect(matchesSignature('video/mp4', ftyp('qt  '))).toBe(false);
    // Not a container: a PNG, or `ftyp` too short to name its brand.
    expect(matchesSignature('video/mp4', png)).toBe(false);
    expect(matchesSignature('audio/mp4', ftyp('isom').subarray(0, 10))).toBe(
      false,
    );
  });

  it('a CSV: text bytes only, no NUL or control byte (ADR 0064)', () => {
    expect(
      matchesSignature('text/csv', Buffer.from('\uFEFFcode,name\r\n')),
    ).toBe(true);
    expect(matchesSignature('text/csv', Buffer.from('رمز,اسم\t\n'))).toBe(true);
    for (const binary of [png, jpeg, zip, Buffer.from([0x61, 0x00, 0x62])])
      expect(matchesSignature('text/csv', binary)).toBe(false);
    expect(matchesSignature('text/csv', Buffer.alloc(0))).toBe(false);
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

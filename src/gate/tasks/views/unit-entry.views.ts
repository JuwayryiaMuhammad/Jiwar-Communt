import { ApiProperty } from '@nestjs/swagger';
import { entryReference, type EntryRead } from '../unit-entry-rules';

export class UnitEntryPhotoView {
  @ApiProperty({ enum: ['before', 'after'] })
  stage: string;
  @ApiProperty({ type: String, description: 'Presigned: never cached.' })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

/**
 * An emergency entry into a unit (ADR 0083), as the unit's people read it:
 * when, why, what was found, the report and the photos — never the staff's
 * names.
 */
export class UnitEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'UE-000003' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, description: '`unitEntryReason`.' })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  recordedAt: Date;
  @ApiProperty({ enum: ['open', 'reported'] })
  status: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '`unitEntryOutcome`, once reported.',
  })
  outcome: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What staff found and did, once reported.',
  })
  reportNote: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reportedAt: Date | null;
  @ApiProperty({
    type: Number,
    description: 'Staff who went in besides the one who led it.',
  })
  witnessCount: number;
  @ApiProperty({ type: [UnitEntryPhotoView] })
  photos: UnitEntryPhotoView[];

  static from(r: EntryRead): UnitEntryView {
    const e = r.entry;
    return {
      id: e.id,
      reference: entryReference(e.number),
      unitId: e.unitId,
      unitCode: r.unitCode,
      reasonCode: e.reasonCode,
      enteredAt: e.enteredAt,
      recordedAt: e.recordedAt,
      status: e.status,
      outcome: e.outcome,
      reportNote: e.reportNote,
      reportedAt: e.reportedAt,
      witnessCount: r.witnessCount,
      photos: r.photos.map((p) => ({ ...p })),
    };
  }
}

/** An emergency entry as the staff read it: who led it and who went in. */
export class StaffUnitEntryView extends UnitEntryView {
  @ApiProperty({ type: String, format: 'uuid' })
  recordedById: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the account is erased.',
  })
  recordedByName: string | null;
  @ApiProperty({
    type: [String],
    description: 'The witnesses’ names, in id order; null once erased.',
  })
  witnessNames: (string | null)[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reportedById: string | null;

  static fromStaff(r: EntryRead): StaffUnitEntryView {
    return {
      ...UnitEntryView.from(r),
      recordedById: r.entry.recordedBy,
      recordedByName: r.recordedByName,
      witnessNames: r.witnessNames,
      reportedById: r.entry.reportedBy,
    };
  }
}

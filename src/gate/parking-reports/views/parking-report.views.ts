import { ApiProperty } from '@nestjs/swagger';
import { ParkingReportStatus, type ParkingReport } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { PERMIT_STATUSES, reference } from '../../vehicles/vehicle-rules';
import type { StaffReport } from '../parking-reports.service';

/**
 * A report as its reporter sees it (ADR 0045): what they wrote and whether
 * it is open. Never whom the plate matched, never the outcome.
 */
export class MyParkingReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'R-3917' })
  reference: string;
  @ApiProperty({ type: String })
  plate: string;
  @ApiProperty({ type: String })
  location: string;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({
    enum: ['open', 'closed'],
    description: 'Closed: the staff dealt with it, whatever they did.',
  })
  status: 'open' | 'closed';
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ParkingReport): MyParkingReportView {
    return {
      id: r.id,
      reference: reference('R', r.number),
      plate: r.plate,
      location: r.location,
      note: r.note,
      status: r.status === 'open' ? 'open' : 'closed',
      createdAt: r.createdAt,
    };
  }
}

export class ReportMatchView {
  @ApiProperty({ type: String, format: 'uuid' })
  vehicleId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: [...PERMIT_STATUSES], enumName: 'VehiclePermitStatus' })
  permitStatus: string;
}

/** A report for security: the reporter, the plate's matches, the outcome. */
export class StaffParkingReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'R-3917' })
  reference: string;
  @ApiProperty({
    type: AccountRefView,
    description:
      'Security always sees who reported; the reported unit never does.',
  })
  reporter: AccountRefView;
  @ApiProperty({ type: String })
  plate: string;
  @ApiProperty({ type: String })
  location: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the reporter was erased.',
  })
  note: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned URL, valid for minutes.',
  })
  photoUrl: string | null;
  @ApiProperty({ enum: ParkingReportStatus, enumName: 'ParkingReportStatus' })
  status: ParkingReportStatus;
  @ApiProperty({ type: String, nullable: true })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  fineId: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  handledBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  handledAt: Date | null;
  @ApiProperty({
    type: [ReportMatchView],
    description: 'The pending and active vehicles whose plate matches, by key.',
  })
  matches: ReportMatchView[];
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: StaffReport): StaffParkingReportView {
    const r = s.report;
    return {
      id: r.id,
      reference: reference('R', r.number),
      reporter: accountRef(s.reporter),
      plate: r.plate,
      location: r.location,
      note: r.note,
      photoUrl: s.photoUrl,
      status: r.status,
      closeReason: r.closeReason,
      fineId: r.fineId,
      handledBy: s.handledBy && accountRef(s.handledBy),
      handledAt: r.handledAt,
      matches: s.matches,
      createdAt: r.createdAt,
    };
  }
}

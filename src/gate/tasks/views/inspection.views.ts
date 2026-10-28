import { ApiProperty } from '@nestjs/swagger';
import type {
  InspectionReport,
  InspectionRequestRead,
} from '../inspection-requests.service';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A request for a closed unit's inspection (ADR 0063). */
export class InspectionRequestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: '`IR-` and the number.' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, format: 'date' })
  preferredOn: string;
  @ApiProperty({ enum: ['open', 'scheduled', 'done', 'cancelled'] })
  status: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  doneAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'not_needed | unit_reopened | other | task_cancelled',
  })
  cancelReason: string | null;

  static from(r: InspectionRequestRead): InspectionRequestView {
    return { ...r, preferredOn: day(r.preferredOn) };
  }
}

export class StaffInspectionRequestView extends InspectionRequestView {
  @ApiProperty({ type: String })
  unitCode: string;

  static fromStaff(
    r: InspectionRequestRead & { unitCode: string },
  ): StaffInspectionRequestView {
    return { ...InspectionRequestView.from(r), unitCode: r.unitCode };
  }
}

export class InspectionPhotoView {
  @ApiProperty({ type: String, description: 'Presigned; short-lived.' })
  url: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

/** A closed unit's inspection, done: never the guard's name. */
export class UnitInspectionReportView {
  @ApiProperty({ type: String, format: 'uuid' })
  taskId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  doneAt: Date;
  @ApiProperty({ enum: ['all_clear', 'issue_found'] })
  outcome: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The guard’s note, until it is cleared.',
  })
  note: string | null;
  @ApiProperty({ type: [InspectionPhotoView] })
  photos: InspectionPhotoView[];

  static from(r: InspectionReport): UnitInspectionReportView {
    return { ...r };
  }
}

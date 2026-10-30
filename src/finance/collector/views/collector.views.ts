import { ApiProperty } from '@nestjs/swagger';
import { REASON_CODES } from '../../../core/common/reasons';
import { COLLECTOR_VISIT_STATUSES } from '../collector-visits.service';

/**
 * A collector's visit (ADR 0069): the unit, its building, the window, the
 * amount expected and where it stands. Never a phone, a name or a balance
 * — the same to the resident, the staff and the collector.
 */
export class CollectorVisitView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  windowStartsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  windowEndsAt: Date;
  @ApiProperty({ type: String, nullable: true })
  expectedAmount: string | null;
  @ApiProperty({
    enum: COLLECTOR_VISIT_STATUSES,
    enumName: 'CollectorVisitStatus',
  })
  status: string;
  @ApiProperty({
    type: Boolean,
    description: 'A collector is assigned; never who, to the resident.',
  })
  assigned: boolean;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The payment it took: its receipt.',
  })
  paymentId: string | null;
  @ApiProperty({
    enum: REASON_CODES.collectorVisitFail,
    enumName: 'CollectorVisitFailReason',
    nullable: true,
  })
  failReason: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Another window the collector offered: take it as a new visit.',
  })
  offeredStartsAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  offeredEndsAt: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The failed visit whose offer it took.',
  })
  followsId: string | null;
  @ApiProperty({ type: String, enum: ['resident', 'staff'], nullable: true })
  cancelSide: string | null;
  @ApiProperty({
    enum: REASON_CODES.collectorVisitCancel,
    enumName: 'CollectorVisitCancelReason',
    nullable: true,
  })
  cancelReason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
}

/** Someone who may be given a visit: a staff account, to the staff. */
export class CollectorView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

export class CollectorSettingsView {
  @ApiProperty({ type: String })
  collectorMargin: string;
}
